/** ACP Agent implementation backed directly by the process-local OpenClaw runtime. */
import { randomUUID } from "node:crypto";
import os from "node:os";
import type {
  Agent,
  AgentSideConnection,
  AuthenticateRequest,
  AuthenticateResponse,
  CancelNotification,
  CloseSessionRequest,
  CloseSessionResponse,
  InitializeRequest,
  InitializeResponse,
  ListSessionsRequest,
  ListSessionsResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  ResumeSessionRequest,
  ResumeSessionResponse,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
  SetSessionModeRequest,
  SetSessionModeResponse,
  StopReason,
  ToolCallLocation,
  ToolKind,
} from "@agentclientprotocol/sdk";
import { readBool, readNonNegativeInteger, readString } from "@openclaw/acp-core/meta";
import { defaultAcpSessionStore, type AcpSessionStore } from "@openclaw/acp-core/session";
import type {
  AcpServerOptions,
  AcpSession,
  AcpSessionRuntimeOptions,
} from "@openclaw/acp-core/types";
import { normalizeFastMode } from "@openclaw/normalization-core/string-coerce";
import { agentCommandFromIngress } from "../agents/agent-command.js";
import type { AgentRunApprovalHost } from "../agents/agent-run-approval.js";
import { LocalAgentHost } from "../agents/local-agent-host.js";
import type { AgentEventPayload } from "../infra/agent-events.js";
import {
  createFixedWindowRateLimiter,
  resolveFixedWindowRateLimitInteger,
  type FixedWindowRateLimiter,
} from "../infra/fixed-window-rate-limit.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveAssistantEventPhase } from "../shared/chat-message-content.js";
import { shortenHomePath } from "../utils.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel.js";
import { createAcpApprovalHost } from "./approval-host.js";
import { getAvailableCommands } from "./commands.js";
import {
  createInMemoryAcpEventLedger,
  type AcpEventLedger,
  type AcpEventLedgerReplay,
} from "./event-ledger.js";
import {
  extractAttachmentsFromPrompt,
  extractTextFromPrompt,
  extractToolCallContent,
  extractToolCallLocations,
  formatToolTitle,
  inferToolKind,
} from "./event-mapper.js";
import {
  createAcpLocalSessionRuntime,
  type AcpLocalSessionPatch,
  type AcpLocalSessionRuntime,
} from "./local-session-runtime.js";
import { parseSessionMeta } from "./session-mapper.js";
import {
  ACP_ELEVATED_LEVEL_CONFIG_ID,
  ACP_FAST_MODE_CONFIG_ID,
  ACP_REASONING_LEVEL_CONFIG_ID,
  ACP_RESPONSE_USAGE_CONFIG_ID,
  ACP_THOUGHT_LEVEL_CONFIG_ID,
  ACP_TIMEOUT_CONFIG_ID,
  ACP_TIMEOUT_SECONDS_CONFIG_ID,
  ACP_TRACE_LEVEL_CONFIG_ID,
  ACP_VERBOSE_LEVEL_CONFIG_ID,
  type AcpSessionPresentationRow,
  type SessionSnapshot,
} from "./translator.presentation.js";
import { extractReplayChunks, type AcpTranscriptMessage } from "./translator.replay.js";
import {
  assertAbsoluteCwd,
  decodeListSessionsCursor,
  encodeListSessionsCursor,
  resolveListSessionsPageSize,
} from "./translator.session-list.js";
import { AcpTranslatorSessionUpdates } from "./translator.session-updates.js";
import { ACP_AGENT_INFO } from "./types.js";

const MAX_PROMPT_BYTES = 2 * 1024 * 1024;
const SESSION_CREATE_RATE_LIMIT_DEFAULT_MAX_REQUESTS = 120;
const SESSION_CREATE_RATE_LIMIT_DEFAULT_WINDOW_MS = 60_000;

const silentRuntime: RuntimeEnv = {
  log: () => {},
  error: () => {},
  exit: (code: number) => {
    throw new Error(`unexpected agent runtime exit ${code}`);
  },
};

type AgentExecutor = typeof agentCommandFromIngress;
type AgentResult = Awaited<ReturnType<AgentExecutor>>;

export type AcpAgentOptions = AcpServerOptions & {
  eventLedger?: AcpEventLedger;
  sessionStore?: AcpSessionStore;
  sessionRuntime?: AcpLocalSessionRuntime;
  executeAgent?: AgentExecutor;
};

type AcpTurnState = {
  sessionId: string;
  sessionKey: string;
  ledgerSessionId?: string;
  sentText: string;
  sentThought: string;
  toolCalls: Map<
    string,
    {
      title: string;
      kind: ToolKind;
      rawInput?: Record<string, unknown>;
      locations?: ToolCallLocation[];
    }
  >;
  eventTail: Promise<void>;
  projectionError?: unknown;
  lifecycleStopReason?: string;
  lifecycleAborted: boolean;
  runtimeOptions: AcpSessionRuntimeOptions;
};

function getSessionRuntimeOptions(session: AcpSession): AcpSessionRuntimeOptions {
  return session.runtimeOptions ?? {};
}

function payloadText(parts: unknown): string {
  if (!Array.isArray(parts)) {
    return "";
  }
  return parts
    .map((part) => {
      if (!part || typeof part !== "object") {
        return "";
      }
      const text = (part as { text?: unknown }).text;
      return typeof text === "string" ? text : "";
    })
    .filter((text) => text.length > 0)
    .join("\n\n");
}

function normalizeStopReason(value: unknown): StopReason {
  if (
    value === "max_tokens" ||
    value === "max_turn_requests" ||
    value === "refusal" ||
    value === "cancelled"
  ) {
    return value;
  }
  return "end_turn";
}

function appendAssistantText(params: { previous: string; text?: unknown; delta?: unknown }): {
  full: string;
  chunk: string;
} {
  const text = typeof params.text === "string" ? params.text : "";
  const delta = typeof params.delta === "string" ? params.delta : "";
  if (text) {
    if (text === params.previous || params.previous.startsWith(text)) {
      return { full: params.previous, chunk: "" };
    }
    if (text.startsWith(params.previous)) {
      return { full: text, chunk: text.slice(params.previous.length) };
    }
  }
  if (delta) {
    return { full: `${params.previous}${delta}`, chunk: delta };
  }
  return text ? { full: text, chunk: text } : { full: params.previous, chunk: "" };
}

function timeoutSeconds(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return String(Math.ceil(value));
}

function buildSystemProvenanceReceipt(params: {
  cwd: string;
  sessionId: string;
  sessionKey: string;
}): string {
  return [
    "[Source Receipt]",
    "adapter=openclaw-acp",
    `originHost=${os.hostname()}`,
    `originCwd=${shortenHomePath(params.cwd)}`,
    `acpSessionId=${params.sessionId}`,
    `targetSession=${params.sessionKey}`,
    "[/Source Receipt]",
  ].join("\n");
}

function presentationOverrides(
  runtimeOptions: AcpSessionRuntimeOptions,
): Partial<AcpSessionPresentationRow> {
  const fastMode = normalizeFastMode(runtimeOptions.backendExtras?.fastMode);
  return {
    thinkingLevel: runtimeOptions.thinking,
    fastMode,
    effectiveFastMode: fastMode,
    verboseLevel: runtimeOptions.backendExtras?.verbose,
    timeoutSeconds: runtimeOptions.timeoutSeconds,
  };
}

function mergeSessionRuntimeOptions(
  current: AcpSessionRuntimeOptions,
  patch: Partial<AcpSessionRuntimeOptions>,
): AcpSessionRuntimeOptions {
  const next: AcpSessionRuntimeOptions = {
    ...current,
    ...structuredClone(patch),
  };
  if (patch.backendExtras) {
    next.backendExtras = {
      ...current.backendExtras,
      ...patch.backendExtras,
    };
  }
  if ("timeoutSeconds" in patch && patch.timeoutSeconds === undefined) {
    delete next.timeoutSeconds;
  }
  return next;
}

/** Process-local ACP adapter. LocalAgentHost is the sole owner of active runs. */
export class AcpAgent implements Agent {
  private readonly log: (message: string) => void;
  private readonly sessionStore: AcpSessionStore;
  private readonly sessionRuntime: AcpLocalSessionRuntime;
  private readonly sessionUpdates: AcpTranslatorSessionUpdates;
  private readonly sessionCreateRateLimiter: FixedWindowRateLimiter;
  private readonly executeAgent: AgentExecutor;
  private readonly localAgentHost = new LocalAgentHost<AcpTurnState, PromptResponse>();
  private readonly promptCompletions = new Map<Promise<PromptResponse>, string>();
  private readonly promptGenerations = new Map<string, number>();
  private readonly reconfiguringSessions = new Set<string>();
  private readonly sessionMutationTails = new Map<string, Promise<void>>();
  private readonly canonicalSessionMutationTails = new Map<string, Promise<void>>();
  private stopped = false;

  constructor(
    private readonly connection: AgentSideConnection,
    private readonly opts: AcpAgentOptions = {},
  ) {
    this.log = opts.verbose ? (message) => process.stderr.write(`[acp] ${message}\n`) : () => {};
    this.sessionStore = opts.sessionStore ?? defaultAcpSessionStore;
    this.sessionRuntime = opts.sessionRuntime ?? createAcpLocalSessionRuntime(opts);
    this.executeAgent = opts.executeAgent ?? agentCommandFromIngress;
    this.sessionUpdates = new AcpTranslatorSessionUpdates({
      connection,
      eventLedger: opts.eventLedger ?? createInMemoryAcpEventLedger(),
      getAvailableCommands: async () => getAvailableCommands(),
      log: this.log,
    });
    this.sessionCreateRateLimiter = createFixedWindowRateLimiter({
      maxRequests: resolveFixedWindowRateLimitInteger(
        opts.sessionCreateRateLimit?.maxRequests,
        SESSION_CREATE_RATE_LIMIT_DEFAULT_MAX_REQUESTS,
        { min: 1 },
      ),
      windowMs: resolveFixedWindowRateLimitInteger(
        opts.sessionCreateRateLimit?.windowMs,
        SESSION_CREATE_RATE_LIMIT_DEFAULT_WINDOW_MS,
        { min: 1_000 },
      ),
    });
  }

  start(): void {
    this.log("ready");
  }

  async shutdown(reason: unknown = new Error("ACP runtime stopped")): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    const turns = this.localAgentHost.seal();
    for (const turn of turns) {
      turn.cancel(reason);
    }
    await Promise.allSettled(turns.map((turn) => turn.result));
    await Promise.allSettled(turns.map((turn) => turn.adapterState.eventTail));
    await Promise.allSettled([...this.promptCompletions.keys()]);
    await Promise.allSettled([...this.sessionMutationTails.values()]);
    await Promise.allSettled([...this.canonicalSessionMutationTails.values()]);
    this.promptGenerations.clear();
    this.reconfiguringSessions.clear();
    this.sessionUpdates.stop();
  }

  activeRunCount(): number {
    return this.localAgentHost.list().length;
  }

  async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
    const { PROTOCOL_VERSION } = await import("@agentclientprotocol/sdk");
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: {
          image: true,
          audio: false,
          embeddedContext: true,
        },
        mcpCapabilities: {
          http: false,
          sse: false,
        },
        sessionCapabilities: {
          list: {},
          resume: {},
          close: {},
        },
      },
      agentInfo: ACP_AGENT_INFO,
      authMethods: [],
    };
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    this.assertRunning();
    this.assertSupportedSessionSetup(params.mcpServers);
    assertAbsoluteCwd(params.cwd, "session/new");
    const sessionId = randomUUID();
    const meta = parseSessionMeta(params["_meta"]);
    return await this.withSessionMutation(sessionId, async () => {
      this.enforceSessionCreateRateLimit("newSession");
      const sessionKey = await this.sessionRuntime.resolveSessionKey({
        meta,
        fallbackKey: sessionId,
      });
      const resetRequested = meta.resetSession ?? this.opts.resetSession ?? false;
      return await this.withCanonicalSessionLifecycle(sessionKey, resetRequested, async () => {
        const session = this.sessionStore.createSession({
          sessionId,
          sessionKey,
          cwd: params.cwd,
          protectedSessionIds: this.activePromptSessionIds(),
        });
        let resetCommitted = false;
        try {
          await this.sessionRuntime.resetSessionIfNeeded({ meta, sessionKey, cwd: params.cwd });
          resetCommitted = resetRequested;
          if (resetCommitted) {
            await this.invalidateCanonicalSiblingBindings(sessionKey, session.sessionId);
          }
          const snapshot = await this.initializeSession(session, { resetLedger: true });
          return {
            sessionId,
            configOptions: snapshot.configOptions,
            modes: snapshot.modes,
          };
        } catch (error) {
          // Canonical reset is the point of no return. Keep its ACP binding so a
          // retry or session/list observes the lifecycle that actually committed.
          if (resetCommitted) {
            throw error;
          }
          if (this.sessionStore.getSession(sessionId) === session) {
            this.sessionStore.deleteSession(sessionId);
          }
          await this.sessionUpdates.deleteLedgerSession(sessionId);
          throw error;
        }
      });
    });
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    this.assertSupportedSessionSetup(params.mcpServers);
    assertAbsoluteCwd(params.cwd, "session/load");
    return await this.withSessionReconfiguration(params.sessionId, async () => {
      const meta = parseSessionMeta(params["_meta"]);
      const resetRequested = meta.resetSession ?? this.opts.resetSession ?? false;
      const readState = async () => {
        const previousSession = this.sessionStore.getSession(params.sessionId);
        const previousBinding = previousSession ? structuredClone(previousSession) : undefined;
        const exactReplay = await this.sessionUpdates.readLedgerReplayBySessionId(params.sessionId);
        const replayLookupKey = exactReplay.sessionKey ?? params.sessionId;
        const keyReplay = exactReplay.complete
          ? exactReplay
          : await this.sessionUpdates.readLedgerReplayBySessionKey(replayLookupKey);
        const replay = exactReplay.complete || !keyReplay.complete ? exactReplay : keyReplay;
        const sessionKey = await this.sessionRuntime.resolveSessionKey({
          meta,
          fallbackKey:
            previousBinding?.sessionKey ??
            exactReplay.sessionKey ??
            replay.sessionKey ??
            params.sessionId,
        });
        return { exactReplay, previousBinding, previousSession, replay, sessionKey };
      };
      const initialState = await readState();
      return await this.withRefreshedCanonicalSessionLifecycle(
        initialState.sessionKey,
        resetRequested,
        readState,
        async ({ exactReplay, previousBinding, previousSession, replay, sessionKey }) => {
          this.assertStableSessionIdentity({
            sessionId: params.sessionId,
            sessionKey,
            liveSessionKey: previousBinding?.sessionKey,
            replaySessionKey: exactReplay.sessionKey,
          });
          await this.quiesceSession(params.sessionId);
          const boundLedgerReplay = previousBinding?.ledgerSessionId
            ? await this.sessionUpdates.readLedgerReplayBySessionId(previousBinding.ledgerSessionId)
            : exactReplay;
          const hasReusableLedger =
            boundLedgerReplay.sessionId !== undefined &&
            boundLedgerReplay.sessionKey === sessionKey;
          if (
            !previousSession ||
            resetRequested ||
            previousBinding?.sessionKey !== sessionKey ||
            !hasReusableLedger
          ) {
            this.enforceSessionCreateRateLimit("loadSession");
          }
          const runtimeOptions =
            previousBinding?.sessionKey === sessionKey ? previousBinding.runtimeOptions : undefined;
          const snapshotOverrides = presentationOverrides(runtimeOptions ?? {});
          const existingSnapshot =
            resetRequested || (replay.complete && replay.sessionKey === sessionKey)
              ? undefined
              : await this.sessionRuntime.getExistingSessionSnapshot(sessionKey, snapshotOverrides);
          const resolvedReplay: AcpEventLedgerReplay = resetRequested
            ? { complete: true, events: [] }
            : replay.complete && replay.sessionKey === sessionKey
              ? replay
              : await this.sessionUpdates.readLedgerReplay({
                  sessionId: params.sessionId,
                  sessionKey,
                });
          const transcript =
            !resetRequested && !resolvedReplay.complete
              ? await this.sessionRuntime.getSessionTranscript(sessionKey)
              : undefined;
          const reusableLedgerSessionId =
            !resetRequested && previousBinding?.sessionKey === sessionKey
              ? previousBinding.ledgerSessionId
              : !resetRequested && resolvedReplay.sessionKey === sessionKey
                ? resolvedReplay.sessionId
                : undefined;
          const ledgerSessionId = reusableLedgerSessionId;
          const installedLedgerExisted =
            ledgerSessionId !== undefined
              ? ledgerSessionId === previousBinding?.ledgerSessionId ||
                ledgerSessionId === resolvedReplay.sessionId
              : exactReplay.sessionId === params.sessionId && exactReplay.sessionKey === sessionKey;
          const session = this.sessionStore.createSession({
            sessionId: params.sessionId,
            sessionKey,
            ledgerSessionId,
            cwd: params.cwd,
            runtimeOptions,
            protectedSessionIds: this.activePromptSessionIds(),
          });
          let resetCommitted = false;
          try {
            await this.sessionRuntime.resetSessionIfNeeded({ meta, sessionKey, cwd: params.cwd });
            resetCommitted = resetRequested;
            if (resetCommitted) {
              await this.invalidateCanonicalSiblingBindings(sessionKey, session.sessionId);
            }
            await this.sessionUpdates.startLedgerSession(session, {
              complete: resolvedReplay.complete,
              reset: resetRequested,
            });
            // The canonical reset and the ACP replay boundary are one operation. Never
            // rehydrate events or transcript content from the lifecycle we just replaced.
            if (!resetRequested) {
              if (resolvedReplay.complete) {
                await this.replayLedgerSession(session.sessionId, resolvedReplay);
              } else {
                await this.replaySessionTranscript(session.sessionId, transcript ?? []);
              }
            }
            const snapshot =
              resetRequested || !existingSnapshot
                ? await this.sessionRuntime.getSessionSnapshot(sessionKey, snapshotOverrides)
                : existingSnapshot;
            await this.sendSessionSnapshotUpdate(session, snapshot, false);
            await this.sessionUpdates.sendAvailableCommands(session, { record: false });
            return {
              configOptions: snapshot.configOptions,
              modes: snapshot.modes,
            };
          } catch (error) {
            if (!resetCommitted) {
              await this.rollbackSessionBinding({
                installedSession: session,
                previousBinding,
                installedLedgerExisted,
              });
            }
            throw error;
          }
        },
      );
    });
  }

  async listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
    const cwd = params.cwd;
    if (cwd !== undefined) {
      assertAbsoluteCwd(cwd, "session/list");
    }
    const cursor = decodeListSessionsCursor(params.cursor);
    if (params.cursor && cursor.cwd !== cwd) {
      throw new Error("ACP session list cursor does not match the cwd filter.");
    }
    const limit = resolveListSessionsPageSize(params["_meta"]);
    const rows = await this.sessionRuntime.listSessions({
      cwd,
      offset: cursor.offset,
      limit: limit + 1,
    });
    const hasMore = rows.length > limit;
    const sessions = await Promise.all(
      rows.slice(0, limit).map(async (row) => {
        const liveSessionId = this.sessionStore.getSessionIdsByKey(row.sessionId)[0];
        if (liveSessionId) {
          return { ...row, sessionId: liveSessionId };
        }
        const replay = await this.sessionUpdates.readLedgerReplayBySessionKey(row.sessionId);
        const replayBinding = replay.sessionId
          ? this.sessionStore.getSession(replay.sessionId)
          : undefined;
        return replay.sessionId && !replayBinding ? { ...row, sessionId: replay.sessionId } : row;
      }),
    );
    return {
      sessions,
      nextCursor: hasMore
        ? encodeListSessionsCursor({
            offset: cursor.offset + limit,
            ...(cwd ? { cwd } : {}),
          })
        : null,
    };
  }

  async resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    this.assertSupportedSessionSetup(params.mcpServers ?? []);
    assertAbsoluteCwd(params.cwd, "session/resume");
    return await this.withSessionReconfiguration(params.sessionId, async () => {
      const meta = parseSessionMeta(params["_meta"]);
      const resetRequested = meta.resetSession ?? this.opts.resetSession ?? false;
      const readState = async () => {
        const existingSession = this.sessionStore.getSession(params.sessionId);
        const previousBinding = existingSession ? structuredClone(existingSession) : undefined;
        const priorReplay = await this.sessionUpdates.readLedgerReplayBySessionId(params.sessionId);
        const sessionKey = await this.sessionRuntime.resolveSessionKey({
          meta,
          fallbackKey: existingSession?.sessionKey ?? priorReplay.sessionKey ?? params.sessionId,
        });
        return { existingSession, previousBinding, priorReplay, sessionKey };
      };
      const initialState = await readState();
      return await this.withRefreshedCanonicalSessionLifecycle(
        initialState.sessionKey,
        resetRequested,
        readState,
        async ({ existingSession, previousBinding, priorReplay, sessionKey }) => {
          this.assertStableSessionIdentity({
            sessionId: params.sessionId,
            sessionKey,
            liveSessionKey: previousBinding?.sessionKey,
            replaySessionKey: priorReplay.sessionKey,
          });
          await this.quiesceSession(params.sessionId);
          const runtimeOptions =
            previousBinding?.sessionKey === sessionKey ? previousBinding.runtimeOptions : undefined;
          const snapshotOverrides = presentationOverrides(runtimeOptions ?? {});
          const reusableLedgerSessionId =
            !resetRequested && previousBinding?.sessionKey === sessionKey
              ? previousBinding.ledgerSessionId
              : undefined;
          const ledgerSessionId = reusableLedgerSessionId;
          const installedLedgerExisted =
            ledgerSessionId !== undefined
              ? ledgerSessionId === previousBinding?.ledgerSessionId
              : priorReplay.sessionId === params.sessionId && priorReplay.sessionKey === sessionKey;
          if (!existingSession || resetRequested || !installedLedgerExisted) {
            this.enforceSessionCreateRateLimit("resumeSession");
          }
          const session = this.sessionStore.createSession({
            sessionId: params.sessionId,
            sessionKey,
            ledgerSessionId,
            cwd: params.cwd,
            runtimeOptions,
            protectedSessionIds: this.activePromptSessionIds(),
          });
          let resetCommitted = false;
          try {
            await this.sessionRuntime.resetSessionIfNeeded({ meta, sessionKey, cwd: params.cwd });
            resetCommitted = resetRequested;
            if (resetCommitted) {
              await this.invalidateCanonicalSiblingBindings(sessionKey, session.sessionId);
            }
            await this.sessionUpdates.startLedgerSession(session, {
              complete: resetRequested,
              reset: resetRequested,
            });
            const snapshot =
              !existingSession || sessionKey !== existingSession.sessionKey
                ? await this.sessionRuntime.getExistingSessionSnapshot(
                    sessionKey,
                    snapshotOverrides,
                  )
                : await this.sessionRuntime.getSessionSnapshot(sessionKey, snapshotOverrides);
            await this.sendSessionSnapshotUpdate(session, snapshot, false);
            await this.sessionUpdates.sendAvailableCommands(session, { record: false });
            return {
              configOptions: snapshot.configOptions,
              modes: snapshot.modes,
            };
          } catch (error) {
            if (!resetCommitted) {
              await this.rollbackSessionBinding({
                installedSession: session,
                previousBinding,
                installedLedgerExisted,
              });
            }
            throw error;
          }
        },
      );
    });
  }

  async closeSession(params: CloseSessionRequest): Promise<CloseSessionResponse> {
    return await this.withSessionReconfiguration(params.sessionId, async () => {
      const session = this.requireSession(params.sessionId);
      await this.quiesceSession(session.sessionId);
      this.sessionStore.deleteSession(session.sessionId);
      return {};
    });
  }

  async authenticate(_params: AuthenticateRequest): Promise<AuthenticateResponse> {
    return {};
  }

  async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
    return await this.withSessionMutation(params.sessionId, async () => {
      const initialSession = this.requireSession(params.sessionId);
      return await this.withCanonicalSessionMutation(initialSession.sessionKey, async () => {
        const session = this.requireSession(params.sessionId);
        if (!params.modeId) {
          return {};
        }
        const nextOptions = mergeSessionRuntimeOptions(getSessionRuntimeOptions(session), {
          thinking: params.modeId,
        });
        const snapshot = await this.sessionRuntime.patchSession(
          session.sessionKey,
          { thinkingLevel: params.modeId },
          {
            ...presentationOverrides(nextOptions),
            spawnedCwd: session.cwd,
          },
        );
        session.runtimeOptions = nextOptions;
        await this.sendSessionSnapshotUpdate(session, snapshot, true);
        return {};
      });
    });
  }

  async setSessionConfigOption(
    params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    return await this.withSessionMutation(params.sessionId, async () => {
      const initialSession = this.requireSession(params.sessionId);
      return await this.withCanonicalSessionMutation(initialSession.sessionKey, async () => {
        const session = this.requireSession(params.sessionId);
        if (typeof params.value !== "string") {
          throw new Error(`ACP config option "${params.configId}" requires a string value.`);
        }
        const currentOptions = getSessionRuntimeOptions(session);
        let sessionPatch: AcpLocalSessionPatch | undefined;
        let runtimePatch: Partial<AcpSessionRuntimeOptions> | undefined;
        switch (params.configId) {
          case ACP_THOUGHT_LEVEL_CONFIG_ID:
            sessionPatch = { thinkingLevel: params.value };
            runtimePatch = { thinking: params.value };
            break;
          case ACP_FAST_MODE_CONFIG_ID: {
            const fastMode = normalizeFastMode(params.value);
            if (fastMode === undefined) {
              throw new Error(`Unsupported fast mode value: ${params.value}`);
            }
            sessionPatch = { fastMode };
            runtimePatch = {
              backendExtras: {
                fastMode: params.value,
              },
            };
            break;
          }
          case ACP_VERBOSE_LEVEL_CONFIG_ID:
            sessionPatch = { verboseLevel: params.value };
            runtimePatch = {
              backendExtras: {
                verbose: params.value,
              },
            };
            break;
          case ACP_TRACE_LEVEL_CONFIG_ID:
            sessionPatch = { traceLevel: params.value };
            break;
          case ACP_REASONING_LEVEL_CONFIG_ID:
            sessionPatch = { reasoningLevel: params.value };
            break;
          case ACP_RESPONSE_USAGE_CONFIG_ID:
            sessionPatch = {
              responseUsage:
                params.value === "inherit"
                  ? null
                  : (params.value as NonNullable<AcpLocalSessionPatch["responseUsage"]>),
            };
            break;
          case ACP_ELEVATED_LEVEL_CONFIG_ID:
            sessionPatch = { elevatedLevel: params.value };
            break;
          case ACP_TIMEOUT_CONFIG_ID:
          case ACP_TIMEOUT_SECONDS_CONFIG_ID: {
            if (params.value === "inherit") {
              runtimePatch = { timeoutSeconds: undefined };
              break;
            }
            if (!/^(0|[1-9]\d*)$/.test(params.value)) {
              throw new Error(`Unsupported timeout value: ${params.value}`);
            }
            const seconds = Number(params.value);
            if (!Number.isSafeInteger(seconds)) {
              throw new Error(`Unsupported timeout value: ${params.value}`);
            }
            runtimePatch = { timeoutSeconds: seconds };
            break;
          }
          default:
            throw new Error(
              `ACP local runtime does not support config option "${params.configId}".`,
            );
        }
        const nextOptions = runtimePatch
          ? mergeSessionRuntimeOptions(currentOptions, runtimePatch)
          : currentOptions;
        const overrides = {
          ...presentationOverrides(nextOptions),
          spawnedCwd: session.cwd,
        };
        const snapshot = sessionPatch
          ? await this.sessionRuntime.patchSession(session.sessionKey, sessionPatch, overrides)
          : await this.sessionRuntime.getSessionSnapshot(session.sessionKey, overrides);
        if (runtimePatch) {
          session.runtimeOptions = nextOptions;
        }
        await this.sendSessionSnapshotUpdate(session, snapshot, true);
        return { configOptions: snapshot.configOptions };
      });
    });
  }

  prompt(params: PromptRequest): Promise<PromptResponse> {
    const completion = this.runPrompt(params);
    this.promptCompletions.set(completion, params.sessionId);
    const clearCompletion = () => {
      this.promptCompletions.delete(completion);
      if (![...this.promptCompletions.values()].includes(params.sessionId)) {
        this.promptGenerations.delete(params.sessionId);
      }
    };
    void completion.then(
      () => clearCompletion(),
      () => clearCompletion(),
    );
    return completion;
  }

  private async runPrompt(params: PromptRequest): Promise<PromptResponse> {
    this.assertRunning();
    if (this.reconfiguringSessions.has(params.sessionId)) {
      throw new Error(`Session ${params.sessionId} is being reconfigured`);
    }
    const session = this.requireSession(params.sessionId);
    const generation = (this.promptGenerations.get(session.sessionId) ?? 0) + 1;
    this.promptGenerations.set(session.sessionId, generation);
    await this.cancelSessionTurn(session.sessionId);
    if (!this.isCurrentPrompt(session.sessionId, generation)) {
      return { stopReason: "cancelled" };
    }

    const meta = parseSessionMeta(params["_meta"]);
    const userText = extractTextFromPrompt(params.prompt, MAX_PROMPT_BYTES);
    const prefixCwd = meta.prefixCwd ?? this.opts.prefixCwd ?? true;
    const message = prefixCwd
      ? `[Working directory: ${shortenHomePath(session.cwd)}]\n\n${userText}`
      : userText;
    if (Buffer.byteLength(message, "utf8") > MAX_PROMPT_BYTES) {
      throw new Error(`Prompt exceeds maximum allowed size of ${MAX_PROMPT_BYTES} bytes`);
    }

    const runId = randomUUID();
    const runtimeOptions = getSessionRuntimeOptions(session);
    const state: AcpTurnState = {
      sessionId: session.sessionId,
      sessionKey: session.sessionKey,
      ...(session.ledgerSessionId ? { ledgerSessionId: session.ledgerSessionId } : {}),
      sentText: "",
      sentThought: "",
      toolCalls: new Map(),
      eventTail: Promise.resolve(),
      lifecycleAborted: false,
      runtimeOptions,
    };
    const approvalHost = createAcpApprovalHost({
      connection: this.connection,
      sessionId: session.sessionId,
    });

    await this.sessionUpdates.recordUserPrompt(session, runId, params.prompt);
    if (!this.isCurrentPrompt(session.sessionId, generation)) {
      return { stopReason: "cancelled" };
    }
    const turn = this.localAgentHost.startTurn({
      runId,
      sessionKey: session.sessionKey,
      adapterState: state,
      onEvent: (event) => {
        state.eventTail = state.eventTail.then(async () => {
          try {
            await this.handleAgentEvent(state, event);
          } catch (error) {
            state.projectionError ??= error;
            this.log(`event projection failed for ${runId}: ${String(error)}`);
          }
        });
      },
      execute: async (signal) => {
        let result: AgentResult | undefined;
        let executionError: unknown;
        try {
          result = await this.executeAgent(
            {
              message:
                this.opts.provenanceMode === "meta+receipt"
                  ? `${buildSystemProvenanceReceipt({
                      cwd: session.cwd,
                      sessionId: session.sessionId,
                      sessionKey: session.sessionKey,
                    })}\n\n${message}`
                  : message,
              transcriptMessage: userText,
              images: extractAttachmentsFromPrompt(params.prompt).map((attachment) => ({
                type: "image" as const,
                data: attachment.content,
                mimeType: attachment.mimeType,
              })),
              sessionKey: session.sessionKey,
              thinking:
                readString(params["_meta"], ["thinking", "thinkingLevel"]) ??
                runtimeOptions.thinking,
              verbose: runtimeOptions.backendExtras?.verbose,
              fastMode: normalizeFastMode(runtimeOptions.backendExtras?.fastMode),
              deliver: readBool(params["_meta"], ["deliver"]) ?? false,
              channel: INTERNAL_MESSAGE_CHANNEL,
              runContext: {
                messageChannel: INTERNAL_MESSAGE_CHANNEL,
                currentChannelId: INTERNAL_MESSAGE_CHANNEL,
              },
              cwd: session.cwd,
              timeout:
                timeoutSeconds(
                  (() => {
                    const timeoutMs = readNonNegativeInteger(params["_meta"], ["timeoutMs"]);
                    return timeoutMs === undefined ? undefined : timeoutMs / 1_000;
                  })(),
                ) ?? timeoutSeconds(runtimeOptions.timeoutSeconds),
              runId,
              approvalHost,
              abortSignal: signal,
              allowModelOverride: false,
              senderIsOwner: true,
              inputProvenance: {
                kind: "external_user",
                sourceChannel: "acp",
              },
            },
            silentRuntime,
          );
        } catch (error) {
          executionError = error;
        }
        await state.eventTail;
        return await this.finalizeTurn({
          state,
          runId,
          signal,
          generation,
          result,
          executionError,
        });
      },
    });

    return await turn.result;
  }

  async cancel(params: CancelNotification): Promise<void> {
    if (!this.promptGenerations.has(params.sessionId)) {
      return;
    }
    this.invalidatePrompt(params.sessionId);
    await this.cancelSessionTurn(params.sessionId);
  }

  private async finalizeTurn(params: {
    state: AcpTurnState;
    runId: string;
    signal: AbortSignal;
    generation: number;
    result?: AgentResult;
    executionError?: unknown;
  }): Promise<PromptResponse> {
    const { state, runId, signal, generation, result, executionError } = params;
    const aborted = signal.aborted || state.lifecycleAborted || result?.meta?.aborted === true;
    if (aborted || !this.isCurrentPrompt(state.sessionId, generation)) {
      return { stopReason: "cancelled" };
    }
    if (state.projectionError) {
      throw state.projectionError;
    }
    if (executionError) {
      throw executionError;
    }

    const finalText = payloadText(result?.payloads);
    if (finalText) {
      await this.emitAssistantSnapshot(state, runId, finalText);
      if (!this.isCurrentPrompt(state.sessionId, generation)) {
        return { stopReason: "cancelled" };
      }
    }
    const snapshot = await this.sessionRuntime.getSessionSnapshot(
      state.sessionKey,
      presentationOverrides(state.runtimeOptions),
    );
    if (!this.isCurrentPrompt(state.sessionId, generation)) {
      return { stopReason: "cancelled" };
    }
    await this.sendSessionSnapshotUpdate(
      {
        sessionId: state.sessionId,
        sessionKey: state.sessionKey,
        ...(state.ledgerSessionId ? { ledgerSessionId: state.ledgerSessionId } : {}),
      },
      snapshot,
      false,
      runId,
    );
    if (!this.isCurrentPrompt(state.sessionId, generation)) {
      return { stopReason: "cancelled" };
    }
    return {
      stopReason: normalizeStopReason(state.lifecycleStopReason ?? result?.meta?.stopReason),
    };
  }

  private async cancelSessionTurn(sessionId: string): Promise<void> {
    const turn = this.localAgentHost
      .list()
      .find((candidate) => candidate.adapterState.sessionId === sessionId);
    if (!turn) {
      return;
    }
    turn.cancel(new Error("ACP prompt cancelled"));
    await turn.result.catch(() => {});
    await turn.adapterState.eventTail;
  }

  private async quiesceSession(sessionId: string): Promise<void> {
    this.invalidatePrompt(sessionId);
    await this.cancelSessionTurn(sessionId);
    const completions = [...this.promptCompletions.entries()]
      .filter(([, candidateSessionId]) => candidateSessionId === sessionId)
      .map(([completion]) => completion);
    await Promise.allSettled(completions);
    if (![...this.promptCompletions.values()].includes(sessionId)) {
      this.promptGenerations.delete(sessionId);
    }
  }

  private async withSessionReconfiguration<T>(
    sessionId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    return await this.withSessionMutation(sessionId, async () => {
      this.reconfiguringSessions.add(sessionId);
      try {
        return await operation();
      } finally {
        this.reconfiguringSessions.delete(sessionId);
      }
    });
  }

  private async withCanonicalSessionLifecycle<T>(
    sessionKey: string,
    resetRequested: boolean,
    operation: () => Promise<T>,
  ): Promise<T> {
    return await this.withCanonicalSessionMutation(sessionKey, async () => {
      return await this.withCanonicalSessionLifecycleLockHeld(
        sessionKey,
        resetRequested,
        operation,
      );
    });
  }

  private async withRefreshedCanonicalSessionLifecycle<
    TState extends { sessionKey: string },
    TResult,
  >(
    initialSessionKey: string,
    resetRequested: boolean,
    readState: () => Promise<TState>,
    operation: (state: TState) => Promise<TResult>,
  ): Promise<TResult> {
    let sessionKey = initialSessionKey;
    while (true) {
      const attempt = await this.withCanonicalSessionMutation(sessionKey, async () => {
        const state = await readState();
        if (state.sessionKey !== sessionKey) {
          return { kind: "retry", sessionKey: state.sessionKey } as const;
        }
        return {
          kind: "complete",
          value: await this.withCanonicalSessionLifecycleLockHeld(
            sessionKey,
            resetRequested,
            async () => await operation(state),
          ),
        } as const;
      });
      if (attempt.kind === "complete") {
        return attempt.value;
      }
      sessionKey = attempt.sessionKey;
    }
  }

  private async withCanonicalSessionLifecycleLockHeld<T>(
    sessionKey: string,
    resetRequested: boolean,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (!resetRequested) {
      return await operation();
    }
    const sessionIds = this.sessionStore.getSessionIdsByKey(sessionKey);
    const guardedSessionIds = sessionIds.filter(
      (sessionId) => !this.reconfiguringSessions.has(sessionId),
    );
    for (const sessionId of guardedSessionIds) {
      this.reconfiguringSessions.add(sessionId);
    }
    try {
      await Promise.all(sessionIds.map(async (sessionId) => await this.quiesceSession(sessionId)));
      return await operation();
    } finally {
      for (const sessionId of guardedSessionIds) {
        this.promptGenerations.delete(sessionId);
        this.reconfiguringSessions.delete(sessionId);
      }
    }
  }

  private activePromptSessionIds(): ReadonlySet<string> {
    return new Set(this.promptCompletions.values());
  }

  private async invalidateCanonicalSiblingBindings(
    sessionKey: string,
    retainedSessionId: string,
  ): Promise<void> {
    for (const sessionId of this.sessionStore.getSessionIdsByKey(sessionKey)) {
      if (sessionId === retainedSessionId) {
        continue;
      }
      const sibling = this.sessionStore.getSession(sessionId);
      if (!sibling || sibling.sessionKey !== sessionKey) {
        continue;
      }
      this.sessionStore.deleteSession(sessionId);
      await this.sessionUpdates.deleteLedgerSession(sibling.ledgerSessionId ?? sibling.sessionId);
    }
  }

  private async rollbackSessionBinding(params: {
    installedSession: AcpSession;
    previousBinding?: AcpSession;
    installedLedgerExisted: boolean;
  }): Promise<void> {
    const installedLedgerId =
      params.installedSession.ledgerSessionId ?? params.installedSession.sessionId;
    const previousLedgerId =
      params.previousBinding?.ledgerSessionId ?? params.previousBinding?.sessionId;
    const current = this.sessionStore.getSession(params.installedSession.sessionId);
    if (current === params.installedSession) {
      if (params.previousBinding) {
        current.sessionKey = params.previousBinding.sessionKey;
        current.cwd = params.previousBinding.cwd;
        current.createdAt = params.previousBinding.createdAt;
        current.lastTouchedAt = params.previousBinding.lastTouchedAt;
        if (params.previousBinding.ledgerSessionId) {
          current.ledgerSessionId = params.previousBinding.ledgerSessionId;
        } else {
          delete current.ledgerSessionId;
        }
        if (params.previousBinding.runtimeOptions) {
          current.runtimeOptions = structuredClone(params.previousBinding.runtimeOptions);
        } else {
          delete current.runtimeOptions;
        }
      } else {
        this.sessionStore.deleteSession(params.installedSession.sessionId);
      }
    }

    if (!params.installedLedgerExisted && installedLedgerId !== previousLedgerId) {
      await this.sessionUpdates.deleteLedgerSession(installedLedgerId);
    }
    if (params.previousBinding) {
      await this.sessionUpdates.startLedgerSession(params.previousBinding, {
        complete: false,
      });
    }
  }

  private async withSessionMutation<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    this.assertRunning();
    const previous = this.sessionMutationTails.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.sessionMutationTails.set(sessionId, tail);
    await previous;
    try {
      this.assertRunning();
      return await operation();
    } finally {
      release();
      if (this.sessionMutationTails.get(sessionId) === tail) {
        this.sessionMutationTails.delete(sessionId);
      }
    }
  }

  private async withCanonicalSessionMutation<T>(
    sessionKey: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    this.assertRunning();
    const previous = this.canonicalSessionMutationTails.get(sessionKey) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.canonicalSessionMutationTails.set(sessionKey, tail);
    await previous;
    try {
      this.assertRunning();
      return await operation();
    } finally {
      release();
      if (this.canonicalSessionMutationTails.get(sessionKey) === tail) {
        this.canonicalSessionMutationTails.delete(sessionKey);
      }
    }
  }

  private async handleAgentEvent(state: AcpTurnState, event: AgentEventPayload): Promise<void> {
    if (event.stream === "assistant") {
      if (resolveAssistantEventPhase(event.data) === "commentary") {
        return;
      }
      const merged = appendAssistantText({
        previous: state.sentText,
        text: event.data.text,
        delta: event.data.delta,
      });
      state.sentText = merged.full;
      if (merged.chunk) {
        await this.emitTurnUpdate(state, event.runId, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: merged.chunk },
        });
      }
      return;
    }
    if (event.stream === "thinking") {
      const merged = appendAssistantText({
        previous: state.sentThought,
        text: event.data.text,
        delta: event.data.delta,
      });
      state.sentThought = merged.full;
      if (merged.chunk) {
        await this.emitTurnUpdate(state, event.runId, {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: merged.chunk },
        });
      }
      return;
    }
    if (event.stream === "tool") {
      await this.handleToolEvent(state, event);
      return;
    }
    if (event.stream === "lifecycle") {
      const phase = event.data.phase;
      if (phase === "finishing" || phase === "end") {
        if (typeof event.data.stopReason === "string") {
          state.lifecycleStopReason = event.data.stopReason;
        }
      }
      if (phase === "end" || phase === "error") {
        state.lifecycleAborted = event.data.aborted === true;
      }
    }
  }

  private async handleToolEvent(state: AcpTurnState, event: AgentEventPayload): Promise<void> {
    const phase = event.data.phase;
    const toolCallId =
      typeof event.data.toolCallId === "string" ? event.data.toolCallId : undefined;
    if (!toolCallId) {
      return;
    }
    if (phase === "start") {
      if (state.toolCalls.has(toolCallId)) {
        return;
      }
      const args =
        event.data.args && typeof event.data.args === "object" && !Array.isArray(event.data.args)
          ? (event.data.args as Record<string, unknown>)
          : undefined;
      const name = typeof event.data.name === "string" ? event.data.name : undefined;
      const tool = {
        title: formatToolTitle(name, args),
        kind: inferToolKind(name),
        rawInput: args,
        locations: extractToolCallLocations(args),
      };
      state.toolCalls.set(toolCallId, tool);
      await this.emitTurnUpdate(state, event.runId, {
        sessionUpdate: "tool_call",
        toolCallId,
        title: tool.title,
        status: "in_progress",
        rawInput: args,
        kind: tool.kind,
        locations: tool.locations,
      });
      return;
    }
    const tool = state.toolCalls.get(toolCallId);
    const output = phase === "update" ? event.data.partialResult : event.data.result;
    if (phase === "result") {
      state.toolCalls.delete(toolCallId);
    }
    if (phase !== "update" && phase !== "result") {
      return;
    }
    await this.emitTurnUpdate(state, event.runId, {
      sessionUpdate: "tool_call_update",
      toolCallId,
      status:
        phase === "result" ? (event.data.isError === true ? "failed" : "completed") : "in_progress",
      rawOutput: output,
      content: extractToolCallContent(output),
      locations: extractToolCallLocations(tool?.locations, output),
    });
  }

  private async emitAssistantSnapshot(
    state: AcpTurnState,
    runId: string,
    text: string,
  ): Promise<void> {
    const merged = appendAssistantText({ previous: state.sentText, text });
    state.sentText = merged.full;
    if (!merged.chunk) {
      return;
    }
    await this.emitTurnUpdate(state, runId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: merged.chunk },
    });
  }

  private async emitTurnUpdate(
    state: AcpTurnState,
    runId: string | undefined,
    update: Parameters<AcpTranslatorSessionUpdates["emit"]>[0]["update"],
  ): Promise<void> {
    await this.sessionUpdates.emit({
      sessionId: state.sessionId,
      sessionKey: state.sessionKey,
      ...(state.ledgerSessionId ? { ledgerSessionId: state.ledgerSessionId } : {}),
      ...(runId ? { runId } : {}),
      update,
      record: true,
    });
  }

  private async initializeSession(
    session: AcpSession,
    options: { resetLedger: boolean },
  ): Promise<SessionSnapshot> {
    await this.sessionUpdates.startLedgerSession(session, {
      complete: true,
      reset: options.resetLedger,
    });
    const snapshot = await this.sessionRuntime.getSessionSnapshot(session.sessionKey);
    await this.sendSessionSnapshotUpdate(session, snapshot, false);
    await this.sessionUpdates.sendAvailableCommands(session, { record: true });
    return snapshot;
  }

  private async replaySessionTranscript(
    sessionId: string,
    transcript: ReadonlyArray<AcpTranscriptMessage>,
  ): Promise<void> {
    for (const message of transcript) {
      for (const chunk of extractReplayChunks(message)) {
        await this.sessionUpdates.emit({
          sessionId,
          update: {
            sessionUpdate: chunk.sessionUpdate,
            content: { type: "text", text: chunk.text },
          },
        });
      }
    }
  }

  private async replayLedgerSession(
    sessionId: string,
    replay: AcpEventLedgerReplay,
  ): Promise<void> {
    for (const event of replay.events) {
      await this.sessionUpdates.emit({
        sessionId,
        update: event.update,
        record: false,
      });
    }
  }

  private async sendSessionSnapshotUpdate(
    session: { sessionId: string; sessionKey: string; ledgerSessionId?: string },
    snapshot: SessionSnapshot,
    includeControls: boolean,
    runId?: string,
  ): Promise<void> {
    const common = {
      sessionId: session.sessionId,
      sessionKey: session.sessionKey,
      ...(session.ledgerSessionId ? { ledgerSessionId: session.ledgerSessionId } : {}),
      ...(runId ? { runId } : {}),
      record: true,
    };
    if (includeControls) {
      await this.sessionUpdates.emit({
        ...common,
        update: {
          sessionUpdate: "current_mode_update",
          currentModeId: snapshot.modes.currentModeId,
        },
      });
      await this.sessionUpdates.emit({
        ...common,
        update: {
          sessionUpdate: "config_option_update",
          configOptions: snapshot.configOptions,
        },
      });
    }
    if (snapshot.metadata) {
      await this.sessionUpdates.emit({
        ...common,
        update: {
          sessionUpdate: "session_info_update",
          ...snapshot.metadata,
        },
      });
    }
    if (snapshot.usage) {
      await this.sessionUpdates.emit({
        ...common,
        update: {
          sessionUpdate: "usage_update",
          used: snapshot.usage.used,
          size: snapshot.usage.size,
          _meta: {
            source: "local-session-store",
            approximate: true,
          },
        },
      });
    }
  }

  private requireSession(sessionId: string): AcpSession {
    const session = this.sessionStore.getSession(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }
    return session;
  }

  private assertStableSessionIdentity(params: {
    sessionId: string;
    sessionKey: string;
    liveSessionKey?: string;
    replaySessionKey?: string;
  }): void {
    const boundSessionKey = params.liveSessionKey ?? params.replaySessionKey;
    if (!boundSessionKey || boundSessionKey === params.sessionKey) {
      return;
    }
    throw new Error(
      `ACP session ${params.sessionId} is already bound to ${boundSessionKey}; create or select a different ACP session for ${params.sessionKey}.`,
    );
  }

  private assertRunning(): void {
    if (this.stopped) {
      throw new Error("ACP runtime is stopped");
    }
  }

  private isCurrentPrompt(sessionId: string, generation: number): boolean {
    return !this.stopped && this.promptGenerations.get(sessionId) === generation;
  }

  private invalidatePrompt(sessionId: string): void {
    this.promptGenerations.set(sessionId, (this.promptGenerations.get(sessionId) ?? 0) + 1);
  }

  private assertSupportedSessionSetup(mcpServers: ReadonlyArray<unknown>): void {
    if (mcpServers.length === 0) {
      return;
    }
    throw new Error(
      "OpenClaw ACP does not support per-session MCP servers. Configure tools in OpenClaw instead.",
    );
  }

  private enforceSessionCreateRateLimit(
    method: "newSession" | "loadSession" | "resumeSession",
  ): void {
    const budget = this.sessionCreateRateLimiter.consume();
    if (budget.allowed) {
      return;
    }
    throw new Error(
      `ACP session creation rate limit exceeded for ${method}; retry after ${Math.ceil(budget.retryAfterMs / 1_000)}s.`,
    );
  }
}

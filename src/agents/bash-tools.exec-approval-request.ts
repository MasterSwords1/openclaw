/**
 * Exec approval request client.
 * Registers two-phase approval requests with the owning run host, waits for
 * decisions, and builds host/node payloads with optional command highlighting.
 */
import type {
  ExecApprovalCommandSpan,
  ExecApprovalUnavailableDecision,
  ExecAsk,
  ExecSecurity,
  SystemRunApprovalPlan,
} from "../infra/exec-approvals.js";
import { normalizeExecutableToken } from "../infra/exec-wrapper-tokens.js";
import {
  isShellWrapperExecutable,
  POSIX_PARSEABLE_SHELL_WRAPPERS,
  resolveShellWrapperTransportArgv,
} from "../infra/shell-wrapper-resolution.js";
import { createLazyPromise } from "../shared/lazy-runtime.js";
import type {
  AgentRunApprovalHost,
  AgentRunExecApprovalLease,
  AgentRunExecApprovalRequest,
} from "./agent-run-approval.js";
import { AgentRunExecApprovalRunAbortedError } from "./agent-run-approval.js";
import { DEFAULT_APPROVAL_TIMEOUT_MS } from "./bash-tools.exec-runtime.js";

const POSIX_COMMAND_HIGHLIGHT_SHELLS: ReadonlySet<string> = POSIX_PARSEABLE_SHELL_WRAPPERS;

const loadExecApprovalCommandSpansRuntime = createLazyPromise(
  () => import("./bash-tools.exec-approval-request.runtime.js"),
  { cacheRejections: true },
);

/** Registration result returned before an approval decision is available. */
export type ExecApprovalRegistration = AgentRunExecApprovalLease;

export function isExecApprovalRunAbortedError(error: unknown): boolean {
  return error instanceof AgentRunExecApprovalRunAbortedError;
}

/** Uses a pre-resolved decision or waits for the registered approval id. */
export async function resolveRegisteredExecApprovalDecision(params: {
  approval: AgentRunExecApprovalLease;
  preResolvedDecision: string | null | undefined;
  signal?: AbortSignal;
}): Promise<string | null> {
  params.signal?.throwIfAborted();
  if (params.preResolvedDecision !== undefined) {
    return params.preResolvedDecision ?? null;
  }
  const decision = await params.approval.wait({ signal: params.signal });
  params.signal?.throwIfAborted();
  return decision;
}

type HostExecApprovalParams = {
  approvalHost?: AgentRunApprovalHost;
  approvalId: string;
  command?: string;
  commandArgv?: string[];
  systemRunPlan?: SystemRunApprovalPlan;
  env?: Record<string, string>;
  workdir: string | undefined;
  host: "gateway" | "node";
  nodeId?: string;
  security: ExecSecurity;
  ask: ExecAsk;
  warningText?: string;
  commandSpans?: ExecApprovalCommandSpan[];
  unavailableDecisions?: readonly ExecApprovalUnavailableDecision[];
  commandHighlighting?: boolean;
  agentId?: string;
  resolvedPath?: string;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  toolCallId?: string;
  turnSourceChannel?: string;
  turnSourceTo?: string;
  turnSourceAccountId?: string;
  turnSourceThreadId?: string | number;
  requireDeliveryRoute?: boolean;
  suppressDelivery?: boolean;
  signal?: AbortSignal;
};

type ExecApprovalRequesterContext = {
  agentId?: string;
  sessionKey?: string;
};

/** Builds requester identity context for an approval payload. */
export function buildExecApprovalRequesterContext(params: ExecApprovalRequesterContext): {
  agentId?: string;
  sessionKey?: string;
} {
  return {
    agentId: params.agentId,
    sessionKey: params.sessionKey,
  };
}

type ExecApprovalTurnSourceContext = {
  turnSourceChannel?: string;
  turnSourceTo?: string;
  turnSourceAccountId?: string;
  turnSourceThreadId?: string | number;
};

/** Builds originating channel context for approval delivery/routing. */
export function buildExecApprovalTurnSourceContext(
  params: ExecApprovalTurnSourceContext,
): ExecApprovalTurnSourceContext {
  return {
    turnSourceChannel: params.turnSourceChannel,
    turnSourceTo: params.turnSourceTo,
    turnSourceAccountId: params.turnSourceAccountId,
    turnSourceThreadId: params.turnSourceThreadId,
  };
}

async function resolveCommandSpans(
  command: string | undefined,
): Promise<ExecApprovalCommandSpan[] | undefined> {
  if (!command) {
    return undefined;
  }
  try {
    const { resolveExecApprovalCommandSpans } = await loadExecApprovalCommandSpansRuntime();
    return await resolveExecApprovalCommandSpans(command);
  } catch {
    return undefined;
  }
}

function hasUnsupportedShellArgv(argv: readonly string[] | undefined): boolean {
  if (!argv?.length) {
    return false;
  }
  const shellWrapperArgv = resolveShellWrapperTransportArgv([...argv]) ?? argv;
  const executable = shellWrapperArgv[0];
  if (!executable) {
    return false;
  }
  const normalizedExecutable = normalizeExecutableToken(executable);
  return (
    isShellWrapperExecutable(normalizedExecutable) &&
    !POSIX_COMMAND_HIGHLIGHT_SHELLS.has(normalizedExecutable)
  );
}

function shouldSkipGeneratedCommandSpans(params: HostExecApprovalParams): boolean {
  if (params.host === "gateway" && process.platform === "win32") {
    return true;
  }
  const argv = params.commandArgv?.length ? params.commandArgv : params.systemRunPlan?.argv;
  return hasUnsupportedShellArgv(argv);
}

async function buildHostApprovalDecisionParams(
  params: HostExecApprovalParams,
): Promise<AgentRunExecApprovalRequest> {
  const commandSpans =
    params.commandHighlighting === true
      ? (params.commandSpans ??
        (shouldSkipGeneratedCommandSpans(params)
          ? undefined
          : await resolveCommandSpans(params.command ?? params.systemRunPlan?.commandText)))
      : undefined;
  return {
    id: params.approvalId,
    command: params.command,
    commandArgv: params.commandArgv,
    systemRunPlan: params.systemRunPlan,
    env: params.env,
    cwd: params.workdir,
    nodeId: params.nodeId,
    host: params.host,
    security: params.security,
    ask: params.ask,
    warningText: params.warningText,
    commandSpans,
    unavailableDecisions: params.unavailableDecisions,
    ...buildExecApprovalRequesterContext({
      agentId: params.agentId,
      sessionKey: params.sessionKey,
    }),
    resolvedPath: params.resolvedPath,
    sessionId: params.sessionId,
    runId: params.runId,
    toolCallId: params.toolCallId,
    requireDeliveryRoute: params.requireDeliveryRoute,
    suppressDelivery: params.suppressDelivery,
    ...buildExecApprovalTurnSourceContext(params),
  };
}

/** Registers a host/node approval request without waiting for a decision. */
async function registerExecApprovalRequestForHost(
  params: HostExecApprovalParams,
): Promise<ExecApprovalRegistration> {
  const approvalHost = params.approvalHost?.exec;
  if (!approvalHost) {
    throw new Error("Exec approval unavailable: this run has no exec approval host.");
  }
  const approval = await approvalHost.request({
    request: await buildHostApprovalDecisionParams(params),
    timeoutMs: DEFAULT_APPROVAL_TIMEOUT_MS,
    signal: params.signal,
  });
  if (approval.id !== params.approvalId) {
    await approval.cancel().catch(() => undefined);
    throw new Error("Exec approval host returned a mismatched approval id.");
  }
  return approval;
}

/** Registers a host/node approval request and wraps failures for exec callers. */
export async function registerExecApprovalRequestForHostOrThrow(
  params: HostExecApprovalParams,
): Promise<ExecApprovalRegistration> {
  try {
    return await registerExecApprovalRequestForHost(params);
  } catch (err) {
    throw new Error(`Exec approval registration failed: ${String(err)}`, { cause: err });
  }
}

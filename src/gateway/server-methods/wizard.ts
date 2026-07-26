// Wizard gateway methods manage interactive setup wizard sessions and route
// start/next/status/cancel RPCs through the wizard runtime.
import { randomUUID } from "node:crypto";
import { readStringValue } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  GatewayErrorDetailCodes,
  validateWizardCancelParams,
  validateWizardNextParams,
  validateWizardStartParams,
  validateWizardStatusParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { OnboardOptions } from "../../commands/onboard-types.js";
import { defaultRuntime, type RuntimeEnv } from "../../runtime.js";
import type { WizardPrompter } from "../../wizard/prompts.js";
import { WizardSession } from "../../wizard/session.js";
import { formatForLog } from "../ws-log.js";
import { resolveGatewayHostedSessionOwner } from "./hosted-session-owner.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  GatewayRequestHandlers,
  RespondFn,
} from "./types.js";
import { assertValidParams } from "./validation.js";

const CHANNEL_WIZARD_TIMEOUT_MS = 25 * 60 * 1000;

function resolveChannelWizardResumeKey(ownerKey: string | undefined): string | undefined {
  return ownerKey ? JSON.stringify(["gateway-channel-setup", ownerKey]) : undefined;
}

export type SetupWizardRunner = (
  opts: OnboardOptions,
  runtime: RuntimeEnv,
  prompter: WizardPrompter,
) => Promise<void>;

export type ChannelSetupWizardRunner = (
  opts: {
    channel?: string;
    onConfigured?: (accounts: Array<{ channel: string; accountId: string }>) => void;
    onResolvedChannel?: (channel: string, aliases?: readonly string[]) => void;
    beforePersistentEffect?: () => Promise<void>;
    abortSignal?: AbortSignal;
  },
  runtime: RuntimeEnv,
  prompter: WizardPrompter,
) => Promise<void>;

export const runDefaultSetupWizard: SetupWizardRunner = async (...args) => {
  const { runSetupWizard } = await import("../../wizard/setup.js");
  return runSetupWizard(...args);
};

export const runDefaultChannelSetupWizard: ChannelSetupWizardRunner = async (...args) => {
  const { runChannelsSetupWizard } = await import("../../commands/channels/add-wizard.js");
  return runChannelsSetupWizard(...args);
};

function readWizardStatus(session: WizardSession) {
  return {
    status: session.getStatus(),
    error: session.getError(),
  };
}

function finishTerminalWizardResponse(params: {
  context: GatewayRequestContext;
  sessionId: string;
  session: WizardSession;
  isConnectionActive?: () => boolean;
}): void {
  if (params.session.getStatus() === "running") {
    return;
  }
  if (params.session.isCancellationLocked() && params.isConnectionActive?.() === false) {
    // The durable result could not reach its original transport. Retain one
    // owner-bound copy so a reconnect can collect it without rerunning setup.
    params.context.findRunningWizard();
    return;
  }
  params.context.purgeWizardSession(params.sessionId);
}

/** Resolves a live wizard session or sends the public not-found error. */
function findWizardSessionOrRespond(params: {
  context: GatewayRequestContext;
  client: GatewayClient | null;
  respond: RespondFn;
  sessionId: string;
}): WizardSession | null {
  const session = params.context.wizardSessions.get(params.sessionId);
  if (!session) {
    params.respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "wizard not found", {
        details: { code: GatewayErrorDetailCodes.WIZARD_NOT_FOUND },
      }),
    );
    return null;
  }
  const owner = resolveGatewayHostedSessionOwner(params.client);
  const ownerKey = owner.kind === "stable" ? owner.key : undefined;
  if (!session.isAccessibleBy(ownerKey)) {
    const continuityResumeKey =
      owner.kind === "stable" ? resolveChannelWizardResumeKey(owner.continuityKey) : undefined;
    if (!continuityResumeKey || !session.matchesResumeKey(continuityResumeKey)) {
      params.respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "wizard belongs to another caller"),
      );
      return null;
    }
    // Shared Gateway auth rotates its exact generation while preserving the
    // continuity principal. Adopt only cancellation-locked channel work.
    session.adoptOwner(owner.key);
  }
  return session;
}

/** Gateway handlers for the interactive setup wizard session lifecycle. */
export const wizardHandlers: GatewayRequestHandlers = {
  "wizard.start": async ({ params, respond, context, client, isConnectionActive }) => {
    if (!assertValidParams(params, validateWizardStartParams, "wizard.start", respond)) {
      return;
    }
    const flow = params.flow ?? "setup";
    const channel = readStringValue(params.channel);
    const owner = flow === "channels" ? resolveGatewayHostedSessionOwner(client) : undefined;
    if (owner && owner.kind !== "stable") {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "Channel setup requires an identity that can survive reconnects.",
        ),
      );
      return;
    }
    const ownerKey = owner?.key;
    const resumeKey =
      flow === "channels" ? resolveChannelWizardResumeKey(owner?.continuityKey) : undefined;
    if (resumeKey) {
      const ownerSession = [...context.wizardSessions.entries()].find(([, session]) =>
        session.hasResumeKey(resumeKey),
      );
      if (ownerSession && ownerSession[1].canResume(resumeKey, channel)) {
        const [resumableId, resumableSession] = ownerSession;
        resumableSession.adoptOwner(ownerKey);
        const result = await resumableSession.next();
        respond(true, { sessionId: resumableId, ...result }, undefined);
        if (result.done) {
          finishTerminalWizardResponse({
            context,
            sessionId: resumableId,
            session: resumableSession,
            isConnectionActive,
          });
        }
        return;
      }
      if (ownerSession) {
        const [staleId, staleSession] = ownerSession;
        if (!staleSession.isCancellationLocked()) {
          // Credential rotation can strand reversible work under the previous
          // exact owner. Abort it before the continuity owner starts fresh.
          staleSession.cancel();
          context.purgeWizardSession(staleId);
        } else if (staleSession.getStatus() !== "running") {
          // A different requested channel is an explicit fresh-start intent.
          context.purgeWizardSession(staleId);
        }
      }
    }
    const running = context.findRunningWizard();
    if (running) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "wizard already running"));
      return;
    }
    const sessionId = randomUUID();
    const session =
      flow === "channels"
        ? new WizardSession(
            (prompter, signal, wizardSession) =>
              context.channelWizardRunner(
                {
                  channel,
                  onConfigured: (accounts) => wizardSession.setConfiguredAccounts(accounts),
                  onResolvedChannel: (resolvedChannel, aliases) =>
                    wizardSession.setResolvedChannel(resolvedChannel, aliases),
                  abortSignal: signal,
                  // Durable effects (plugin installs, config commit) must finish
                  // even if the client cancels mid-write.
                  beforePersistentEffect: async () => {
                    if (!wizardSession.lockCancellation()) {
                      throw new Error(
                        "Channel setup was cancelled before its persistent change started.",
                      );
                    }
                  },
                },
                defaultRuntime,
                prompter,
              ),
            {
              timeoutMs: CHANNEL_WIZARD_TIMEOUT_MS,
              ...(ownerKey ? { ownerKey } : {}),
              ...(resumeKey ? { resumeKey } : {}),
              ...(channel ? { requestedChannel: channel } : {}),
            },
          )
        : new WizardSession((prompter) =>
            context.wizardRunner(
              {
                mode: params.mode,
                workspace: readStringValue(params.workspace),
              },
              defaultRuntime,
              prompter,
            ),
          );
    context.wizardSessions.set(sessionId, session);
    const result = await session.next();
    respond(true, { sessionId, ...result }, undefined);
    if (result.done) {
      finishTerminalWizardResponse({ context, sessionId, session, isConnectionActive });
    }
  },
  "wizard.next": async ({ params, respond, context, client, isConnectionActive }) => {
    if (!assertValidParams(params, validateWizardNextParams, "wizard.next", respond)) {
      return;
    }
    const sessionId = params.sessionId;
    const session = findWizardSessionOrRespond({ context, client, respond, sessionId });
    if (!session) {
      return;
    }
    const answer = params.answer as { stepId?: string; value?: unknown } | undefined;
    if (answer) {
      if (session.getStatus() !== "running") {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "wizard not running"));
        return;
      }
      try {
        const validationError = await session.answer(answer.stepId ?? "", answer.value);
        if (validationError) {
          respond(true, { ...(await session.next()), error: validationError }, undefined);
          return;
        }
      } catch (err) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, formatForLog(err)));
        return;
      }
    }
    const result = await session.next();
    respond(true, result, undefined);
    if (result.done) {
      finishTerminalWizardResponse({ context, sessionId, session, isConnectionActive });
    }
  },
  "wizard.cancel": ({ params, respond, context, client, isConnectionActive }) => {
    if (!assertValidParams(params, validateWizardCancelParams, "wizard.cancel", respond)) {
      return;
    }
    const sessionId = params.sessionId;
    const session = findWizardSessionOrRespond({ context, client, respond, sessionId });
    if (!session) {
      return;
    }
    const cancelled = session.cancel();
    const status = readWizardStatus(session);
    respond(true, status, undefined);
    if (cancelled || status.status !== "running") {
      finishTerminalWizardResponse({ context, sessionId, session, isConnectionActive });
    }
  },
  "wizard.status": ({ params, respond, context, client, isConnectionActive }) => {
    if (!assertValidParams(params, validateWizardStatusParams, "wizard.status", respond)) {
      return;
    }
    const sessionId = params.sessionId;
    const session = findWizardSessionOrRespond({ context, client, respond, sessionId });
    if (!session) {
      return;
    }
    const status = readWizardStatus(session);
    respond(true, status, undefined);
    if (status.status !== "running") {
      finishTerminalWizardResponse({ context, sessionId, session, isConnectionActive });
    }
  },
};

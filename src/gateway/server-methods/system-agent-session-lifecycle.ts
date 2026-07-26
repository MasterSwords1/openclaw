import { resolveSystemAgentDelegationKey } from "../../system-agent/delegation-session.js";
import { resolveGatewayHostedSessionOwner } from "./hosted-session-owner.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

type SystemAgentSessionMap = GatewayRequestContext["systemAgentSessions"];

type LockedWizardAdoption =
  | { kind: "none" }
  | { kind: "adopted" }
  | { kind: "ambiguous" }
  | { kind: "reset-refused" };

export function resolveSystemAgentSessionOwnerKey(params: {
  delegation?: { agentId?: string; sessionKey?: string };
  client: GatewayClient | null;
}): string | undefined {
  const delegationKey = resolveSystemAgentDelegationKey(params.delegation);
  if (delegationKey !== undefined) {
    // Host-asserted delegation owns its agent/session tuple across reconnects.
    return delegationKey;
  }
  const owner = resolveGatewayHostedSessionOwner(params.client);
  return owner.kind === "stable" ? owner.key : undefined;
}

/** Transfer one exact owner's retained wizard when its client rotates session ids. */
export function adoptLockedSystemAgentWizard(params: {
  sessions: SystemAgentSessionMap;
  sessionId: string;
  ownerKey: string;
  reset: boolean;
}): LockedWizardAdoption {
  const retainedEntries = [...params.sessions.entries()].filter(
    ([candidateId, candidate]) =>
      candidateId !== params.sessionId &&
      candidate.ownerKey === params.ownerKey &&
      candidate.engine.hasLockedHostedWizard(),
  );
  if (retainedEntries.length > 1) {
    return { kind: "ambiguous" };
  }
  const retainedEntry = retainedEntries[0];
  if (!retainedEntry) {
    return { kind: "none" };
  }
  if (params.reset) {
    return { kind: "reset-refused" };
  }
  const [retainedSessionId, retainedSession] = retainedEntry;
  params.sessions.delete(retainedSessionId);
  params.sessions.set(params.sessionId, retainedSession);
  return { kind: "adopted" };
}

/** Retire a resettable session only after synchronously excluding locked work. */
export async function resetSystemAgentSession(params: {
  sessions: SystemAgentSessionMap;
  sessionId: string;
  context: GatewayRequestContext;
}): Promise<boolean> {
  const existing = params.sessions.get(params.sessionId);
  if (existing?.engine.hasLockedHostedWizard()) {
    return false;
  }
  params.sessions.delete(params.sessionId);
  if (existing?.pendingApproval) {
    params.context.systemAgentApprovalManager?.expire(existing.pendingApproval.id, "session-reset");
  }
  if (existing && !(await existing.engine.dispose())) {
    throw new Error("Disposable OpenClaw session became cancellation-locked during reset.");
  }
  return true;
}

/** Evict the oldest disposable session while preserving every locked wizard owner. */
export async function evictOldestSystemAgentSession(
  sessions: SystemAgentSessionMap,
  context: GatewayRequestContext,
  maxSessions: number,
): Promise<boolean> {
  if (sessions.size < maxSessions) {
    return true;
  }
  const oldestFirst = [...sessions.entries()].toSorted(([, left], [, right]) => {
    return left.lastUsedAt - right.lastUsedAt;
  });
  for (const [key, session] of oldestFirst) {
    if (session.engine.hasLockedHostedWizard()) {
      continue;
    }
    // Remove authority before cleanup yields so a concurrent approval callback
    // cannot pass its session-identity check while this session is retiring.
    sessions.delete(key);
    if (session.pendingApproval) {
      context.systemAgentApprovalManager?.expire(session.pendingApproval.id, "session-evicted");
    }
    if (!(await session.engine.dispose())) {
      throw new Error("Disposable OpenClaw session became cancellation-locked during eviction.");
    }
    return true;
  }
  return false;
}

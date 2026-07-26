import { resolveSystemAgentDelegationKey } from "../../system-agent/delegation-session.js";
import { resolveGatewayHostedSessionOwner } from "./hosted-session-owner.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

type SystemAgentSessionMap = GatewayRequestContext["systemAgentSessions"];

type LockedWizardAdoption =
  | { kind: "none" }
  | { kind: "adopted" }
  | { kind: "ambiguous" }
  | { kind: "reset-refused" }
  | { kind: "welcome-required" };

const MAX_SYSTEM_AGENT_SESSION_ALIASES = 4;

export function deleteSystemAgentSessionAliases(
  sessions: SystemAgentSessionMap,
  target: SystemAgentSessionMap extends Map<string, infer Session> ? Session : never,
): void {
  for (const [candidateId, candidate] of sessions) {
    if (candidate === target) {
      sessions.delete(candidateId);
    }
  }
}

function listUniqueSystemAgentSessions(sessions: SystemAgentSessionMap) {
  return [...new Set(sessions.values())];
}

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
  // Ordinary auth-none chats are connection-scoped even though they cannot
  // recover across reconnects. Stable owners use continuity for recovery.
  return owner.kind === "stable"
    ? owner.continuityKey
    : owner.kind === "connection"
      ? owner.key
      : undefined;
}

/** Transfer one exact owner's retained wizard when its client rotates session ids. */
export function adoptLockedSystemAgentWizard(params: {
  sessions: SystemAgentSessionMap;
  sessionId: string;
  ownerKey: string;
  reset: boolean;
  allowAdoption: boolean;
}): LockedWizardAdoption {
  const retainedSessions = listUniqueSystemAgentSessions(params.sessions).filter(
    (candidate) =>
      candidate.ownerKey === params.ownerKey && candidate.engine.hasLockedHostedWizard(),
  );
  if (retainedSessions.length > 1) {
    return { kind: "ambiguous" };
  }
  const retainedSession = retainedSessions[0];
  if (!retainedSession) {
    return { kind: "none" };
  }
  if (params.reset) {
    return { kind: "reset-refused" };
  }
  if (!params.allowAdoption) {
    return { kind: "welcome-required" };
  }
  // A successful welcome-only request is the protocol-free recovery
  // handshake. Keep prior ids as aliases so an original tab cannot lose its
  // locked state merely because another same-owner surface reconnects.
  params.sessions.set(params.sessionId, retainedSession);
  const aliases = [...params.sessions.entries()]
    .filter(([, candidate]) => candidate === retainedSession)
    .map(([candidateId]) => candidateId);
  for (const staleAlias of aliases.slice(
    0,
    Math.max(0, aliases.length - MAX_SYSTEM_AGENT_SESSION_ALIASES),
  )) {
    params.sessions.delete(staleAlias);
  }
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
  if (existing) {
    deleteSystemAgentSessionAliases(params.sessions, existing);
  }
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
  const uniqueSessions = listUniqueSystemAgentSessions(sessions);
  if (uniqueSessions.length < maxSessions) {
    return true;
  }
  const oldestFirst = uniqueSessions.toSorted((left, right) => left.lastUsedAt - right.lastUsedAt);
  for (const session of oldestFirst) {
    if (session.engine.hasLockedHostedWizard()) {
      continue;
    }
    // Remove authority before cleanup yields so a concurrent approval callback
    // cannot pass its session-identity check while this session is retiring.
    deleteSystemAgentSessionAliases(sessions, session);
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

import { resolveSystemAgentDelegationKey } from "../../system-agent/delegation-session.js";
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
  // Prefer stable authenticated principals, then verified device and connection identity.
  const userId = params.client?.authenticatedUserId?.trim();
  if (userId) {
    return `user:${userId}`;
  }
  const deviceId = params.client?.connect.device?.id.trim();
  if (deviceId) {
    return `device:${deviceId}`;
  }
  const connId = params.client?.connId?.trim();
  return connId ? `connection:${connId}` : undefined;
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
    if (!(await session.engine.dispose())) {
      continue;
    }
    if (session.pendingApproval) {
      context.systemAgentApprovalManager?.expire(session.pendingApproval.id, "session-evicted");
    }
    sessions.delete(key);
    return true;
  }
  return false;
}

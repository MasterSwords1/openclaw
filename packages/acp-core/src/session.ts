// ACP Core module implements session behavior.
import { randomUUID } from "node:crypto";
import { resolveIntegerOption } from "@openclaw/normalization-core/number-coercion";
import type { AcpSession } from "./types.js";

export type AcpSessionStore = {
  /** Creates or refreshes an in-memory ACP session under the supplied session id. */
  createSession: (params: {
    sessionKey: string;
    cwd: string;
    sessionId?: string;
    ledgerSessionId?: string;
    runtimeOptions?: AcpSession["runtimeOptions"];
    protectedSessionIds?: ReadonlySet<string>;
  }) => AcpSession;
  hasSession: (sessionId: string) => boolean;
  getSession: (sessionId: string) => AcpSession | undefined;
  getSessionIdsByKey: (sessionKey: string) => string[];
  deleteSession: (sessionId: string) => boolean;
  clearAllSessionsForTest: () => void;
};

type AcpSessionStoreOptions = {
  maxSessions?: number;
  idleTtlMs?: number;
  now?: () => number;
};

const DEFAULT_MAX_SESSIONS = 5_000;
const DEFAULT_IDLE_TTL_MS = 24 * 60 * 60 * 1_000;

/** Creates the bounded in-memory ACP session registry used by local ACP runtime clients. */
export function createInMemorySessionStore(options: AcpSessionStoreOptions = {}): AcpSessionStore {
  const maxSessions = resolveIntegerOption(options.maxSessions, DEFAULT_MAX_SESSIONS, { min: 1 });
  const idleTtlMs = resolveIntegerOption(options.idleTtlMs, DEFAULT_IDLE_TTL_MS, { min: 1_000 });
  const now = options.now ?? Date.now;
  const sessions = new Map<string, AcpSession>();

  const touchSession = (session: AcpSession, nowMs: number) => {
    session.lastTouchedAt = nowMs;
  };

  const removeSession = (sessionId: string) => {
    return sessions.delete(sessionId);
  };

  const reapIdleSessions = (nowMs: number, protectedSessionIds: ReadonlySet<string>) => {
    const idleBefore = nowMs - idleTtlMs;
    for (const [sessionId, session] of sessions.entries()) {
      if (session.lastTouchedAt > idleBefore || protectedSessionIds.has(sessionId)) {
        continue;
      }
      removeSession(sessionId);
    }
  };

  const evictOldestSession = (protectedSessionIds: ReadonlySet<string>) => {
    let oldestSessionId: string | null = null;
    let oldestLastTouchedAt = Number.POSITIVE_INFINITY;
    for (const [sessionId, session] of sessions.entries()) {
      if (protectedSessionIds.has(sessionId) || session.lastTouchedAt >= oldestLastTouchedAt) {
        continue;
      }
      oldestLastTouchedAt = session.lastTouchedAt;
      oldestSessionId = sessionId;
    }
    if (!oldestSessionId) {
      return false;
    }
    return removeSession(oldestSessionId);
  };

  const createSession: AcpSessionStore["createSession"] = (params) => {
    const nowMs = now();
    const protectedSessionIds = params.protectedSessionIds ?? new Set<string>();
    const sessionId = params.sessionId ?? randomUUID();
    const existingSession = sessions.get(sessionId);
    if (existingSession) {
      existingSession.sessionKey = params.sessionKey;
      if ("ledgerSessionId" in params) {
        existingSession.ledgerSessionId = params.ledgerSessionId;
      }
      if ("runtimeOptions" in params) {
        existingSession.runtimeOptions = params.runtimeOptions
          ? structuredClone(params.runtimeOptions)
          : undefined;
      }
      existingSession.cwd = params.cwd;
      touchSession(existingSession, nowMs);
      return existingSession;
    }
    reapIdleSessions(nowMs, protectedSessionIds);
    if (sessions.size >= maxSessions && !evictOldestSession(protectedSessionIds)) {
      throw new Error(
        `ACP session limit reached (max ${maxSessions}). Close ACP clients and retry.`,
      );
    }
    const session: AcpSession = {
      sessionId,
      sessionKey: params.sessionKey,
      ...(params.ledgerSessionId ? { ledgerSessionId: params.ledgerSessionId } : {}),
      cwd: params.cwd,
      createdAt: nowMs,
      lastTouchedAt: nowMs,
      ...(params.runtimeOptions ? { runtimeOptions: structuredClone(params.runtimeOptions) } : {}),
    };
    sessions.set(sessionId, session);
    return session;
  };

  const hasSession: AcpSessionStore["hasSession"] = (sessionId) => sessions.has(sessionId);

  const getSession: AcpSessionStore["getSession"] = (sessionId) => {
    const session = sessions.get(sessionId);
    if (session) {
      touchSession(session, now());
    }
    return session;
  };

  const getSessionIdsByKey: AcpSessionStore["getSessionIdsByKey"] = (sessionKey) => {
    return [...sessions.values()]
      .filter((session) => session.sessionKey === sessionKey)
      .map((session) => session.sessionId);
  };

  const deleteSession: AcpSessionStore["deleteSession"] = (sessionId) => removeSession(sessionId);

  const clearAllSessionsForTest: AcpSessionStore["clearAllSessionsForTest"] = () => {
    sessions.clear();
  };

  return {
    createSession,
    hasSession,
    getSession,
    getSessionIdsByKey,
    deleteSession,
    clearAllSessionsForTest,
  };
}

export const defaultAcpSessionStore = createInMemorySessionStore();

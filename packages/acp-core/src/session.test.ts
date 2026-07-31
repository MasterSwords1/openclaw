// ACP Core tests cover session behavior.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createInMemorySessionStore } from "./session.js";

describe("acp session manager", () => {
  let nowMs = 0;
  const now = () => nowMs;
  const advance = (ms: number) => {
    nowMs += ms;
  };
  let store = createInMemorySessionStore({ now });

  beforeEach(() => {
    nowMs = 1_000;
    store = createInMemorySessionStore({ now });
  });

  afterEach(() => {
    store.clearAllSessionsForTest();
  });

  it("stores per-session runtime options without run ownership", () => {
    const session = store.createSession({
      sessionKey: "acp:test",
      cwd: "/tmp",
      runtimeOptions: { runtimeMode: "plan" },
    });

    expect(session).not.toHaveProperty("activeRunId");
    expect(session).not.toHaveProperty("abortController");
    expect(session.runtimeOptions).toEqual({ runtimeMode: "plan" });

    session.runtimeOptions = { runtimeMode: "normal", timeoutSeconds: 30 };
    expect(store.getSession(session.sessionId)?.runtimeOptions).toEqual({
      runtimeMode: "normal",
      timeoutSeconds: 30,
    });
  });

  it("deletes session bindings without owning runtime cancellation", () => {
    const session = store.createSession({
      sessionId: "close-me",
      sessionKey: "acp:close",
      cwd: "/tmp",
    });

    expect(store.deleteSession(session.sessionId)).toBe(true);

    expect(store.hasSession(session.sessionId)).toBe(false);
  });

  it("finds every public binding for a canonical session key", () => {
    store.createSession({
      sessionId: "first",
      sessionKey: "agent:main:shared",
      cwd: "/tmp",
    });
    store.createSession({
      sessionId: "second",
      sessionKey: "agent:main:shared",
      cwd: "/tmp",
    });
    store.createSession({
      sessionId: "other",
      sessionKey: "agent:main:other",
      cwd: "/tmp",
    });

    expect(store.getSessionIdsByKey("agent:main:shared")).toEqual(["first", "second"]);
  });

  it("reports false when deleting a missing session", () => {
    expect(store.deleteSession("missing")).toBe(false);
  });

  it("refreshes existing session IDs instead of creating duplicates", () => {
    const first = store.createSession({
      sessionId: "existing",
      sessionKey: "acp:one",
      cwd: "/tmp/one",
    });
    advance(500);

    const refreshed = store.createSession({
      sessionId: "existing",
      sessionKey: "acp:two",
      cwd: "/tmp/two",
    });

    expect(refreshed).toBe(first);
    expect(refreshed.sessionKey).toBe("acp:two");
    expect(refreshed.cwd).toBe("/tmp/two");
    expect(refreshed.createdAt).toBe(1_000);
    expect(refreshed.lastTouchedAt).toBe(1_500);
    expect(store.hasSession("existing")).toBe(true);
  });

  it("falls back for non-finite idle TTL options", () => {
    const boundedStore = createInMemorySessionStore({
      maxSessions: 2,
      idleTtlMs: Number.NaN,
      now,
    });
    try {
      boundedStore.createSession({
        sessionId: "first",
        sessionKey: "acp:first",
        cwd: "/tmp",
      });
      advance(1);
      boundedStore.createSession({
        sessionId: "second",
        sessionKey: "acp:second",
        cwd: "/tmp",
      });

      expect(boundedStore.hasSession("first")).toBe(true);
      expect(boundedStore.hasSession("second")).toBe(true);
    } finally {
      boundedStore.clearAllSessionsForTest();
    }
  });

  it("falls back for non-finite max session options", () => {
    const boundedStore = createInMemorySessionStore({
      maxSessions: Number.NaN,
      idleTtlMs: 24 * 60 * 60 * 1_000,
      now,
    });
    try {
      for (let index = 0; index < 5_001; index += 1) {
        boundedStore.createSession({
          sessionId: `session-${index}`,
          sessionKey: `acp:${index}`,
          cwd: "/tmp",
        });
      }

      expect(boundedStore.hasSession("session-0")).toBe(false);
      expect(boundedStore.hasSession("session-5000")).toBe(true);
    } finally {
      boundedStore.clearAllSessionsForTest();
    }
  });

  it("reaps idle sessions before enforcing the max session cap", () => {
    const boundedStore = createInMemorySessionStore({
      maxSessions: 1,
      idleTtlMs: 1_000,
      now,
    });
    try {
      boundedStore.createSession({
        sessionId: "old",
        sessionKey: "acp:old",
        cwd: "/tmp",
      });
      advance(2_000);
      const fresh = boundedStore.createSession({
        sessionId: "fresh",
        sessionKey: "acp:fresh",
        cwd: "/tmp",
      });

      expect(fresh.sessionId).toBe("fresh");
      expect(boundedStore.getSession("old")).toBeUndefined();
      expect(boundedStore.hasSession("old")).toBe(false);
    } finally {
      boundedStore.clearAllSessionsForTest();
    }
  });

  it("uses soft-cap eviction for the oldest session when full", () => {
    const boundedStore = createInMemorySessionStore({
      maxSessions: 2,
      idleTtlMs: 24 * 60 * 60 * 1_000,
      now,
    });
    try {
      const first = boundedStore.createSession({
        sessionId: "first",
        sessionKey: "acp:first",
        cwd: "/tmp",
      });
      advance(100);
      const second = boundedStore.createSession({
        sessionId: "second",
        sessionKey: "acp:second",
        cwd: "/tmp",
      });
      advance(100);

      const third = boundedStore.createSession({
        sessionId: "third",
        sessionKey: "acp:third",
        cwd: "/tmp",
      });

      expect(third.sessionId).toBe("third");
      expect(boundedStore.getSession(first.sessionId)).toBeUndefined();
      const retainedSession = boundedStore.getSession(second.sessionId);
      expect(retainedSession?.sessionId).toBe("second");
    } finally {
      boundedStore.clearAllSessionsForTest();
    }
  });

  it("evicts the oldest binding when the cap is full", () => {
    const boundedStore = createInMemorySessionStore({
      maxSessions: 1,
      idleTtlMs: 24 * 60 * 60 * 1_000,
      now,
    });
    try {
      const only = boundedStore.createSession({
        sessionId: "only",
        sessionKey: "acp:only",
        cwd: "/tmp",
      });

      const next = boundedStore.createSession({
        sessionId: "next",
        sessionKey: "acp:next",
        cwd: "/tmp",
      });

      expect(boundedStore.hasSession(only.sessionId)).toBe(false);
      expect(boundedStore.hasSession(next.sessionId)).toBe(true);
    } finally {
      boundedStore.clearAllSessionsForTest();
    }
  });

  it("never reaps or evicts a protected session binding", () => {
    const boundedStore = createInMemorySessionStore({
      maxSessions: 2,
      idleTtlMs: 1_000,
      now,
    });
    try {
      boundedStore.createSession({
        sessionId: "active",
        sessionKey: "acp:active",
        cwd: "/tmp",
      });
      advance(2_000);
      boundedStore.createSession({
        sessionId: "idle",
        sessionKey: "acp:idle",
        cwd: "/tmp",
        protectedSessionIds: new Set(["active"]),
      });
      advance(1);
      boundedStore.createSession({
        sessionId: "next",
        sessionKey: "acp:next",
        cwd: "/tmp",
        protectedSessionIds: new Set(["active"]),
      });

      expect(boundedStore.hasSession("active")).toBe(true);
      expect(boundedStore.hasSession("idle")).toBe(false);
      expect(boundedStore.hasSession("next")).toBe(true);
    } finally {
      boundedStore.clearAllSessionsForTest();
    }
  });

  it("rejects a new binding when every retained session is protected", () => {
    const boundedStore = createInMemorySessionStore({
      maxSessions: 1,
      idleTtlMs: 1_000,
      now,
    });
    try {
      boundedStore.createSession({
        sessionId: "active",
        sessionKey: "acp:active",
        cwd: "/tmp",
      });
      advance(2_000);

      expect(() =>
        boundedStore.createSession({
          sessionId: "next",
          sessionKey: "acp:next",
          cwd: "/tmp",
          protectedSessionIds: new Set(["active"]),
        }),
      ).toThrow(/session limit reached/i);
      expect(boundedStore.hasSession("active")).toBe(true);
      expect(boundedStore.hasSession("next")).toBe(false);
    } finally {
      boundedStore.clearAllSessionsForTest();
    }
  });
});

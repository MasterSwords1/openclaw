import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions/types.js";
import {
  createAcpLocalSessionRuntime,
  type AcpLocalSessionRuntimeDeps,
} from "./local-session-runtime.js";

const cfg = {
  agents: {
    list: [{ id: "main", default: true }],
  },
} as const;

function createEntry(
  sessionId: string,
  updatedAt: number,
  overrides: Partial<SessionEntry> = {},
): SessionEntry {
  return {
    sessionId,
    updatedAt,
    ...overrides,
  };
}

function createLoadedSession(
  sessionKey: string,
  entry?: SessionEntry,
): ReturnType<AcpLocalSessionRuntimeDeps["loadSession"]> {
  return {
    cfg,
    canonicalKey: sessionKey,
    entry,
    legacyKey: undefined,
    store: entry ? { [sessionKey]: entry } : {},
    storeKeys: [sessionKey],
    storePath: "/tmp/openclaw-sessions",
  } as ReturnType<AcpLocalSessionRuntimeDeps["loadSession"]>;
}

function createDeps(params?: {
  entries?: Record<string, SessionEntry>;
  loadSession?: AcpLocalSessionRuntimeDeps["loadSession"];
  patchEntry?: AcpLocalSessionRuntimeDeps["patchEntry"];
}): Partial<AcpLocalSessionRuntimeDeps> {
  const entries = params?.entries ?? {};
  return {
    getConfig: () => cfg,
    loadCombinedStore: () =>
      ({
        storePath: "/tmp/openclaw-sessions",
        store: entries,
      }) as ReturnType<AcpLocalSessionRuntimeDeps["loadCombinedStore"]>,
    loadSession:
      params?.loadSession ?? ((sessionKey) => createLoadedSession(sessionKey, entries[sessionKey])),
    patchEntry:
      params?.patchEntry ??
      (vi.fn(async (_scope, update) => {
        const entry = createEntry("patched", 1);
        const patch = await update(entry, { existingEntry: entry });
        return patch ? { ...entry, ...patch } : null;
      }) as AcpLocalSessionRuntimeDeps["patchEntry"]),
    createId: vi.fn().mockReturnValueOnce("new-session").mockReturnValue("new-lifecycle"),
    now: () => 5_000,
  };
}

describe("ACP local session runtime", () => {
  it("resolves explicit labels before keys and defaults", async () => {
    const runtime = createAcpLocalSessionRuntime(
      { defaultSessionKey: "agent:main:default" },
      createDeps({
        entries: {
          "agent:main:support": createEntry("support-id", 10, { label: "support" }),
        },
      }),
    );

    await expect(
      runtime.resolveSessionKey({
        meta: {
          sessionLabel: "support",
          sessionKey: "agent:main:ignored",
        },
        fallbackKey: "fallback",
      }),
    ).resolves.toBe("agent:main:support");
  });

  it("canonicalizes explicit and fallback keys and enforces require-existing", async () => {
    const runtime = createAcpLocalSessionRuntime({}, createDeps());

    await expect(
      runtime.resolveSessionKey({
        meta: { sessionKey: "work" },
        fallbackKey: "fallback",
      }),
    ).resolves.toBe("agent:main:work");
    await expect(
      runtime.resolveSessionKey({
        meta: {},
        fallbackKey: "fallback",
      }),
    ).resolves.toBe("agent:main:fallback");
    await expect(
      runtime.resolveSessionKey({
        meta: { requireExisting: true },
        fallbackKey: "missing",
      }),
    ).rejects.toThrow("Session key not found: missing");
    await expect(
      runtime.resolveSessionKey({
        meta: { sessionKey: "missing", requireExisting: true },
        fallbackKey: "fallback",
      }),
    ).rejects.toThrow("Session key not found: missing");
  });

  it("applies requested resets through canonical lifecycle storage", async () => {
    const resetSession = vi.fn(async () => ({
      archivedTranscripts: [],
      nextEntry: createEntry("unused", 0),
    }));
    const current = createEntry("session-1", 100, {
      thinkingLevel: "high",
      status: "failed",
      lastRunError: "old failure",
      totalTokens: 900,
      totalTokensFresh: true,
      contextTokens: 1_000,
    });
    const runtime = createAcpLocalSessionRuntime(
      {},
      {
        ...createDeps({
          loadSession: () => createLoadedSession("agent:main:work", current),
        }),
        resetSession,
      },
    );

    await runtime.resetSessionIfNeeded({
      meta: { resetSession: true },
      sessionKey: "agent:main:work",
      cwd: "/workspace/project",
    });

    expect(resetSession).toHaveBeenCalledOnce();
    const params = resetSession.mock.calls[0]?.[0];
    expect(params).toMatchObject({
      agentId: "main",
      archivePreviousTranscript: false,
      resetBoundaryReason: "reset",
      storePath: "/tmp/openclaw-sessions",
      target: {
        canonicalKey: "agent:main:work",
        storeKeys: ["agent:main:work"],
      },
    });
    const nextEntry = await params?.buildNextEntry({
      currentEntry: current,
      primaryKey: "agent:main:work",
    });
    expect(nextEntry).toEqual(
      expect.objectContaining({
        sessionId: "session-1",
        lifecycleRevision: "new-session",
        updatedAt: 5_000,
        thinkingLevel: "high",
        spawnedCwd: "/workspace/project",
        systemSent: false,
        abortedLastRun: false,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        totalTokensFresh: true,
      }),
    );
    expect(nextEntry).not.toHaveProperty("status");
    expect(nextEntry).not.toHaveProperty("contextTokens");
  });

  it("loads snapshots with local overrides and requires existing rows when requested", async () => {
    const entry = createEntry("session-1", 1_000, {
      displayName: "Work",
      thinkingLevel: "low",
      totalTokens: 25,
      totalTokensFresh: true,
      contextTokens: 100,
    });
    const runtime = createAcpLocalSessionRuntime(
      {},
      createDeps({
        loadSession: (sessionKey) =>
          createLoadedSession(sessionKey, sessionKey.endsWith("work") ? entry : undefined),
      }),
    );

    const snapshot = await runtime.getSessionSnapshot("agent:main:work", {
      thinkingLevel: "high",
      timeoutSeconds: 45,
    });
    expect(snapshot.metadata?.title).toBe("Work");
    expect(snapshot.modes.currentModeId).toBe("high");
    expect(snapshot.configOptions).toContainEqual(
      expect.objectContaining({
        id: "timeout_seconds",
        currentValue: "45",
      }),
    );
    expect(snapshot.usage).toEqual({ size: 100, used: 25 });

    const existingSnapshot = await runtime.getExistingSessionSnapshot("agent:main:work", {
      timeoutSeconds: 60,
    });
    expect(existingSnapshot.configOptions).toContainEqual(
      expect.objectContaining({
        id: "timeout_seconds",
        currentValue: "60",
      }),
    );

    await expect(runtime.getExistingSessionSnapshot("agent:main:missing")).rejects.toThrow(
      "Session agent:main:missing not found",
    );
  });

  it("lists bounded cwd-filtered sessions in recent-first order", async () => {
    const runtime = createAcpLocalSessionRuntime(
      {},
      createDeps({
        entries: {
          "agent:main:older": createEntry("older", 10, {
            displayName: "Older",
            spawnedCwd: "/repo",
          }),
          "agent:main:newer": createEntry("newer", 20, {
            label: "Newer",
            spawnedCwd: "/repo",
          }),
          "agent:main:spaced": createEntry("spaced", 25, {
            spawnedCwd: "/repo ",
          }),
          "agent:main:other": createEntry("other", 30, {
            spawnedCwd: "/other",
          }),
          global: createEntry("global", 40),
        },
      }),
    );

    await expect(
      runtime.listSessions({
        cwd: "/repo",
        offset: 0,
        limit: 1,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        sessionId: "agent:main:newer",
        cwd: "/repo",
        title: "Newer",
      }),
    ]);
    await expect(
      runtime.listSessions({
        cwd: "/repo ",
        offset: 0,
        limit: 10,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        sessionId: "agent:main:spaced",
        cwd: "/repo ",
      }),
    ]);
  });

  it("does not treat the requested cwd as missing-session workspace metadata", async () => {
    const runtime = createAcpLocalSessionRuntime(
      {},
      createDeps({
        entries: {
          "agent:main:unknown-cwd": createEntry("unknown-cwd", 10),
        },
      }),
    );

    await expect(
      runtime.listSessions({
        cwd: process.cwd(),
        offset: 0,
        limit: 10,
      }),
    ).resolves.toEqual([]);
  });

  it("patches ACP presentation fields through the canonical session accessor", async () => {
    const current = createEntry("session-1", 100, {
      responseUsage: "full",
      traceLevel: "off",
    });
    const patchEntry = vi.fn(async (_scope, update, options) => {
      const replacement = await update(current, { existingEntry: current });
      expect(options).toEqual({
        replaceEntry: true,
        skipMaintenance: true,
      });
      return replacement ? ({ ...current, ...replacement } as SessionEntry) : null;
    });
    const runtime = createAcpLocalSessionRuntime(
      {},
      createDeps({
        loadSession: () => createLoadedSession("agent:main:work", current),
        patchEntry,
      }),
    );

    const snapshot = await runtime.patchSession(
      "agent:main:work",
      {
        thinkingLevel: "mid",
        fastMode: "auto",
        verboseLevel: "full",
        traceLevel: "raw",
        reasoningLevel: "streaming",
        responseUsage: null,
        elevatedLevel: "ask",
      },
      { timeoutSeconds: 75 },
    );

    expect(patchEntry).toHaveBeenCalledWith(
      {
        agentId: "main",
        storePath: "/tmp/openclaw-sessions",
        target: {
          canonicalKey: "agent:main:work",
          storeKeys: ["agent:main:work"],
        },
      },
      expect.any(Function),
      {
        replaceEntry: true,
        skipMaintenance: true,
      },
    );
    const replacement = await patchEntry.mock.calls[0]?.[1](current, {
      existingEntry: current,
    });
    expect(replacement).toMatchObject({
      thinkingLevel: "medium",
      fastMode: "auto",
      verboseLevel: "full",
      traceLevel: "raw",
      reasoningLevel: "stream",
      elevatedLevel: "ask",
      updatedAt: 5_000,
    });
    expect(replacement).not.toHaveProperty("responseUsage");
    expect(snapshot.modes.currentModeId).toBe("medium");
    expect(snapshot.configOptions).toContainEqual(
      expect.objectContaining({
        id: "timeout_seconds",
        currentValue: "75",
      }),
    );
  });

  it("creates a canonical session row when controls are set before the first prompt", async () => {
    const patchEntry = vi.fn(async (_scope, update, options) => {
      const fallbackEntry = options?.fallbackEntry as SessionEntry | undefined;
      expect(fallbackEntry).toMatchObject({
        sessionId: "new-session",
        totalTokens: 0,
        totalTokensFresh: true,
      });
      if (!fallbackEntry) {
        return null;
      }
      return await update(fallbackEntry, { existingEntry: undefined });
    });
    const runtime = createAcpLocalSessionRuntime(
      {},
      createDeps({
        loadSession: () => createLoadedSession("agent:main:new"),
        patchEntry,
      }),
    );

    const snapshot = await runtime.patchSession(
      "agent:main:new",
      {
        thinkingLevel: "high",
      },
      { spawnedCwd: "/workspace/project" },
    );

    expect(snapshot.modes.currentModeId).toBe("high");
    expect(patchEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.objectContaining({ canonicalKey: "agent:main:new" }),
      }),
      expect.any(Function),
      expect.objectContaining({
        fallbackEntry: expect.objectContaining({
          sessionId: "new-session",
          spawnedCwd: "/workspace/project",
        }),
        replaceEntry: true,
        skipMaintenance: true,
      }),
    );
  });

  it("rejects invalid durable presentation patches before writing a replacement", async () => {
    const current = createEntry("session-1", 100);
    const patchEntry = vi.fn(async (_scope, update) => {
      await update(current, { existingEntry: current });
      return current;
    });
    const runtime = createAcpLocalSessionRuntime(
      {},
      createDeps({
        loadSession: () => createLoadedSession("agent:main:work", current),
        patchEntry,
      }),
    );

    await expect(
      runtime.patchSession("agent:main:work", { reasoningLevel: "banana" }),
    ).rejects.toThrow('invalid reasoningLevel (use "on"|"off"|"stream")');
  });

  it("loads bounded active transcript messages without exposing storage events", async () => {
    const readTranscriptEvents = vi.fn(() => ({
      events: [
        { seq: 1, event: { type: "message", message: { role: "user", content: "hello" } } },
        { seq: 2, event: { type: "control", reason: "reset" } },
        {
          seq: 3,
          event: { type: "message", message: { role: "assistant", content: "hi" } },
        },
      ],
      totalMessages: 2,
    }));
    const entry = createEntry("session-1", 100);
    const runtime = createAcpLocalSessionRuntime(
      {},
      {
        ...createDeps({
          loadSession: () => createLoadedSession("agent:main:work", entry),
        }),
        readTranscriptEvents,
      },
    );

    await expect(runtime.getSessionTranscript("agent:main:work")).resolves.toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ]);
    expect(readTranscriptEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "main",
        sessionId: "session-1",
        sessionKey: "agent:main:work",
      }),
      {
        maxBytes: 8 * 1024 * 1024,
        maxLines: 4_020,
        maxMessages: 200,
      },
    );
  });

  it("keeps the local runtime independent from Gateway modules and protocol types", () => {
    const source = readFileSync(new URL("./local-session-runtime.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/src\/gateway|packages\/gateway-protocol|\.\.\/gateway\//);
  });
});

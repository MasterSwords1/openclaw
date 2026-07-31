/** Tests process-local AcpAgent session lifecycle and control behavior. */
import type {
  AgentSideConnection,
  ListSessionsRequest,
  SessionInfo,
  SessionUpdate,
} from "@agentclientprotocol/sdk";
import { createInMemorySessionStore } from "@openclaw/acp-core/session";
import type { AcpSessionStore } from "@openclaw/acp-core/session";
import { describe, expect, it, vi } from "vitest";
import { AcpAgent, type AcpAgentOptions } from "./agent.js";
import { createInMemoryAcpEventLedger, type AcpEventLedger } from "./event-ledger.js";
import type { AcpLocalSessionPatch, AcpLocalSessionRuntime } from "./local-session-runtime.js";
import type { SessionSnapshot } from "./translator.presentation.js";

vi.mock("./commands.js", () => ({
  getAvailableCommands: () => [],
}));

const cwd = "/tmp/openclaw-acp-sessions";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function snapshot(
  params: {
    mode?: string;
    fastMode?: string;
    verbose?: string;
    timeout?: string;
    title?: string;
  } = {},
): SessionSnapshot {
  const mode = params.mode ?? "adaptive";
  return {
    configOptions: [
      {
        type: "select",
        id: "thought_level",
        name: "Thought level",
        currentValue: mode,
        options: [{ value: mode, name: mode }],
      },
      {
        type: "select",
        id: "fast_mode",
        name: "Fast mode",
        currentValue: params.fastMode ?? "off",
        options: [
          { value: "off", name: "Off" },
          { value: "on", name: "On" },
        ],
      },
      {
        type: "select",
        id: "verbose_level",
        name: "Tool verbosity",
        currentValue: params.verbose ?? "off",
        options: [
          { value: "off", name: "Off" },
          { value: "full", name: "Full" },
        ],
      },
      {
        type: "select",
        id: "timeout_seconds",
        name: "Turn timeout",
        currentValue: params.timeout ?? "inherit",
        options: [{ value: params.timeout ?? "inherit", name: params.timeout ?? "Inherit" }],
      },
    ],
    modes: {
      currentModeId: mode,
      availableModes: [{ id: mode, name: mode }],
    },
    metadata: {
      title: params.title ?? "Local session",
      updatedAt: "2026-07-31T12:00:00.000Z",
      _meta: {
        sessionKey: "agent:main:work",
        kind: "direct",
      },
    },
    usage: {
      used: 20,
      size: 100,
    },
  };
}

function createConnection(sessionUpdate?: AgentSideConnection["sessionUpdate"]) {
  const updates: Array<{ sessionId: string; update: SessionUpdate }> = [];
  const connection = {
    requestPermission: vi.fn(),
    sessionUpdate:
      sessionUpdate ??
      vi.fn(async (params: { sessionId: string; update: SessionUpdate }) => {
        updates.push(params);
      }),
  } as unknown as AgentSideConnection;
  return { connection, updates };
}

function createRuntime(overrides: Partial<AcpLocalSessionRuntime> = {}): AcpLocalSessionRuntime {
  return {
    resolveSessionKey: vi.fn(async ({ fallbackKey }) => fallbackKey),
    resetSessionIfNeeded: vi.fn(async () => {}),
    getSessionSnapshot: vi.fn(async () => snapshot()),
    getExistingSessionSnapshot: vi.fn(async () => snapshot()),
    patchSession: vi.fn(async () => snapshot()),
    listSessions: vi.fn(async () => []),
    getSessionTranscript: vi.fn(async () => []),
    ...overrides,
  };
}

function createHarness(
  options: Partial<AcpAgentOptions> & {
    eventLedger?: AcpEventLedger;
    sessionRuntime?: AcpLocalSessionRuntime;
    sessionStore?: AcpSessionStore;
    sessionUpdate?: AgentSideConnection["sessionUpdate"];
  } = {},
) {
  const { connection, updates } = createConnection(options.sessionUpdate);
  const eventLedger = options.eventLedger ?? createInMemoryAcpEventLedger();
  const sessionRuntime = options.sessionRuntime ?? createRuntime();
  const sessionStore = options.sessionStore ?? createInMemorySessionStore();
  const agent = new AcpAgent(connection, {
    ...options,
    eventLedger,
    sessionRuntime,
    sessionStore,
  });
  return { agent, eventLedger, sessionRuntime, sessionStore, updates };
}

function updateTypes(updates: Array<{ update: SessionUpdate }>): string[] {
  return updates.map(({ update }) => update.sessionUpdate);
}

describe("AcpAgent process-local sessions", () => {
  it("advertises model-only terminal authentication to capable clients", async () => {
    const { agent } = createHarness();

    await expect(
      agent.initialize({
        protocolVersion: 1,
        clientCapabilities: { auth: { terminal: true } },
      }),
    ).resolves.toMatchObject({
      authMethods: [
        {
          id: "openclaw-model-setup",
          name: "Configure OpenClaw model",
          type: "terminal",
          args: ["--configure-model"],
        },
      ],
    });
  });

  it("omits terminal authentication when the client cannot launch it", async () => {
    const { agent } = createHarness();

    await expect(
      agent.initialize({
        protocolVersion: 1,
        clientCapabilities: { auth: { terminal: false } },
      }),
    ).resolves.toMatchObject({ authMethods: [] });
  });

  it("creates a routed local session and records its initial metadata for replay", async () => {
    const sessionRuntime = createRuntime({
      resolveSessionKey: vi.fn(async () => "agent:main:work"),
      getSessionSnapshot: vi.fn(async () => snapshot({ mode: "high", title: "Work" })),
      listSessions: vi.fn(async () => [{ sessionId: "agent:main:work", cwd, title: "Work" }]),
    });
    const { agent, eventLedger, sessionStore, updates } = createHarness({ sessionRuntime });

    const result = await agent.newSession({
      cwd,
      mcpServers: [],
      _meta: {
        sessionKey: "work",
        resetSession: true,
      },
    });

    expect(result.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(result.modes.currentModeId).toBe("high");
    expect(sessionRuntime.resolveSessionKey).toHaveBeenCalledWith({
      meta: {
        sessionKey: "work",
        resetSession: true,
        sessionLabel: undefined,
        requireExisting: undefined,
        prefixCwd: undefined,
      },
      fallbackKey: result.sessionId,
    });
    expect(sessionRuntime.resetSessionIfNeeded).toHaveBeenCalledWith({
      meta: expect.objectContaining({
        sessionKey: "work",
        resetSession: true,
      }),
      sessionKey: "agent:main:work",
      cwd,
    });
    expect(sessionStore.getSession(result.sessionId)).toMatchObject({
      sessionId: result.sessionId,
      sessionKey: "agent:main:work",
      cwd,
    });
    expect(updateTypes(updates)).toEqual([
      "session_info_update",
      "usage_update",
      "available_commands_update",
    ]);

    const replay = await eventLedger.readReplay({
      sessionId: result.sessionId,
      sessionKey: "agent:main:work",
    });
    expect(replay.complete).toBe(true);
    expect(replay.events.map((event) => event.update.sessionUpdate)).toEqual([
      "session_info_update",
      "usage_update",
      "available_commands_update",
    ]);

    await expect(agent.listSessions({ cwd, cursor: null, _meta: {} })).resolves.toMatchObject({
      sessions: [{ sessionId: result.sessionId, cwd, title: "Work" }],
      nextCursor: null,
    });
  });

  it("rolls back registry and replay state when new-session initialization fails", async () => {
    let generatedSessionId = "";
    const resolveSessionKey = vi.fn(async ({ fallbackKey }: { fallbackKey: string }) => {
      generatedSessionId = fallbackKey;
      return fallbackKey;
    });
    const eventLedger = createInMemoryAcpEventLedger();
    const sessionStore = createInMemorySessionStore();
    const sessionRuntime = createRuntime({
      resolveSessionKey,
      getSessionSnapshot: vi.fn(async () => {
        throw new Error("snapshot unavailable");
      }),
    });
    const { agent } = createHarness({ eventLedger, sessionRuntime, sessionStore });

    await expect(agent.newSession({ cwd, mcpServers: [], _meta: {} })).rejects.toThrow(
      "snapshot unavailable",
    );

    expect(generatedSessionId).not.toBe("");
    expect(sessionStore.hasSession(generatedSessionId)).toBe(false);
    await expect(
      eventLedger.readReplayBySessionId({ sessionId: generatedSessionId }),
    ).resolves.toEqual({
      complete: false,
      events: [],
    });
  });

  it("keeps a committed reset binding when new-session delivery cannot complete", async () => {
    let generatedSessionId = "";
    const resetSessionIfNeeded = vi.fn(async () => {});
    const sessionRuntime = createRuntime({
      resolveSessionKey: vi.fn(async ({ fallbackKey }: { fallbackKey: string }) => {
        generatedSessionId = fallbackKey;
        return "agent:main:reset-new";
      }),
      resetSessionIfNeeded,
      getSessionSnapshot: vi.fn(async () => {
        throw new Error("snapshot unavailable");
      }),
    });
    const { agent, eventLedger, sessionStore } = createHarness({ sessionRuntime });

    await expect(
      agent.newSession({
        cwd,
        mcpServers: [],
        _meta: { resetSession: true },
      }),
    ).rejects.toThrow("snapshot unavailable");

    expect(resetSessionIfNeeded).toHaveBeenCalledTimes(1);
    expect(sessionStore.getSession(generatedSessionId)).toMatchObject({
      sessionKey: "agent:main:reset-new",
    });
    await expect(
      eventLedger.readReplayBySessionId({ sessionId: generatedSessionId }),
    ).resolves.toMatchObject({
      complete: true,
      sessionKey: "agent:main:reset-new",
    });
  });

  it("loads an issued session id after restart without replay metadata", async () => {
    const resolveSessionKey = vi.fn(
      async ({ fallbackKey }: { fallbackKey: string }) => `agent:main:${fallbackKey}`,
    );
    const first = createHarness({
      sessionRuntime: createRuntime({ resolveSessionKey }),
    });
    const created = await first.agent.newSession({
      cwd,
      mcpServers: [],
      _meta: {},
    });

    const getExistingSessionSnapshot = vi.fn(async () => snapshot({ title: "Restarted" }));
    const second = createHarness({
      eventLedger: createInMemoryAcpEventLedger(),
      sessionStore: createInMemorySessionStore(),
      sessionRuntime: createRuntime({
        resolveSessionKey,
        getExistingSessionSnapshot,
      }),
    });

    await second.agent.loadSession({
      sessionId: created.sessionId,
      cwd,
      mcpServers: [],
      _meta: {},
    });

    expect(resolveSessionKey).toHaveBeenLastCalledWith({
      meta: expect.any(Object),
      fallbackKey: created.sessionId,
    });
    expect(getExistingSessionSnapshot).toHaveBeenCalledWith(
      `agent:main:${created.sessionId}`,
      expect.any(Object),
    );
  });

  it("loads complete ledger replay without reading the local transcript", async () => {
    const eventLedger = createInMemoryAcpEventLedger();
    await eventLedger.startSession({
      sessionId: "acp-session",
      sessionKey: "agent:main:work",
      cwd,
      complete: true,
    });
    await eventLedger.recordUpdate({
      sessionId: "acp-session",
      sessionKey: "agent:main:work",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "ledger answer" },
      },
    });
    const sessionRuntime = createRuntime({
      resolveSessionKey: vi.fn(async () => "agent:main:work"),
      getSessionTranscript: vi.fn(async () => {
        throw new Error("complete ledger replay must not read the transcript");
      }),
      getSessionSnapshot: vi.fn(async () => snapshot({ title: "Replayed work" })),
    });
    const { agent, sessionStore, updates } = createHarness({ eventLedger, sessionRuntime });

    await agent.loadSession({
      sessionId: "acp-session",
      cwd,
      mcpServers: [],
      _meta: {},
    });

    expect(sessionRuntime.getSessionTranscript).not.toHaveBeenCalled();
    expect(sessionStore.getSession("acp-session")).toMatchObject({
      sessionKey: "agent:main:work",
      ledgerSessionId: "acp-session",
    });
    expect(updateTypes(updates)).toEqual([
      "agent_message_chunk",
      "session_info_update",
      "usage_update",
      "available_commands_update",
    ]);
  });

  it("falls back to local transcript replay and emits local metadata on load", async () => {
    const sessionRuntime = createRuntime({
      resolveSessionKey: vi.fn(async () => "agent:main:work"),
      getSessionTranscript: vi.fn(async () => [
        { role: "user", content: "Question" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Private thought" },
            { type: "text", text: "Answer" },
          ],
        },
      ]),
      getSessionSnapshot: vi.fn(async () => snapshot({ mode: "medium", title: "Stored work" })),
      getExistingSessionSnapshot: vi.fn(async () =>
        snapshot({ mode: "medium", title: "Stored work" }),
      ),
    });
    const { agent, updates } = createHarness({ sessionRuntime });

    const result = await agent.loadSession({
      sessionId: "agent:main:work",
      cwd,
      mcpServers: [],
      _meta: {},
    });

    expect(result.modes.currentModeId).toBe("medium");
    expect(updateTypes(updates)).toEqual([
      "user_message_chunk",
      "agent_thought_chunk",
      "agent_message_chunk",
      "session_info_update",
      "usage_update",
      "available_commands_update",
    ]);
    expect(updates).toContainEqual({
      sessionId: "agent:main:work",
      update: {
        sessionUpdate: "session_info_update",
        title: "Stored work",
        updatedAt: "2026-07-31T12:00:00.000Z",
        _meta: {
          sessionKey: "agent:main:work",
          kind: "direct",
        },
      },
    });
  });

  it("rejects load when the local transcript cannot be read", async () => {
    const sessionRuntime = createRuntime({
      resolveSessionKey: vi.fn(async () => "agent:main:recover"),
      getSessionTranscript: vi.fn(async () => {
        throw new Error("transcript unavailable");
      }),
    });
    const { agent, sessionStore, updates } = createHarness({ sessionRuntime });

    await expect(
      agent.loadSession({
        sessionId: "agent:main:recover",
        cwd,
        mcpServers: [],
        _meta: {},
      }),
    ).rejects.toThrow("transcript unavailable");
    expect(sessionStore.hasSession("agent:main:recover")).toBe(false);
    expect(updates).toEqual([]);
  });

  it("rejects load when neither canonical state nor complete replay exists", async () => {
    const getSessionTranscript = vi.fn(async () => []);
    const sessionRuntime = createRuntime({
      getExistingSessionSnapshot: vi.fn(async () => {
        throw new Error("Session agent:main:missing not found");
      }),
      getSessionTranscript,
    });
    const { agent, sessionStore, updates } = createHarness({ sessionRuntime });

    await expect(
      agent.loadSession({
        sessionId: "agent:main:missing",
        cwd,
        mcpServers: [],
        _meta: {},
      }),
    ).rejects.toThrow("Session agent:main:missing not found");
    expect(getSessionTranscript).not.toHaveBeenCalled();
    expect(sessionStore.hasSession("agent:main:missing")).toBe(false);
    expect(updates).toEqual([]);
  });

  it("preserves the canonical key from an incomplete exact replay", async () => {
    const eventLedger = createInMemoryAcpEventLedger();
    await eventLedger.startSession({
      sessionId: "acp-uuid",
      sessionKey: "agent:main:canonical",
      cwd,
      complete: true,
    });
    await eventLedger.markIncomplete({
      sessionId: "acp-uuid",
      sessionKey: "agent:main:canonical",
    });
    const resolveSessionKey = vi.fn(async ({ fallbackKey }) => fallbackKey);
    const getSessionTranscript = vi.fn(async () => []);
    const sessionRuntime = createRuntime({
      resolveSessionKey,
      getSessionTranscript,
    });
    const { agent, sessionStore } = createHarness({ eventLedger, sessionRuntime });

    await agent.loadSession({
      sessionId: "acp-uuid",
      cwd,
      mcpServers: [],
      _meta: {},
    });

    expect(resolveSessionKey).toHaveBeenCalledWith({
      meta: expect.any(Object),
      fallbackKey: "agent:main:canonical",
    });
    expect(getSessionTranscript).toHaveBeenCalledWith("agent:main:canonical");
    expect(sessionStore.getSession("acp-uuid")?.sessionKey).toBe("agent:main:canonical");
  });

  it("resets ACP replay state instead of restoring pre-reset events", async () => {
    const eventLedger = createInMemoryAcpEventLedger();
    await eventLedger.startSession({
      sessionId: "reset-load",
      sessionKey: "agent:main:reset-load",
      cwd,
      complete: true,
    });
    await eventLedger.recordUpdate({
      sessionId: "reset-load",
      sessionKey: "agent:main:reset-load",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "stale answer" },
      },
    });
    const resetSessionIfNeeded = vi.fn(async () => {});
    const sessionRuntime = createRuntime({
      resolveSessionKey: vi.fn(async () => "agent:main:reset-load"),
      resetSessionIfNeeded,
    });
    const { agent, updates } = createHarness({ eventLedger, sessionRuntime });

    await agent.loadSession({
      sessionId: "reset-load",
      cwd,
      mcpServers: [],
      _meta: { resetSession: true },
    });

    expect(resetSessionIfNeeded).toHaveBeenCalledWith({
      meta: expect.objectContaining({ resetSession: true }),
      sessionKey: "agent:main:reset-load",
      cwd,
    });
    expect(
      updates.some(
        ({ update }) =>
          update.sessionUpdate === "agent_message_chunk" &&
          update.content.type === "text" &&
          update.content.text === "stale answer",
      ),
    ).toBe(false);
    const replay = await eventLedger.readReplay({
      sessionId: "reset-load",
      sessionKey: "agent:main:reset-load",
    });
    expect(replay.complete).toBe(true);
    expect(replay.events.map(({ update }) => update.sessionUpdate)).toEqual([
      "session_info_update",
      "usage_update",
    ]);
    expect(
      replay.events.some(
        ({ update }) =>
          update.sessionUpdate === "agent_message_chunk" &&
          update.content.type === "text" &&
          update.content.text === "stale answer",
      ),
    ).toBe(false);
  });

  it("allows explicit reset to initialize a missing load target", async () => {
    const resetSessionIfNeeded = vi.fn(async () => {});
    const getExistingSessionSnapshot = vi.fn(async () => {
      throw new Error("missing target must be created by reset");
    });
    const sessionRuntime = createRuntime({
      resolveSessionKey: vi.fn(async () => "agent:main:reset-created"),
      resetSessionIfNeeded,
      getExistingSessionSnapshot,
      getSessionSnapshot: vi.fn(async () => snapshot({ title: "Reset target" })),
    });
    const { agent, sessionStore } = createHarness({ sessionRuntime });

    await expect(
      agent.loadSession({
        sessionId: "agent:main:reset-created",
        cwd,
        mcpServers: [],
        _meta: { resetSession: true },
      }),
    ).resolves.toBeDefined();

    expect(getExistingSessionSnapshot).not.toHaveBeenCalled();
    expect(resetSessionIfNeeded).toHaveBeenCalledWith({
      meta: expect.objectContaining({ resetSession: true }),
      sessionKey: "agent:main:reset-created",
      cwd,
    });
    expect(sessionStore.hasSession("agent:main:reset-created")).toBe(true);
  });

  it("resumes existing local state without replaying transcript history", async () => {
    const sessionRuntime = createRuntime({
      resolveSessionKey: vi.fn(async () => "agent:main:work"),
      getExistingSessionSnapshot: vi.fn(async () =>
        snapshot({ mode: "low", title: "Resumed work" }),
      ),
      getSessionTranscript: vi.fn(async () => {
        throw new Error("resume must not read transcript history");
      }),
    });
    const { agent, sessionStore, updates } = createHarness({ sessionRuntime });

    const result = await agent.resumeSession({
      sessionId: "resume-session",
      cwd,
      mcpServers: [],
      _meta: { sessionKey: "work" },
    });

    expect(result.modes.currentModeId).toBe("low");
    expect(sessionRuntime.getExistingSessionSnapshot).toHaveBeenCalledWith(
      "agent:main:work",
      expect.any(Object),
    );
    expect(sessionRuntime.getSessionTranscript).not.toHaveBeenCalled();
    expect(sessionStore.getSession("resume-session")).toMatchObject({
      sessionKey: "agent:main:work",
      cwd,
    });
    expect(updateTypes(updates)).toEqual([
      "session_info_update",
      "usage_update",
      "available_commands_update",
    ]);
  });

  it("resolves a listed ACP session id back to its canonical key on cold resume", async () => {
    const eventLedger = createInMemoryAcpEventLedger();
    await eventLedger.startSession({
      sessionId: "listed-acp-id",
      sessionKey: "agent:main:listed",
      cwd,
      complete: true,
    });
    const resolveSessionKey = vi.fn(
      async ({ fallbackKey }: { fallbackKey: string }) => fallbackKey,
    );
    const getExistingSessionSnapshot = vi.fn(async () => snapshot({ title: "Listed session" }));
    const sessionRuntime = createRuntime({
      resolveSessionKey,
      getExistingSessionSnapshot,
      listSessions: vi.fn(async () => [
        { sessionId: "agent:main:listed", cwd, title: "Listed session" },
      ]),
    });
    const sessionStore = createInMemorySessionStore();
    sessionStore.createSession({
      sessionId: "listed-acp-id",
      sessionKey: "agent:main:listed",
      cwd,
    });
    const { agent } = createHarness({ eventLedger, sessionRuntime, sessionStore });

    await agent.closeSession({ sessionId: "listed-acp-id", _meta: {} });
    const listed = await agent.listSessions({ cwd, cursor: null, _meta: {} });
    expect(listed.sessions[0]?.sessionId).toBe("listed-acp-id");

    await agent.resumeSession({
      sessionId: listed.sessions[0]?.sessionId ?? "",
      cwd,
      mcpServers: [],
      _meta: {},
    });

    expect(resolveSessionKey).toHaveBeenCalledWith({
      meta: expect.any(Object),
      fallbackKey: "agent:main:listed",
    });
    expect(getExistingSessionSnapshot).toHaveBeenCalledWith(
      "agent:main:listed",
      expect.any(Object),
    );
  });

  it("never exposes a ledger id that is bound live to a different listed session", async () => {
    const eventLedger = createInMemoryAcpEventLedger();
    await eventLedger.startSession({
      sessionId: "stable",
      sessionKey: "agent:main:old",
      cwd,
      complete: true,
    });
    await eventLedger.startSession({
      sessionId: "new-ledger",
      sessionKey: "agent:main:new",
      cwd,
      complete: true,
    });
    const sessionStore = createInMemorySessionStore();
    sessionStore.createSession({
      sessionId: "stable",
      sessionKey: "agent:main:new",
      ledgerSessionId: "new-ledger",
      cwd,
    });
    const resolveSessionKey = vi.fn(
      async ({ fallbackKey }: { fallbackKey: string }) => fallbackKey,
    );
    const sessionRuntime = createRuntime({
      resolveSessionKey,
      listSessions: vi.fn(async () => [
        { sessionId: "agent:main:old", cwd, title: "Old" },
        { sessionId: "agent:main:new", cwd, title: "New" },
      ]),
    });
    const { agent } = createHarness({ eventLedger, sessionRuntime, sessionStore });

    const listed = await agent.listSessions({ cwd, cursor: null, _meta: {} });

    expect(listed.sessions.map(({ sessionId }) => sessionId)).toEqual(["agent:main:old", "stable"]);
    await expect(
      agent.resumeSession({
        sessionId: "agent:main:old",
        cwd,
        mcpServers: [],
        _meta: {},
      }),
    ).resolves.toBeDefined();
    await expect(
      agent.resumeSession({
        sessionId: "stable",
        cwd,
        mcpServers: [],
        _meta: {},
      }),
    ).resolves.toBeDefined();
    expect(resolveSessionKey).toHaveBeenCalledWith({
      meta: expect.any(Object),
      fallbackKey: "agent:main:old",
    });
    expect(resolveSessionKey).toHaveBeenCalledWith({
      meta: expect.any(Object),
      fallbackKey: "agent:main:new",
    });
  });

  it.each(["load", "resume"] as const)(
    "rejects session/%s attempts to rebind a public id across canonical keys",
    async (method) => {
      const eventLedger = createInMemoryAcpEventLedger();
      await eventLedger.startSession({
        sessionId: "stable",
        sessionKey: "agent:main:old",
        cwd,
        complete: true,
      });
      const sessionStore = createInMemorySessionStore();
      sessionStore.createSession({
        sessionId: "stable",
        sessionKey: "agent:main:old",
        cwd,
      });
      const sessionRuntime = createRuntime({
        resolveSessionKey: vi.fn(async () => "agent:main:new"),
      });
      const { agent } = createHarness({ eventLedger, sessionRuntime, sessionStore });
      const request = {
        sessionId: "stable",
        cwd,
        mcpServers: [],
        _meta: { sessionKey: "new" },
      };

      await expect(
        method === "load" ? agent.loadSession(request) : agent.resumeSession(request),
      ).rejects.toThrow(
        "ACP session stable is already bound to agent:main:old; create or select a different ACP session for agent:main:new.",
      );

      expect(sessionStore.getSession("stable")).toMatchObject({
        sessionKey: "agent:main:old",
      });
      await expect(
        eventLedger.readReplayBySessionId({ sessionId: "stable" }),
      ).resolves.toMatchObject({
        sessionKey: "agent:main:old",
      });
    },
  );

  it("keeps a live rebound session key when load sees its stale public-id ledger", async () => {
    const eventLedger = createInMemoryAcpEventLedger();
    await eventLedger.startSession({
      sessionId: "stable",
      sessionKey: "agent:main:old",
      cwd,
      complete: true,
    });
    const sessionStore = createInMemorySessionStore();
    sessionStore.createSession({
      sessionId: "stable",
      sessionKey: "agent:main:new",
      ledgerSessionId: "new-ledger",
      cwd,
    });
    await eventLedger.startSession({
      sessionId: "new-ledger",
      sessionKey: "agent:main:new",
      cwd,
      complete: true,
    });
    const resolveSessionKey = vi.fn(
      async ({ fallbackKey }: { fallbackKey: string }) => fallbackKey,
    );
    const sessionRuntime = createRuntime({ resolveSessionKey });
    const { agent } = createHarness({ eventLedger, sessionRuntime, sessionStore });

    await agent.loadSession({
      sessionId: "stable",
      cwd,
      mcpServers: [],
      _meta: {},
    });

    expect(resolveSessionKey).toHaveBeenCalledWith({
      meta: expect.any(Object),
      fallbackKey: "agent:main:new",
    });
    expect(sessionStore.getSession("stable")).toMatchObject({
      sessionKey: "agent:main:new",
      ledgerSessionId: "new-ledger",
    });
  });

  it("applies reset semantics and permits a live binding without durable state on resume", async () => {
    const sessionStore = createInMemorySessionStore();
    sessionStore.createSession({
      sessionId: "resume-session",
      sessionKey: "agent:main:work",
      cwd,
    });
    const eventLedger = createInMemoryAcpEventLedger();
    await eventLedger.startSession({
      sessionId: "resume-session",
      sessionKey: "agent:main:work",
      cwd,
      complete: true,
    });
    await eventLedger.recordUpdate({
      sessionId: "resume-session",
      sessionKey: "agent:main:work",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "stale answer" },
      },
    });
    const resetSessionIfNeeded = vi.fn(async () => {});
    const getSessionSnapshot = vi.fn(async () => snapshot({ title: "Live work" }));
    const getExistingSessionSnapshot = vi.fn(async () => {
      throw new Error("live binding must not require durable state");
    });
    const sessionRuntime = createRuntime({
      resolveSessionKey: vi.fn(async () => "agent:main:work"),
      resetSessionIfNeeded,
      getSessionSnapshot,
      getExistingSessionSnapshot,
    });
    const { agent } = createHarness({ eventLedger, sessionRuntime, sessionStore });

    await expect(
      agent.resumeSession({
        sessionId: "resume-session",
        cwd,
        mcpServers: [],
        _meta: { resetSession: true },
      }),
    ).resolves.toMatchObject({
      modes: { currentModeId: "adaptive" },
    });

    expect(resetSessionIfNeeded).toHaveBeenCalledWith({
      meta: expect.objectContaining({ resetSession: true }),
      sessionKey: "agent:main:work",
      cwd,
    });
    expect(getSessionSnapshot).toHaveBeenCalledWith("agent:main:work", expect.any(Object));
    expect(getExistingSessionSnapshot).not.toHaveBeenCalled();
    const replay = await eventLedger.readReplay({
      sessionId: "resume-session",
      sessionKey: "agent:main:work",
    });
    expect(replay.complete).toBe(true);
    expect(
      replay.events.some(
        ({ update }) =>
          update.sessionUpdate === "agent_message_chunk" &&
          update.content.type === "text" &&
          update.content.text === "stale answer",
      ),
    ).toBe(false);
  });

  it.each(["load", "resume"] as const)(
    "rejects session/%s rebind without cancelling the active public session",
    async (method) => {
      const sessionStore = createInMemorySessionStore();
      sessionStore.createSession({
        sessionId: "rebind",
        sessionKey: "agent:main:old",
        cwd,
      });
      const turnStarted = deferred<void>();
      const executeAgent = vi.fn(
        async ({ abortSignal }: { abortSignal: AbortSignal }) =>
          await new Promise<{ payloads: never[]; meta: { aborted: true } }>((resolve) => {
            turnStarted.resolve();
            abortSignal.addEventListener(
              "abort",
              () => resolve({ payloads: [], meta: { aborted: true } }),
              { once: true },
            );
          }),
      );
      const sessionRuntime = createRuntime({
        resolveSessionKey: vi.fn(async ({ meta, fallbackKey }) =>
          meta.sessionKey ? `agent:main:${meta.sessionKey}` : fallbackKey,
        ),
      });
      const { agent } = createHarness({
        executeAgent: executeAgent as never,
        sessionRuntime,
        sessionStore,
      });
      const prompt = agent.prompt({
        sessionId: "rebind",
        prompt: [{ type: "text", text: "old turn" }],
      });
      await turnStarted.promise;

      const request = {
        sessionId: "rebind",
        cwd,
        mcpServers: [],
        _meta: { sessionKey: "new" },
      };
      const rebound = method === "load" ? agent.loadSession(request) : agent.resumeSession(request);

      await expect(rebound).rejects.toThrow(
        "ACP session rebind is already bound to agent:main:old",
      );
      expect(agent.activeRunCount()).toBe(1);
      expect(sessionStore.getSession("rebind")?.sessionKey).toBe("agent:main:old");
      await agent.cancel({ sessionId: "rebind" });
      await expect(prompt).resolves.toEqual({ stopReason: "cancelled" });
    },
  );

  it.each(["load", "resume"] as const)(
    "preserves process-local timeout controls across session/%s",
    async (method) => {
      const sessionStore = createInMemorySessionStore();
      sessionStore.createSession({
        sessionId: "controls",
        sessionKey: "agent:main:controls",
        cwd,
        runtimeOptions: { timeoutSeconds: 45 },
      });
      const sessionSnapshot = vi.fn(
        async (
          _sessionKey: string,
          overrides?: {
            timeoutSeconds?: number;
          },
        ) => snapshot({ timeout: String(overrides?.timeoutSeconds ?? "inherit") }),
      );
      const sessionRuntime = createRuntime({
        resolveSessionKey: vi.fn(async () => "agent:main:controls"),
        getSessionSnapshot: sessionSnapshot,
        getExistingSessionSnapshot: sessionSnapshot,
      });
      const { agent } = createHarness({ sessionRuntime, sessionStore });
      const request = {
        sessionId: "controls",
        cwd,
        mcpServers: [],
        _meta: {},
      };

      const result =
        method === "load" ? await agent.loadSession(request) : await agent.resumeSession(request);

      expect(result.configOptions).toContainEqual(
        expect.objectContaining({
          id: "timeout_seconds",
          currentValue: "45",
        }),
      );
      expect(sessionStore.getSession("controls")?.runtimeOptions).toEqual({
        timeoutSeconds: 45,
      });
    },
  );

  it.each(["load", "resume"] as const)(
    "restores the prior binding when session/%s delivery fails",
    async (method) => {
      const sessionStore = createInMemorySessionStore();
      sessionStore.createSession({
        sessionId: "stable",
        sessionKey: "agent:main:old",
        ledgerSessionId: "old-ledger",
        cwd: "/workspace/old",
        runtimeOptions: { timeoutSeconds: 30 },
      });
      const eventLedger = createInMemoryAcpEventLedger();
      await eventLedger.startSession({
        sessionId: "old-ledger",
        sessionKey: "agent:main:old",
        cwd: "/workspace/old",
        complete: true,
      });
      const sessionRuntime = createRuntime({
        resolveSessionKey: vi.fn(async () => "agent:main:old"),
      });
      const { agent } = createHarness({
        eventLedger,
        sessionRuntime,
        sessionStore,
        sessionUpdate: vi.fn(async () => {
          throw new Error("client disconnected");
        }),
      });
      const request = {
        sessionId: "stable",
        cwd: "/workspace/new",
        mcpServers: [],
        _meta: {},
      };

      await expect(
        method === "load" ? agent.loadSession(request) : agent.resumeSession(request),
      ).rejects.toThrow("client disconnected");

      expect(sessionStore.getSession("stable")).toMatchObject({
        sessionKey: "agent:main:old",
        ledgerSessionId: "old-ledger",
        cwd: "/workspace/old",
        runtimeOptions: { timeoutSeconds: 30 },
      });
      await expect(
        eventLedger.readReplayBySessionId({ sessionId: "old-ledger" }),
      ).resolves.toMatchObject({
        complete: true,
        sessionKey: "agent:main:old",
      });
    },
  );

  it.each(["load", "resume"] as const)(
    "keeps the committed reset binding when session/%s delivery fails",
    async (method) => {
      const sessionStore = createInMemorySessionStore();
      sessionStore.createSession({
        sessionId: "stable",
        sessionKey: "agent:main:work",
        ledgerSessionId: "old-ledger",
        cwd,
      });
      const eventLedger = createInMemoryAcpEventLedger();
      await eventLedger.startSession({
        sessionId: "old-ledger",
        sessionKey: "agent:main:work",
        cwd,
        complete: true,
      });
      const resetSessionIfNeeded = vi.fn(async () => {});
      const sessionRuntime = createRuntime({
        resolveSessionKey: vi.fn(async () => "agent:main:work"),
        resetSessionIfNeeded,
      });
      const { agent } = createHarness({
        eventLedger,
        sessionRuntime,
        sessionStore,
        sessionUpdate: vi.fn(async () => {
          throw new Error("client disconnected");
        }),
      });
      const request = {
        sessionId: "stable",
        cwd,
        mcpServers: [],
        _meta: { resetSession: true },
      };

      await expect(
        method === "load" ? agent.loadSession(request) : agent.resumeSession(request),
      ).rejects.toThrow("client disconnected");

      expect(resetSessionIfNeeded).toHaveBeenCalledTimes(1);
      expect(sessionStore.getSession("stable")).toMatchObject({
        sessionKey: "agent:main:work",
        cwd,
      });
      expect(sessionStore.getSession("stable")?.ledgerSessionId).toBeUndefined();
      await expect(
        eventLedger.readReplayBySessionId({ sessionId: "stable" }),
      ).resolves.toMatchObject({
        complete: true,
        sessionKey: "agent:main:work",
      });
    },
  );

  it("serializes sibling control patches behind canonical reset invalidation", async () => {
    const sessionStore = createInMemorySessionStore();
    sessionStore.createSession({
      sessionId: "control",
      sessionKey: "agent:main:shared",
      cwd,
    });
    sessionStore.createSession({
      sessionId: "resetter",
      sessionKey: "agent:main:shared",
      cwd,
    });
    const resetStarted = deferred<void>();
    const releaseReset = deferred<void>();
    const patchSession = vi.fn(async () => snapshot());
    const sessionRuntime = createRuntime({
      resolveSessionKey: vi.fn(async () => "agent:main:shared"),
      resetSessionIfNeeded: vi.fn(async () => {
        resetStarted.resolve();
        await releaseReset.promise;
      }),
      patchSession,
    });
    const { agent } = createHarness({ sessionRuntime, sessionStore });

    const reset = agent.resumeSession({
      sessionId: "resetter",
      cwd,
      mcpServers: [],
      _meta: { resetSession: true },
    });
    await resetStarted.promise;
    const control = agent.setSessionMode({
      sessionId: "control",
      modeId: "high",
      _meta: {},
    });

    releaseReset.resolve();
    await expect(reset).resolves.toBeDefined();
    await expect(control).rejects.toThrow("Session control not found");
    expect(patchSession).not.toHaveBeenCalled();
  });

  it.each(["load", "resume"] as const)(
    "does not resurrect stale replay when session/%s waits behind a sibling reset",
    async (method) => {
      const sessionStore = createInMemorySessionStore();
      sessionStore.createSession({
        sessionId: "stale",
        sessionKey: "agent:main:shared",
        cwd,
      });
      sessionStore.createSession({
        sessionId: "resetter",
        sessionKey: "agent:main:shared",
        cwd,
      });
      const eventLedger = createInMemoryAcpEventLedger();
      await eventLedger.startSession({
        sessionId: "stale",
        sessionKey: "agent:main:shared",
        cwd,
        complete: true,
      });
      await eventLedger.recordUpdate({
        sessionId: "stale",
        sessionKey: "agent:main:shared",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "pre-reset history" },
        },
      });
      const resetStarted = deferred<void>();
      const releaseReset = deferred<void>();
      const resolveSessionKey = vi.fn(async () => "agent:main:shared");
      const sessionRuntime = createRuntime({
        resolveSessionKey,
        resetSessionIfNeeded: vi.fn(async ({ meta }) => {
          if (meta.resetSession) {
            resetStarted.resolve();
            await releaseReset.promise;
          }
        }),
      });
      const { agent, updates } = createHarness({ eventLedger, sessionRuntime, sessionStore });

      const reset = agent.resumeSession({
        sessionId: "resetter",
        cwd,
        mcpServers: [],
        _meta: { resetSession: true },
      });
      await resetStarted.promise;
      const request = {
        sessionId: "stale",
        cwd,
        mcpServers: [],
        _meta: { sessionKey: "shared" },
      };
      const queued = method === "load" ? agent.loadSession(request) : agent.resumeSession(request);
      await vi.waitFor(() => expect(resolveSessionKey).toHaveBeenCalledTimes(3));

      releaseReset.resolve();
      await expect(reset).resolves.toBeDefined();
      await expect(queued).resolves.toBeDefined();

      expect(sessionStore.getSession("stale")?.sessionKey).toBe("agent:main:shared");
      expect(
        updates.some(
          ({ update }) =>
            update.sessionUpdate === "agent_message_chunk" &&
            update.content.type === "text" &&
            update.content.text === "pre-reset history",
        ),
      ).toBe(false);
    },
  );

  it("pages local session rows with an opaque cursor", async () => {
    const rows: SessionInfo[] = [
      { sessionId: "agent:main:first", cwd, title: "First" },
      { sessionId: "agent:main:second", cwd, title: "Second" },
    ];
    const listSessions = vi.fn(
      async ({ offset, limit }: { cwd?: string; offset: number; limit: number }) =>
        rows.slice(offset, offset + limit),
    );
    const { agent } = createHarness({
      sessionRuntime: createRuntime({ listSessions }),
    });
    const request = {
      cwd,
      cursor: null,
      _meta: { limit: 1 },
    } as ListSessionsRequest;

    const first = await agent.listSessions(request);
    const second = await agent.listSessions({
      ...request,
      cursor: first.nextCursor,
    });

    expect(first.sessions).toEqual([rows[0]]);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(second.sessions).toEqual([rows[1]]);
    expect(second.nextCursor).toBeNull();
    expect(listSessions).toHaveBeenNthCalledWith(1, {
      cwd,
      offset: 0,
      limit: 2,
    });
    expect(listSessions).toHaveBeenNthCalledWith(2, {
      cwd,
      offset: 1,
      limit: 2,
    });
  });

  it("preserves exact absolute cwd filters and rejects whitespace-only paths", async () => {
    const listSessions = vi.fn(async () => []);
    const { agent } = createHarness({
      sessionRuntime: createRuntime({ listSessions }),
    });
    const spacedCwd = "/tmp/openclaw project ";

    await agent.listSessions({ cwd: spacedCwd, cursor: null, _meta: {} });
    expect(listSessions).toHaveBeenCalledWith({
      cwd: spacedCwd,
      offset: 0,
      limit: 101,
    });
    await expect(agent.listSessions({ cwd: "   ", cursor: null, _meta: {} })).rejects.toThrow(
      /absolute cwd/i,
    );
  });

  it("closes a local session once and rejects missing or duplicate closes", async () => {
    const sessionStore = createInMemorySessionStore();
    sessionStore.createSession({
      sessionId: "close-me",
      sessionKey: "agent:main:close-me",
      cwd,
    });
    const { agent } = createHarness({ sessionStore });

    await expect(agent.closeSession({ sessionId: "close-me", _meta: {} })).resolves.toEqual({});
    expect(sessionStore.hasSession("close-me")).toBe(false);
    await expect(agent.closeSession({ sessionId: "close-me", _meta: {} })).rejects.toThrow(
      "Session close-me not found",
    );
    await expect(agent.closeSession({ sessionId: "never-created", _meta: {} })).rejects.toThrow(
      "Session never-created not found",
    );
  });

  it("shares one creation rate limit across new, load, and resume handlers", async () => {
    const { agent } = createHarness({
      sessionCreateRateLimit: {
        maxRequests: 1,
        windowMs: 60_000,
      },
    });

    await agent.loadSession({
      sessionId: "shared",
      cwd,
      mcpServers: [],
      _meta: {},
    });
    await expect(
      agent.loadSession({
        sessionId: "shared",
        cwd,
        mcpServers: [],
        _meta: {},
      }),
    ).resolves.toBeDefined();
    await expect(
      agent.resumeSession({
        sessionId: "shared",
        cwd,
        mcpServers: [],
        _meta: {},
      }),
    ).resolves.toBeDefined();
    await expect(
      agent.newSession({
        cwd,
        mcpServers: [],
        _meta: {},
      }),
    ).rejects.toThrow(/session creation rate limit exceeded for newSession/i);
  });

  it("rejects new sessions before resolving labels after the creation budget is exhausted", async () => {
    const resolveSessionKey = vi.fn(
      async ({ fallbackKey }: { fallbackKey: string }) => fallbackKey,
    );
    const { agent } = createHarness({
      sessionRuntime: createRuntime({ resolveSessionKey }),
      sessionCreateRateLimit: {
        maxRequests: 1,
        windowMs: 60_000,
      },
    });

    await agent.newSession({ cwd, mcpServers: [], _meta: {} });
    await expect(
      agent.newSession({
        cwd,
        mcpServers: [],
        _meta: { sessionLabel: "expensive-label" },
      }),
    ).rejects.toThrow(/session creation rate limit exceeded for newSession/i);

    expect(resolveSessionKey).toHaveBeenCalledTimes(1);
  });

  it("rejects a public session id rebind before canonical hydration", async () => {
    const resolveSessionKey = vi.fn(async ({ meta, fallbackKey }) =>
      meta.sessionKey ? `agent:main:${meta.sessionKey}` : fallbackKey,
    );
    const getExistingSessionSnapshot = vi.fn(async () => snapshot());
    const getSessionTranscript = vi.fn(async () => []);
    const sessionRuntime = createRuntime({
      resolveSessionKey,
      getExistingSessionSnapshot,
      getSessionTranscript,
    });
    const { agent, sessionStore } = createHarness({
      sessionRuntime,
      sessionCreateRateLimit: {
        maxRequests: 1,
        windowMs: 60_000,
      },
    });

    await agent.loadSession({
      sessionId: "stable",
      cwd,
      mcpServers: [],
      _meta: {},
    });
    getExistingSessionSnapshot.mockClear();
    getSessionTranscript.mockClear();
    await expect(
      agent.loadSession({
        sessionId: "stable",
        cwd,
        mcpServers: [],
        _meta: { sessionKey: "other" },
      }),
    ).rejects.toThrow("ACP session stable is already bound to stable");

    expect(sessionStore.getSession("stable")?.sessionKey).toBe("stable");
    expect(getExistingSessionSnapshot).not.toHaveBeenCalled();
    expect(getSessionTranscript).not.toHaveBeenCalled();
  });

  it("keeps mode and supported config changes in process-local session options", async () => {
    const sessionStore = createInMemorySessionStore();
    sessionStore.createSession({
      sessionId: "controls",
      sessionKey: "agent:main:controls",
      cwd,
    });
    let durableControls = {
      thinkingLevel: "adaptive",
      fastMode: false as boolean | "auto",
      verboseLevel: "off",
    };
    const getSessionSnapshot = vi.fn(
      async (
        _sessionKey: string,
        overrides?: {
          thinkingLevel?: string;
          fastMode?: boolean | "auto";
          verboseLevel?: string;
          timeoutSeconds?: number;
        },
      ) =>
        snapshot({
          mode: overrides?.thinkingLevel ?? durableControls.thinkingLevel,
          fastMode:
            (overrides?.fastMode ?? durableControls.fastMode) === "auto"
              ? "auto"
              : (overrides?.fastMode ?? durableControls.fastMode)
                ? "on"
                : "off",
          verbose: overrides?.verboseLevel ?? durableControls.verboseLevel,
          timeout:
            overrides?.timeoutSeconds === undefined ? "inherit" : String(overrides.timeoutSeconds),
        }),
    );
    const patchSession = vi.fn(
      async (
        _sessionKey: string,
        patch: {
          thinkingLevel?: string | null;
          fastMode?: boolean | "auto" | null;
          verboseLevel?: string | null;
        },
        overrides?: {
          thinkingLevel?: string;
          fastMode?: boolean | "auto";
          verboseLevel?: string;
          timeoutSeconds?: number;
        },
      ) => {
        durableControls = {
          thinkingLevel: patch.thinkingLevel ?? durableControls.thinkingLevel,
          fastMode: patch.fastMode ?? durableControls.fastMode,
          verboseLevel: patch.verboseLevel ?? durableControls.verboseLevel,
        };
        return await getSessionSnapshot(_sessionKey, overrides);
      },
    );
    const { agent, updates } = createHarness({
      sessionRuntime: createRuntime({ getSessionSnapshot, patchSession }),
      sessionStore,
    });

    await agent.setSessionMode({
      sessionId: "controls",
      modeId: "high",
      _meta: {},
    });
    const configResult = await agent.setSessionConfigOption({
      sessionId: "controls",
      configId: "fast_mode",
      value: "on",
      _meta: {},
    });
    await agent.setSessionConfigOption({
      sessionId: "controls",
      configId: "verbose_level",
      value: "full",
      _meta: {},
    });
    const timeoutResult = await agent.setSessionConfigOption({
      sessionId: "controls",
      configId: "timeout",
      value: "45",
      _meta: {},
    });

    expect(sessionStore.getSession("controls")?.runtimeOptions).toEqual({
      thinking: "high",
      timeoutSeconds: 45,
      backendExtras: {
        fastMode: "on",
        verbose: "full",
      },
    });
    expect(patchSession).toHaveBeenNthCalledWith(
      1,
      "agent:main:controls",
      {
        thinkingLevel: "high",
      },
      expect.objectContaining({ thinkingLevel: "high" }),
    );
    expect(patchSession).toHaveBeenNthCalledWith(
      2,
      "agent:main:controls",
      {
        fastMode: true,
      },
      expect.objectContaining({ fastMode: true }),
    );
    expect(patchSession).toHaveBeenNthCalledWith(
      3,
      "agent:main:controls",
      {
        verboseLevel: "full",
      },
      expect.objectContaining({ verboseLevel: "full" }),
    );
    expect(configResult.configOptions).toContainEqual(
      expect.objectContaining({
        id: "fast_mode",
        currentValue: "on",
      }),
    );
    expect(timeoutResult.configOptions).toContainEqual(
      expect.objectContaining({
        id: "timeout_seconds",
        currentValue: "45",
      }),
    );
    expect(updateTypes(updates)).toEqual([
      "current_mode_update",
      "config_option_update",
      "session_info_update",
      "usage_update",
      "current_mode_update",
      "config_option_update",
      "session_info_update",
      "usage_update",
      "current_mode_update",
      "config_option_update",
      "session_info_update",
      "usage_update",
      "current_mode_update",
      "config_option_update",
      "session_info_update",
      "usage_update",
    ]);
  });

  it("serializes control mutations with each other and session close", async () => {
    const sessionStore = createInMemorySessionStore();
    sessionStore.createSession({
      sessionId: "serialized",
      sessionKey: "agent:main:serialized",
      cwd,
    });
    const firstPatchStarted = deferred<void>();
    const firstPatchGate = deferred<void>();
    let patchCount = 0;
    const patchSession = vi.fn(
      async (
        _sessionKey: string,
        _patch: AcpLocalSessionPatch,
        overrides?: { fastMode?: boolean | "auto"; verboseLevel?: string },
      ) => {
        patchCount += 1;
        if (patchCount === 1) {
          firstPatchStarted.resolve();
          await firstPatchGate.promise;
        }
        return snapshot({
          fastMode: overrides?.fastMode === "auto" ? "auto" : overrides?.fastMode ? "on" : "off",
          verbose: overrides?.verboseLevel,
        });
      },
    );
    const { agent } = createHarness({
      sessionRuntime: createRuntime({ patchSession }),
      sessionStore,
    });

    const fastMode = agent.setSessionConfigOption({
      sessionId: "serialized",
      configId: "fast_mode",
      value: "on",
      _meta: {},
    });
    await firstPatchStarted.promise;
    const verbose = agent.setSessionConfigOption({
      sessionId: "serialized",
      configId: "verbose_level",
      value: "full",
      _meta: {},
    });
    const close = agent.closeSession({ sessionId: "serialized", _meta: {} });
    await Promise.resolve();
    expect(patchSession).toHaveBeenCalledTimes(1);
    expect(sessionStore.hasSession("serialized")).toBe(true);

    firstPatchGate.resolve();
    await Promise.all([fastMode, verbose]);
    expect(patchSession).toHaveBeenCalledTimes(2);
    expect(sessionStore.getSession("serialized")?.runtimeOptions?.backendExtras).toEqual({
      fastMode: "on",
      verbose: "full",
    });
    await close;
    expect(sessionStore.hasSession("serialized")).toBe(false);
  });

  it.each(["0.1", " 45 ", "0x10", "1e3", "-1", "9007199254740992"])(
    "rejects non-canonical timeout value %s",
    async (value) => {
      const sessionStore = createInMemorySessionStore();
      sessionStore.createSession({
        sessionId: "timeout",
        sessionKey: "agent:main:timeout",
        cwd,
      });
      const { agent } = createHarness({ sessionStore });

      await expect(
        agent.setSessionConfigOption({
          sessionId: "timeout",
          configId: "timeout_seconds",
          value,
          _meta: {},
        }),
      ).rejects.toThrow(/unsupported timeout value/i);
      expect(sessionStore.getSession("timeout")?.runtimeOptions).toBeUndefined();
    },
  );

  it("rejects new sessions and control mutations after shutdown", async () => {
    const sessionStore = createInMemorySessionStore();
    sessionStore.createSession({
      sessionId: "stopped",
      sessionKey: "agent:main:stopped",
      cwd,
    });
    const { agent } = createHarness({ sessionStore });
    await agent.shutdown();

    await expect(agent.newSession({ cwd, mcpServers: [], _meta: {} })).rejects.toThrow(
      /runtime is stopped/i,
    );
    await expect(
      agent.setSessionMode({ sessionId: "stopped", modeId: "high", _meta: {} }),
    ).rejects.toThrow(/runtime is stopped/i);
    await expect(
      agent.setSessionConfigOption({
        sessionId: "stopped",
        configId: "fast_mode",
        value: "on",
        _meta: {},
      }),
    ).rejects.toThrow(/runtime is stopped/i);
  });

  it.each(["new", "load"] as const)(
    "rejects relative cwd before session/%s has side effects",
    async (method) => {
      const { agent, sessionRuntime, sessionStore, updates } = createHarness();
      const request =
        method === "new"
          ? agent.newSession({ cwd: "relative/path", mcpServers: [], _meta: {} })
          : agent.loadSession({
              sessionId: "relative",
              cwd: "relative/path",
              mcpServers: [],
              _meta: {},
            });

      await expect(request).rejects.toThrow(/absolute (?:path|cwd)/i);
      expect(sessionRuntime.resolveSessionKey).not.toHaveBeenCalled();
      expect(sessionStore.hasSession("relative")).toBe(false);
      expect(updates).toEqual([]);
    },
  );

  it.each([
    ["new", (agent: AcpAgent) => agent.newSession({ cwd, mcpServers: [{}] as never[], _meta: {} })],
    [
      "load",
      (agent: AcpAgent) =>
        agent.loadSession({
          sessionId: "mcp-session",
          cwd,
          mcpServers: [{}] as never[],
          _meta: {},
        }),
    ],
    [
      "resume",
      (agent: AcpAgent) =>
        agent.resumeSession({
          sessionId: "mcp-session",
          cwd,
          mcpServers: [{}] as never[],
          _meta: {},
        }),
    ],
  ])("rejects per-session MCP servers during session/%s", async (_method, invoke) => {
    const { agent, sessionRuntime, sessionStore, updates } = createHarness();

    await expect(invoke(agent)).rejects.toThrow(/does not support per-session MCP servers/i);

    expect(sessionRuntime.resolveSessionKey).not.toHaveBeenCalled();
    expect(sessionStore.hasSession("mcp-session")).toBe(false);
    expect(updates).toEqual([]);
  });
});

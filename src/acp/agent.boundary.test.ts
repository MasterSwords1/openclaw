import { readFileSync } from "node:fs";
import type { AgentSideConnection, SessionUpdate } from "@agentclientprotocol/sdk";
import { createInMemorySessionStore, type AcpSessionStore } from "@openclaw/acp-core/session";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emitAgentEvent, resetAgentEventsForTest } from "../infra/agent-events.js";
import { AcpAgent } from "./agent.js";
import { createInMemoryAcpEventLedger, type AcpEventLedger } from "./event-ledger.js";
import type { AcpLocalSessionRuntime } from "./local-session-runtime.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createConnection() {
  const updates: Array<{ sessionId: string; update: SessionUpdate }> = [];
  const connection = {
    requestPermission: vi.fn(),
    sessionUpdate: vi.fn(async (params: { sessionId: string; update: SessionUpdate }) => {
      updates.push(params);
    }),
  } as unknown as AgentSideConnection;
  return { connection, updates };
}

function createSessionRuntime(): AcpLocalSessionRuntime {
  const snapshot = {
    configOptions: [],
    modes: {
      currentModeId: "adaptive",
      availableModes: [{ id: "adaptive", name: "Adaptive" }],
    },
  };
  return {
    resolveSessionKey: async ({ fallbackKey }) => fallbackKey,
    resetSessionIfNeeded: async () => {},
    getSessionSnapshot: async () => snapshot,
    getExistingSessionSnapshot: async () => snapshot,
    patchSession: async () => snapshot,
    listSessions: async () => [],
    getSessionTranscript: async () => [],
  };
}

function createAgent(params: {
  executeAgent: (...args: never[]) => Promise<unknown>;
  sessions: Array<{ sessionId: string; sessionKey: string }>;
  eventLedger?: AcpEventLedger;
  sessionStore?: AcpSessionStore;
  sessionRuntime?: AcpLocalSessionRuntime;
}) {
  const { connection, updates } = createConnection();
  const sessionStore = params.sessionStore ?? createInMemorySessionStore();
  for (const session of params.sessions) {
    sessionStore.createSession({
      ...session,
      cwd: "/tmp/openclaw-acp-test",
    });
  }
  const agent = new AcpAgent(connection, {
    eventLedger: params.eventLedger ?? createInMemoryAcpEventLedger(),
    executeAgent: params.executeAgent as never,
    sessionRuntime: params.sessionRuntime ?? createSessionRuntime(),
    sessionStore,
  });
  return { agent, sessionStore, updates };
}

function prompt(agent: AcpAgent, sessionId: string, text = "hello") {
  return agent.prompt({
    sessionId,
    prompt: [{ type: "text", text }],
  });
}

afterEach(() => {
  resetAgentEventsForTest();
  delete process.env.BUZZ_PRIVATE_KEY;
});

describe("AcpAgent process-local runtime boundary", () => {
  it("runs the turn in the ACP process with inherited Buzz environment", async () => {
    process.env.BUZZ_PRIVATE_KEY = "test-only-buzz-key";
    let observedBuzzKey: string | undefined;
    const executeAgent = vi.fn(async (opts: { runId: string; sessionKey: string }) => {
      observedBuzzKey = process.env.BUZZ_PRIVATE_KEY;
      emitAgentEvent({
        runId: opts.runId,
        stream: "assistant",
        data: { delta: "from local tools" },
      });
      return { payloads: [{ text: "from local tools" }], meta: {} };
    });
    const { agent, updates } = createAgent({
      executeAgent,
      sessions: [{ sessionId: "buzz-session", sessionKey: "agent:main:buzz" }],
    });

    await expect(prompt(agent, "buzz-session")).resolves.toEqual({ stopReason: "end_turn" });

    expect(observedBuzzKey).toBe("test-only-buzz-key");
    expect(executeAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:buzz",
        approvalHost: expect.any(Object),
        senderIsOwner: true,
      }),
      expect.any(Object),
    );
    expect(updates).toContainEqual({
      sessionId: "buzz-session",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "from local tools" },
      },
    });
    expect(agent.activeRunCount()).toBe(0);
  });

  it("isolates concurrent ACP sessions by local run ownership", async () => {
    const gates = new Map([
      ["agent:main:first", deferred<void>()],
      ["agent:main:second", deferred<void>()],
    ]);
    const executeAgent = vi.fn(async (opts: { runId: string; sessionKey: string }) => {
      emitAgentEvent({
        runId: opts.runId,
        stream: "assistant",
        data: { delta: opts.sessionKey },
      });
      await gates.get(opts.sessionKey)?.promise;
      return { payloads: [], meta: {} };
    });
    const { agent, updates } = createAgent({
      executeAgent,
      sessions: [
        { sessionId: "first", sessionKey: "agent:main:first" },
        { sessionId: "second", sessionKey: "agent:main:second" },
      ],
    });

    const first = prompt(agent, "first");
    const second = prompt(agent, "second");
    await vi.waitFor(() => expect(agent.activeRunCount()).toBe(2));

    expect(
      updates.filter(
        (entry) =>
          entry.sessionId === "first" && entry.update.sessionUpdate === "agent_message_chunk",
      ),
    ).toContainEqual({
      sessionId: "first",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "agent:main:first" },
      },
    });
    expect(
      updates.filter(
        (entry) =>
          entry.sessionId === "second" && entry.update.sessionUpdate === "agent_message_chunk",
      ),
    ).toContainEqual({
      sessionId: "second",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "agent:main:second" },
      },
    });

    gates.get("agent:main:first")?.resolve();
    gates.get("agent:main:second")?.resolve();
    await Promise.all([first, second]);
    expect(agent.activeRunCount()).toBe(0);
  });

  it("keeps an active session binding when the registry is at capacity", async () => {
    const sessionStore = createInMemorySessionStore({ maxSessions: 1 });
    const executeAgent = vi.fn(
      async (opts: { abortSignal: AbortSignal }) =>
        await new Promise<{ payloads: never[]; meta: { aborted: true } }>((resolve) => {
          opts.abortSignal.addEventListener(
            "abort",
            () => resolve({ payloads: [], meta: { aborted: true } }),
            { once: true },
          );
        }),
    );
    const { agent } = createAgent({
      executeAgent,
      sessionStore,
      sessions: [{ sessionId: "active", sessionKey: "agent:main:active" }],
    });
    const response = prompt(agent, "active");
    await vi.waitFor(() => expect(agent.activeRunCount()).toBe(1));

    await expect(
      agent.newSession({
        cwd: "/tmp/openclaw-acp-test",
        mcpServers: [],
        _meta: {},
      }),
    ).rejects.toThrow(/session limit reached/i);
    expect(sessionStore.hasSession("active")).toBe(true);

    await agent.cancel({ sessionId: "active" });
    await expect(response).resolves.toEqual({ stopReason: "cancelled" });
  });

  it("cancels the exact session turn and settles it as cancelled", async () => {
    const executeAgent = vi.fn(
      async (opts: { abortSignal: AbortSignal }) =>
        await new Promise<{ payloads: never[]; meta: { aborted: true } }>((resolve) => {
          opts.abortSignal.addEventListener(
            "abort",
            () => resolve({ payloads: [], meta: { aborted: true } }),
            { once: true },
          );
        }),
    );
    const { agent } = createAgent({
      executeAgent,
      sessions: [{ sessionId: "cancel-me", sessionKey: "agent:main:cancel-me" }],
    });

    const response = prompt(agent, "cancel-me");
    await vi.waitFor(() => expect(agent.activeRunCount()).toBe(1));
    await agent.cancel({ sessionId: "cancel-me" });

    await expect(response).resolves.toEqual({ stopReason: "cancelled" });
    expect(agent.activeRunCount()).toBe(0);
  });

  it("quiesces every binding before resetting a shared canonical session", async () => {
    const eventLedger = createInMemoryAcpEventLedger();
    await eventLedger.startSession({
      sessionId: "active",
      sessionKey: "agent:main:shared",
      cwd: "/tmp/openclaw-acp-test",
      complete: true,
    });
    const executeAgent = vi.fn(
      async (opts: { abortSignal: AbortSignal }) =>
        await new Promise<{ payloads: never[]; meta: { aborted: true } }>((resolve) => {
          opts.abortSignal.addEventListener(
            "abort",
            () => resolve({ payloads: [], meta: { aborted: true } }),
            { once: true },
          );
        }),
    );
    const baseRuntime = createSessionRuntime();
    let agentRef!: AcpAgent;
    let activeRunsAtReset = -1;
    const sessionRuntime: AcpLocalSessionRuntime = {
      ...baseRuntime,
      resolveSessionKey: async () => "agent:main:shared",
      resetSessionIfNeeded: async () => {
        activeRunsAtReset = agentRef.activeRunCount();
      },
    };
    const harness = createAgent({
      executeAgent,
      eventLedger,
      sessionRuntime,
      sessions: [
        { sessionId: "active", sessionKey: "agent:main:shared" },
        { sessionId: "resetter", sessionKey: "agent:main:shared" },
      ],
    });
    agentRef = harness.agent;

    const activePrompt = prompt(harness.agent, "active");
    await vi.waitFor(() => expect(harness.agent.activeRunCount()).toBe(1));
    const reset = harness.agent.resumeSession({
      sessionId: "resetter",
      cwd: "/tmp/openclaw-acp-test",
      mcpServers: [],
      _meta: { resetSession: true },
    });

    await expect(activePrompt).resolves.toEqual({ stopReason: "cancelled" });
    await expect(reset).resolves.toBeDefined();
    expect(activeRunsAtReset).toBe(0);
    expect(harness.sessionStore.hasSession("active")).toBe(false);
    expect(harness.sessionStore.hasSession("resetter")).toBe(true);
    await expect(eventLedger.readReplayBySessionId({ sessionId: "active" })).resolves.toEqual({
      complete: false,
      events: [],
    });
  });

  it("seals, cancels, and settles every local turn during shutdown", async () => {
    const executeAgent = vi.fn(
      async (opts: { abortSignal: AbortSignal }) =>
        await new Promise<{ payloads: never[]; meta: { aborted: true } }>((resolve) => {
          opts.abortSignal.addEventListener(
            "abort",
            () => resolve({ payloads: [], meta: { aborted: true } }),
            { once: true },
          );
        }),
    );
    const { agent } = createAgent({
      executeAgent,
      sessions: [
        { sessionId: "one", sessionKey: "agent:main:one" },
        { sessionId: "two", sessionKey: "agent:main:two" },
      ],
    });

    const first = prompt(agent, "one");
    const second = prompt(agent, "two");
    await vi.waitFor(() => expect(agent.activeRunCount()).toBe(2));

    await agent.shutdown();

    await expect(first).resolves.toEqual({ stopReason: "cancelled" });
    await expect(second).resolves.toEqual({ stopReason: "cancelled" });
    expect(agent.activeRunCount()).toBe(0);
  });

  it("lets only the newest same-session prompt pass a delayed setup boundary", async () => {
    const baseLedger = createInMemoryAcpEventLedger();
    const firstPromptGate = deferred<void>();
    let promptCount = 0;
    const eventLedger: AcpEventLedger = {
      ...baseLedger,
      recordUserPrompt: async (params) => {
        promptCount += 1;
        if (promptCount === 1) {
          await firstPromptGate.promise;
        }
        await baseLedger.recordUserPrompt(params);
      },
    };
    const executeAgent = vi.fn(async () => ({ payloads: [], meta: {} }));
    const { agent } = createAgent({
      executeAgent,
      eventLedger,
      sessions: [{ sessionId: "same", sessionKey: "agent:main:same" }],
    });

    const first = prompt(agent, "same", "first");
    await vi.waitFor(() => expect(promptCount).toBe(1));
    const second = prompt(agent, "same", "second");

    firstPromptGate.resolve();
    await expect(first).resolves.toEqual({ stopReason: "cancelled" });
    await expect(second).resolves.toEqual({ stopReason: "end_turn" });
    expect(executeAgent).toHaveBeenCalledTimes(1);
  });

  it("cancels a prompt that is still waiting on ledger setup", async () => {
    const baseLedger = createInMemoryAcpEventLedger();
    const promptGate = deferred<void>();
    let promptStarted = false;
    const eventLedger: AcpEventLedger = {
      ...baseLedger,
      recordUserPrompt: async (params) => {
        promptStarted = true;
        await promptGate.promise;
        await baseLedger.recordUserPrompt(params);
      },
    };
    const executeAgent = vi.fn(async () => ({ payloads: [], meta: {} }));
    const { agent } = createAgent({
      executeAgent,
      eventLedger,
      sessions: [{ sessionId: "setup", sessionKey: "agent:main:setup" }],
    });

    const response = prompt(agent, "setup");
    await vi.waitFor(() => expect(promptStarted).toBe(true));
    await agent.cancel({ sessionId: "setup" });
    promptGate.resolve();

    await expect(response).resolves.toEqual({ stopReason: "cancelled" });
    expect(executeAgent).not.toHaveBeenCalled();
  });

  it("waits for prompt setup to settle before shutdown completes", async () => {
    const baseLedger = createInMemoryAcpEventLedger();
    const promptGate = deferred<void>();
    let promptStarted = false;
    const eventLedger: AcpEventLedger = {
      ...baseLedger,
      recordUserPrompt: async (params) => {
        promptStarted = true;
        await promptGate.promise;
        await baseLedger.recordUserPrompt(params);
      },
    };
    const executeAgent = vi.fn(async () => ({ payloads: [], meta: {} }));
    const { agent } = createAgent({
      executeAgent,
      eventLedger,
      sessions: [{ sessionId: "setup", sessionKey: "agent:main:setup" }],
    });

    const response = prompt(agent, "setup");
    await vi.waitFor(() => expect(promptStarted).toBe(true));
    let shutdownComplete = false;
    const shutdown = agent.shutdown().then(() => {
      shutdownComplete = true;
    });
    await Promise.resolve();
    expect(shutdownComplete).toBe(false);

    promptGate.resolve();
    await shutdown;
    await expect(response).resolves.toEqual({ stopReason: "cancelled" });
    expect(executeAgent).not.toHaveBeenCalled();
  });

  it("keeps the active inbound adapter free of Gateway runtime dependencies", () => {
    for (const file of [
      "agent.ts",
      "approval-host.ts",
      "local-session-runtime.ts",
      "server.ts",
      "session-mapper.ts",
    ]) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(source, file).not.toMatch(/from\s+["'][^"']*gateway\//);
      expect(source, file).not.toMatch(/gateway-protocol|GatewayClient|callGateway/);
    }
  });
});

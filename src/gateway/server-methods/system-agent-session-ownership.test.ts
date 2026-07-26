// System-agent session tests cover caller ownership and response projection.

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetCommandQueueStateForTest } from "../../process/command-queue.test-support.js";
import { SystemAgentInferenceUnavailableError } from "../../system-agent/inference-error.js";
import { systemAgentHandlers, type SystemAgentChatSession } from "./system-agent.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

const setupInferenceMocks = vi.hoisted(() => ({ verifySetupInference: vi.fn() }));
const delegatedInferenceMocks = vi.hoisted(() => ({
  verifySystemAgentInferenceWithFallback: vi.fn(),
}));
const transcriptMocks = vi.hoisted(() => ({
  appendTranscriptReset: vi.fn(),
  appendTranscriptTurn: vi.fn(),
  readTranscriptTail: vi.fn(() => []),
}));

vi.mock("../../system-agent/setup-inference.js", () => ({
  verifySetupInference: setupInferenceMocks.verifySetupInference,
}));
vi.mock("../../system-agent/inference-fallback.js", () => ({
  verifySystemAgentInferenceWithFallback:
    delegatedInferenceMocks.verifySystemAgentInferenceWithFallback,
}));
vi.mock("../../system-agent/transcript-store.js", () => transcriptMocks);
// Ownership tests exercise fresh-session creation; keep the caretaker greeting
// deterministic so identity behavior is the only variable under test.
vi.mock("../../system-agent/greeting.js", () => ({
  acknowledgeSystemAgentGreetingDelivery: vi.fn(),
  buildSystemAgentGreetingQuestion: vi.fn(() => undefined),
  loadSystemAgentGreetingFacts: vi.fn(() => ({
    updateAvailable: null,
    channelHealth: { available: true, degraded: [] },
    recentExternalEdit: false,
    auditSequence: 0,
  })),
  resolveSystemAgentGreeting: vi.fn(async () => ({ text: "welcome text", source: "template" })),
}));

type FakeEngine = {
  handle: ReturnType<typeof vi.fn>;
  seedHistory: ReturnType<typeof vi.fn>;
  historyLength: ReturnType<typeof vi.fn>;
  historySince: ReturnType<typeof vi.fn>;
  getPendingOperatorProposal: ReturnType<typeof vi.fn>;
  resolveOperatorApproval: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  hasLockedHostedWizard: ReturnType<typeof vi.fn>;
  resumeLockedHostedWizard: ReturnType<
    typeof vi.fn<SystemAgentChatSession["engine"]["resumeLockedHostedWizard"]>
  >;
  loadOverview: ReturnType<typeof vi.fn>;
  noteAssistantMessage: ReturnType<typeof vi.fn>;
};

function makeEngine(): FakeEngine {
  return {
    handle: vi.fn(async () => ({ text: "did the thing", action: "none" })),
    seedHistory: vi.fn(),
    historyLength: vi.fn(() => 0),
    historySince: vi.fn(() => []),
    getPendingOperatorProposal: vi.fn(() => null),
    resolveOperatorApproval: vi.fn(async () => null),
    dispose: vi.fn(async () => true),
    hasLockedHostedWizard: vi.fn(() => false),
    resumeLockedHostedWizard: vi.fn<SystemAgentChatSession["engine"]["resumeLockedHostedWizard"]>(
      async () => null,
    ),
    loadOverview: vi.fn(async () => ({})),
    noteAssistantMessage: vi.fn(),
  };
}

const createdEngines = vi.hoisted(() => [] as FakeEngine[]);

vi.mock("../../system-agent/chat-engine.js", () => ({
  SystemAgentChatEngine: function FakeSystemAgentChatEngine(this: FakeEngine) {
    const engine = makeEngine();
    createdEngines.push(engine);
    Object.assign(this, engine);
  },
}));
vi.mock("../../system-agent/overview.js", () => ({
  formatSystemAgentStartupMessage: vi.fn(() => "welcome text"),
}));

type RespondCall = { ok: boolean; payload?: unknown; error?: unknown };

function makeClient(params: {
  connId: string;
  deviceId?: string;
  authenticatedUserId?: string;
  sharedAuthGeneration?: string;
}): GatewayClient {
  return {
    connId: params.connId,
    connect: {
      client: { id: "openclaw-control-ui", mode: "webchat" },
      ...(params.deviceId ? { device: { id: params.deviceId } } : {}),
    },
    ...(params.authenticatedUserId ? { authenticatedUserId: params.authenticatedUserId } : {}),
    ...(params.sharedAuthGeneration
      ? {
          usesSharedGatewayAuth: true,
          sharedGatewaySessionGeneration: params.sharedAuthGeneration,
        }
      : {}),
  } as GatewayClient;
}

const defaultClient = makeClient({ connId: "conn-test", deviceId: "device-test" });

function makeContext(
  sessions: Map<string, SystemAgentChatSession>,
  systemAgentApprovalManager?: { expire: ReturnType<typeof vi.fn> },
): GatewayRequestContext {
  return {
    systemAgentSessions: sessions,
    ...(systemAgentApprovalManager ? { systemAgentApprovalManager } : {}),
  } as unknown as GatewayRequestContext;
}

function seededSession(params?: {
  engine?: FakeEngine;
  ownerKey?: string;
}): SystemAgentChatSession {
  return {
    engine: params?.engine ?? makeEngine(),
    welcome: "welcome text",
    lastUsedAt: 1,
    ownerKey: params?.ownerKey ?? "device:device-test",
  } as unknown as SystemAgentChatSession;
}

async function callChat(
  context: GatewayRequestContext,
  params: Record<string, unknown>,
  client: GatewayClient | null = defaultClient,
): Promise<RespondCall> {
  const calls: RespondCall[] = [];
  const respond: RespondFn = (ok, payload, error) => calls.push({ ok, payload, error });
  await expectDefined(
    systemAgentHandlers["openclaw.chat"],
    'systemAgentHandlers["openclaw.chat"] test invariant',
  )({
    params,
    client,
    context,
    respond,
  } as never);
  return expectDefined(calls[0], "system-agent response");
}

beforeEach(() => {
  createdEngines.length = 0;
  setupInferenceMocks.verifySetupInference.mockResolvedValue({ ok: true, binding: {} });
  delegatedInferenceMocks.verifySystemAgentInferenceWithFallback.mockResolvedValue({
    ok: true,
    binding: {},
  });
});

afterEach(() => {
  vi.clearAllMocks();
  resetCommandQueueStateForTest();
});

describe("openclaw.chat session ownership", () => {
  it("adopts one locked wizard only for its exact owner after the session id changes", async () => {
    const retained = makeEngine();
    retained.hasLockedHostedWizard.mockReturnValue(true);
    retained.resumeLockedHostedWizard.mockResolvedValue({
      text: "Retry validation?",
      action: "none",
      wizardInputPending: true,
    });
    const sessions = new Map<string, SystemAgentChatSession>([
      ["old-session", seededSession({ engine: retained })],
    ]);

    const call = await callChat(makeContext(sessions), { sessionId: "new-session" });

    expect(call).toMatchObject({
      ok: true,
      payload: {
        sessionId: "new-session",
        reply: "Retry validation?",
        wizardInputPending: true,
      },
    });
    expect(sessions.has("old-session")).toBe(true);
    expect(sessions.get("new-session")?.engine).toBe(retained);
    expect(retained.resumeLockedHostedWizard).toHaveBeenCalledOnce();
    expect(createdEngines).toHaveLength(0);

    const retry = await callChat(makeContext(sessions), { sessionId: "new-session" });

    expect(retry).toMatchObject({
      ok: true,
      payload: {
        sessionId: "new-session",
        reply: "Retry validation?",
        wizardInputPending: true,
      },
    });
    expect(retained.resumeLockedHostedWizard).toHaveBeenCalledTimes(2);
    expect(createdEngines).toHaveLength(0);

    const original = await callChat(makeContext(sessions), {
      sessionId: "old-session",
      message: "yes",
    });

    expect(original.ok).toBe(true);
    expect(retained.handle).toHaveBeenCalledWith("yes");
  });

  it("persists a terminal wizard reply generated during recovery only once", async () => {
    const retained = makeEngine();
    const history = [
      { role: "user" as const, text: "connect matrix" },
      { role: "assistant" as const, text: "Applying channel setup." },
    ];
    retained.hasLockedHostedWizard.mockReturnValue(true);
    retained.historyLength.mockImplementation(() => history.length);
    retained.historySince.mockImplementation((index: number) => history.slice(index));
    retained.resumeLockedHostedWizard.mockImplementation(async () => {
      if (history.length === 2) {
        history.push({ role: "assistant", text: "Done — matrix is configured." });
      }
      return { text: "Done — matrix is configured.", action: "none" };
    });
    const sessions = new Map<string, SystemAgentChatSession>([
      ["old-session", seededSession({ engine: retained })],
    ]);

    const first = await callChat(makeContext(sessions), { sessionId: "new-session" });
    const retry = await callChat(makeContext(sessions), { sessionId: "new-session" });

    expect(first.payload).toMatchObject({ reply: "Done — matrix is configured." });
    expect(retry.payload).toMatchObject({ reply: "Done — matrix is configured." });
    expect(transcriptMocks.appendTranscriptTurn).toHaveBeenCalledOnce();
    expect(transcriptMocks.appendTranscriptTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "assistant",
        text: "Done — matrix is configured.",
      }),
    );
  });

  it("requires a welcome handshake before aliasing a locked wizard", async () => {
    const retained = makeEngine();
    retained.hasLockedHostedWizard.mockReturnValue(true);
    const sessions = new Map<string, SystemAgentChatSession>([
      ["old-session", seededSession({ engine: retained })],
    ]);

    const call = await callChat(makeContext(sessions), {
      sessionId: "unproven-session",
      message: "yes",
    });

    expect(call).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
    expect(sessions.has("old-session")).toBe(true);
    expect(sessions.has("unproven-session")).toBe(false);
    expect(retained.handle).not.toHaveBeenCalled();
    expect(createdEngines).toHaveLength(0);
  });

  it("does not adopt a locked wizard owned by another caller", async () => {
    const retained = makeEngine();
    retained.hasLockedHostedWizard.mockReturnValue(true);
    const sessions = new Map<string, SystemAgentChatSession>([
      [
        "owner-session",
        seededSession({
          engine: retained,
          ownerKey: "user:owner@example.com",
        }),
      ],
    ]);

    const call = await callChat(
      makeContext(sessions),
      { sessionId: "attacker-session" },
      makeClient({
        connId: "attacker-connection",
        authenticatedUserId: "attacker@example.com",
      }),
    );

    expect(call.ok).toBe(true);
    expect(sessions.get("owner-session")?.engine).toBe(retained);
    expect(sessions.get("attacker-session")?.engine).not.toBe(retained);
    expect(retained.resumeLockedHostedWizard).not.toHaveBeenCalled();
  });

  it("refuses ambiguous adoption when one owner has multiple locked wizards", async () => {
    const first = makeEngine();
    const second = makeEngine();
    first.hasLockedHostedWizard.mockReturnValue(true);
    second.hasLockedHostedWizard.mockReturnValue(true);
    const sessions = new Map<string, SystemAgentChatSession>([
      ["first", seededSession({ engine: first })],
      ["second", seededSession({ engine: second })],
    ]);

    const call = await callChat(makeContext(sessions), { sessionId: "replacement" });

    expect(call).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
    expect(sessions.has("first")).toBe(true);
    expect(sessions.has("second")).toBe(true);
    expect(sessions.has("replacement")).toBe(false);
    expect(createdEngines).toHaveLength(0);
  });

  it("binds a new non-delegated session and rejects another principal", async () => {
    const sessions = new Map<string, SystemAgentChatSession>();
    const context = makeContext(sessions);
    const owner = makeClient({
      connId: "conn-owner",
      deviceId: "device-owner",
      authenticatedUserId: "owner@example.com",
    });
    const attacker = makeClient({
      connId: "conn-attacker",
      deviceId: "device-attacker",
      authenticatedUserId: "attacker@example.com",
    });

    expect(await callChat(context, { sessionId: "owned-session" }, owner)).toMatchObject({
      ok: true,
    });
    expect(sessions.get("owned-session")?.ownerKey).toBe("user:owner@example.com");
    const handle = expectDefined(createdEngines[0], "created system-agent engine").handle;

    const turn = await callChat(
      context,
      { sessionId: "owned-session", message: "show status" },
      attacker,
    );
    const approval = await callChat(
      context,
      { sessionId: "owned-session", message: "yes" },
      attacker,
    );
    const reset = await callChat(context, { sessionId: "owned-session", reset: true }, attacker);

    expect(turn).toMatchObject({
      ok: false,
      payload: undefined,
      error: { code: "INVALID_REQUEST" },
    });
    expect(approval).toMatchObject({
      ok: false,
      payload: undefined,
      error: { code: "INVALID_REQUEST" },
    });
    expect(reset).toMatchObject({
      ok: false,
      payload: undefined,
      error: { code: "INVALID_REQUEST" },
    });
    expect(handle).not.toHaveBeenCalled();
    expect(
      expectDefined(createdEngines[0], "created system-agent engine").dispose,
    ).not.toHaveBeenCalled();
  });

  it("lets the same authenticated principal resume after reconnecting", async () => {
    const sessions = new Map<string, SystemAgentChatSession>();
    const context = makeContext(sessions);
    await callChat(
      context,
      { sessionId: "reconnect" },
      makeClient({
        connId: "conn-old",
        deviceId: "device-old",
        authenticatedUserId: "owner@example.com",
      }),
    );
    const handle = expectDefined(createdEngines[0], "created system-agent engine").handle;

    const resumed = await callChat(
      context,
      { sessionId: "reconnect", message: "continue" },
      makeClient({
        connId: "conn-new",
        deviceId: "device-new",
        authenticatedUserId: "owner@example.com",
      }),
    );

    expect(resumed.ok).toBe(true);
    expect(handle).toHaveBeenCalledWith("continue");
  });

  it("lets the same paired device resume after reconnecting", async () => {
    const sessions = new Map<string, SystemAgentChatSession>();
    const context = makeContext(sessions);
    await callChat(
      context,
      { sessionId: "device-reconnect" },
      makeClient({ connId: "conn-old", deviceId: "device-owner" }),
    );
    const handle = expectDefined(createdEngines[0], "created system-agent engine").handle;

    const resumed = await callChat(
      context,
      { sessionId: "device-reconnect", message: "continue" },
      makeClient({ connId: "conn-new", deviceId: "device-owner" }),
    );

    expect(resumed.ok).toBe(true);
    expect(handle).toHaveBeenCalledWith("continue");
  });

  it("lets shared-auth sessions resume after credential rotation", async () => {
    const sessions = new Map<string, SystemAgentChatSession>();
    const context = makeContext(sessions);
    await callChat(
      context,
      { sessionId: "shared-auth-reconnect" },
      makeClient({ connId: "conn-old", sharedAuthGeneration: "generation-old" }),
    );
    const handle = expectDefined(createdEngines[0], "created system-agent engine").handle;

    const resumed = await callChat(
      context,
      { sessionId: "shared-auth-reconnect", message: "continue" },
      makeClient({ connId: "conn-new", sharedAuthGeneration: "generation-new" }),
    );

    expect(resumed.ok).toBe(true);
    expect(handle).toHaveBeenCalledWith("continue");
  });

  it("rejects non-delegated chat without a server-authenticated identity", async () => {
    const call = await callChat(makeContext(new Map()), { sessionId: "anonymous" }, null);

    expect(call).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
  });

  it("keeps device-less auth-none chats scoped to their connection", async () => {
    const sessions = new Map<string, SystemAgentChatSession>();
    const client = makeClient({ connId: "auth-none-connection" });

    const call = await callChat(makeContext(sessions), { sessionId: "auth-none" }, client);

    expect(call.ok).toBe(true);
    expect(sessions.get("auth-none")?.ownerKey).toBe("connection:auth-none-connection");
  });

  it("keeps explicit delegation authoritative across connection identities", async () => {
    const sessions = new Map<string, SystemAgentChatSession>();
    const context = makeContext(sessions);
    const delegation = { agentId: "main", sessionKey: "agent:main:main" };
    await callChat(
      context,
      { sessionId: "delegated", delegation },
      makeClient({ connId: "conn-owner", deviceId: "device-owner" }),
    );
    const handle = expectDefined(createdEngines[0], "created delegated engine").handle;

    const resumed = await callChat(
      context,
      { sessionId: "delegated", message: "continue", delegation },
      makeClient({
        connId: "conn-other",
        deviceId: "device-other",
        authenticatedUserId: "other@example.com",
      }),
    );

    expect(resumed.ok).toBe(true);
    expect(handle).toHaveBeenCalledWith("continue");
  });

  it("rejects delegated reuse of a non-delegated session", async () => {
    const engine = makeEngine();
    const sessions = new Map<string, SystemAgentChatSession>([
      ["shared", seededSession({ engine })],
    ]);

    const delegated = await callChat(makeContext(sessions), {
      sessionId: "shared",
      message: "yes",
      delegation: { agentId: "main", sessionKey: "agent:main:main" },
    });

    expect(delegated).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
    expect(engine.handle).not.toHaveBeenCalled();
  });
});

describe("openclaw.chat session responses", () => {
  it("refuses reset while a hosted wizard owns locked work", async () => {
    const engine = makeEngine();
    engine.dispose.mockResolvedValue(false);
    engine.hasLockedHostedWizard.mockReturnValue(true);
    const sessions = new Map<string, SystemAgentChatSession>([
      ["locked", seededSession({ engine })],
    ]);

    const call = await callChat(makeContext(sessions), { sessionId: "locked", reset: true });

    expect(call).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST" },
    });
    expect(sessions.get("locked")?.engine).toBe(engine);
    expect(engine.dispose).not.toHaveBeenCalled();
  });

  it("evicts the oldest disposable session and keeps locked work owned", async () => {
    const sessions = new Map<string, SystemAgentChatSession>();
    const locked = makeEngine();
    locked.dispose.mockResolvedValue(false);
    locked.hasLockedHostedWizard.mockReturnValue(true);
    sessions.set(
      "locked-oldest",
      seededSession({ engine: locked, ownerKey: "device:other-device" }),
    );
    for (let index = 1; index < 8; index += 1) {
      const engine = makeEngine();
      sessions.set(`candidate-${index}`, seededSession({ engine, ownerKey: "device:device-test" }));
      const session = expectDefined(sessions.get(`candidate-${index}`), "eviction candidate");
      session.lastUsedAt = index;
    }

    const call = await callChat(makeContext(sessions), { sessionId: "replacement" });

    expect(call.ok).toBe(true);
    expect(sessions.has("locked-oldest")).toBe(true);
    expect(sessions.has("candidate-1")).toBe(false);
    expect(sessions.has("replacement")).toBe(true);
    expect(sessions.size).toBe(8);
    expect(locked.dispose).not.toHaveBeenCalled();
  });

  it("rejects a new session when every eviction candidate owns locked work", async () => {
    const sessions = new Map<string, SystemAgentChatSession>();
    for (let index = 0; index < 8; index += 1) {
      const engine = makeEngine();
      engine.dispose.mockResolvedValue(false);
      engine.hasLockedHostedWizard.mockReturnValue(true);
      sessions.set(
        `locked-${index}`,
        seededSession({ engine, ownerKey: `device:locked-device-${index}` }),
      );
    }
    transcriptMocks.appendTranscriptTurn.mockClear();
    const replacementHistory = [{ role: "assistant" as const, text: "welcome text" }];

    const callPromise = callChat(makeContext(sessions), { sessionId: "replacement" });
    await vi.waitFor(() => expect(createdEngines).toHaveLength(1));
    expectDefined(createdEngines[0], "replacement engine").historySince.mockReturnValue(
      replacementHistory,
    );
    const call = await callPromise;

    expect(call).toMatchObject({ ok: false, error: { code: "UNAVAILABLE" } });
    expect(sessions.size).toBe(8);
    expect(sessions.has("replacement")).toBe(false);
    expect(expectDefined(createdEngines[0], "replacement engine").dispose).toHaveBeenCalledOnce();
    expect(transcriptMocks.appendTranscriptTurn).not.toHaveBeenCalled();
  });

  it("revokes an evicted session before asynchronous cleanup yields", async () => {
    let releaseCleanup!: () => void;
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const sessions = new Map<string, SystemAgentChatSession>();
    const candidateEngine = makeEngine();
    const candidate = seededSession({ engine: candidateEngine });
    candidate.pendingApproval = { id: "approval-1", proposalHash: "hash-1" };
    candidateEngine.dispose.mockReturnValue(cleanupGate.then(() => true));
    sessions.set("candidate", candidate);
    for (let index = 1; index < 8; index += 1) {
      const session = seededSession();
      session.lastUsedAt = index;
      sessions.set(`existing-${index}`, session);
    }
    const expire = vi.fn();

    const call = callChat(makeContext(sessions, { expire }), { sessionId: "replacement" });
    await vi.waitFor(() => expect(candidate.engine.dispose).toHaveBeenCalledOnce());

    expect(sessions.has("candidate")).toBe(false);
    expect(expire).toHaveBeenCalledWith("approval-1", "session-evicted");
    releaseCleanup();
    expect((await call).ok).toBe(true);
  });

  it("retains locked work when inference failure cleanup refuses disposal", async () => {
    const engine = makeEngine();
    engine.handle.mockRejectedValue(new SystemAgentInferenceUnavailableError("conversation"));
    engine.dispose.mockResolvedValue(false);
    const sessions = new Map<string, SystemAgentChatSession>([
      ["locked", seededSession({ engine })],
    ]);

    const call = await callChat(makeContext(sessions), {
      sessionId: "locked",
      message: "continue",
    });

    expect(call).toMatchObject({ ok: false, error: { code: "UNAVAILABLE" } });
    expect(sessions.get("locked")?.engine).toBe(engine);
    expect(engine.dispose).toHaveBeenCalledOnce();
  });

  it("removes every reconnect alias after inference failure cleanup", async () => {
    const engine = makeEngine();
    engine.handle.mockRejectedValue(new SystemAgentInferenceUnavailableError("conversation"));
    const session = seededSession({ engine });
    const sessions = new Map<string, SystemAgentChatSession>([
      ["original", session],
      ["reconnected", session],
    ]);

    const call = await callChat(makeContext(sessions), {
      sessionId: "reconnected",
      message: "continue",
    });

    expect(call).toMatchObject({ ok: false, error: { code: "UNAVAILABLE" } });
    expect(engine.dispose).toHaveBeenCalledOnce();
    expect(sessions.has("original")).toBe(false);
    expect(sessions.has("reconnected")).toBe(false);
  });

  it("returns the stored welcome when no message is sent", async () => {
    const sessions = new Map<string, SystemAgentChatSession>([["s1", seededSession()]]);
    const call = await callChat(makeContext(sessions), { sessionId: "s1" });

    expect(call).toMatchObject({
      ok: true,
      payload: { sessionId: "s1", reply: "welcome text", action: "none" },
    });
  });

  it("routes messages through the session engine", async () => {
    const engine = makeEngine();
    const sessions = new Map<string, SystemAgentChatSession>([["s1", seededSession({ engine })]]);

    const call = await callChat(makeContext(sessions), { sessionId: "s1", message: "status" });

    expect(engine.handle).toHaveBeenCalledWith("status");
    expect(call.payload).toMatchObject({ reply: "did the thing", action: "none" });
  });

  it("forwards sensitive-input metadata", async () => {
    const engine = makeEngine();
    engine.handle.mockResolvedValue({
      text: "Enter the bot token",
      action: "none",
      sensitive: true,
    });
    const sessions = new Map<string, SystemAgentChatSession>([["s1", seededSession({ engine })]]);

    const call = await callChat(makeContext(sessions), { sessionId: "s1", message: "yes" });

    expect(call.payload).toMatchObject({ sensitive: true });
  });

  it("maps the TUI handoff to an open-agent action", async () => {
    const engine = makeEngine();
    engine.handle.mockResolvedValue({
      text: "",
      action: "open-tui",
      handoff: { kind: "open-tui" },
    });
    const sessions = new Map<string, SystemAgentChatSession>([["s1", seededSession({ engine })]]);

    const call = await callChat(makeContext(sessions), {
      sessionId: "s1",
      message: "talk to agent",
    });

    expect(call.payload).toMatchObject({ action: "open-agent" });
    expect(call.payload).not.toHaveProperty("agentDraft");
    expect((call.payload as { reply: string }).reply).toContain("continue with your agent");
  });

  it("forwards the hatch draft intent with an agent handoff", async () => {
    const engine = makeEngine();
    engine.handle.mockResolvedValue({
      text: "Your agent is hatching.",
      action: "open-tui",
      agentDraft: "hatch",
      handoff: { kind: "open-tui", agentId: "researcher" },
    });
    const sessions = new Map<string, SystemAgentChatSession>([["s1", seededSession({ engine })]]);

    const call = await callChat(makeContext(sessions), { sessionId: "s1", message: "yes" });

    expect(call.payload).toMatchObject({
      action: "open-agent",
      agentDraft: "hatch",
      agentId: "researcher",
    });
  });
});

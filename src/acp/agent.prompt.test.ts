import type { AgentSideConnection, SessionUpdate } from "@agentclientprotocol/sdk";
import { createInMemorySessionStore } from "@openclaw/acp-core/session";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emitAgentEvent, resetAgentEventsForTest } from "../infra/agent-events.js";
import { AcpAgent } from "./agent.js";
import { createInMemoryAcpEventLedger } from "./event-ledger.js";
import type { AcpLocalSessionRuntime } from "./local-session-runtime.js";

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

function createHarness(
  executeAgent: (...args: never[]) => Promise<unknown>,
  opts: {
    prefixCwd?: boolean;
    provenanceMode?: "off" | "meta" | "meta+receipt";
    sessionUpdate?: AgentSideConnection["sessionUpdate"];
  } = {},
) {
  const updates: Array<{ sessionId: string; update: SessionUpdate }> = [];
  const connection = {
    requestPermission: vi.fn(),
    sessionUpdate:
      opts.sessionUpdate ??
      vi.fn(async (params: { sessionId: string; update: SessionUpdate }) => {
        updates.push(params);
      }),
  } as unknown as AgentSideConnection;
  const sessionStore = createInMemorySessionStore();
  sessionStore.createSession({
    sessionId: "session-1",
    sessionKey: "agent:main:session-1",
    cwd: "/tmp/acp-project",
  });
  const agent = new AcpAgent(connection, {
    ...opts,
    eventLedger: createInMemoryAcpEventLedger(),
    executeAgent: executeAgent as never,
    sessionRuntime: createSessionRuntime(),
    sessionStore,
  });
  return { agent, updates };
}

afterEach(() => {
  resetAgentEventsForTest();
});

describe("AcpAgent prompts", () => {
  it("passes prompt text, images, cwd, and local-run policy to the embedded agent", async () => {
    const executeAgent = vi.fn(async () => ({ payloads: [], meta: {} }));
    const { agent } = createHarness(executeAgent);

    await agent.prompt({
      sessionId: "session-1",
      prompt: [
        { type: "text", text: "inspect this" },
        {
          type: "resource",
          resource: { uri: "file:///tmp/spec.txt", text: "spec contents" },
        },
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
      ],
    });

    expect(executeAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("[Working directory: /tmp/acp-project]"),
        transcriptMessage: expect.stringContaining("inspect this"),
        images: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
        cwd: "/tmp/acp-project",
        deliver: false,
        allowModelOverride: false,
        inputProvenance: {
          kind: "external_user",
          sourceChannel: "acp",
        },
      }),
      expect.any(Object),
    );
    const firstCall = executeAgent.mock.calls[0]?.[0] as { message?: string } | undefined;
    expect(firstCall?.message).toContain("spec contents");
  });

  it("releases prompt generation bookkeeping after a completed turn", async () => {
    const executeAgent = vi.fn(async () => ({ payloads: [], meta: {} }));
    const { agent } = createHarness(executeAgent);
    const internals = agent as unknown as {
      promptCompletions: Map<Promise<unknown>, string>;
      promptGenerations: Map<string, number>;
    };

    await agent.prompt({
      sessionId: "session-1",
      prompt: [{ type: "text", text: "finish normally" }],
    });
    await vi.waitFor(() => expect(internals.promptCompletions.size).toBe(0));

    expect(internals.promptGenerations.size).toBe(0);
    await agent.cancel({ sessionId: "session-1" });
    expect(internals.promptGenerations.size).toBe(0);
  });

  it("honors cwd prefix controls and optional provenance receipts", async () => {
    const withoutPrefix = vi.fn(async () => ({ payloads: [], meta: {} }));
    const first = createHarness(withoutPrefix, { prefixCwd: false });
    await first.agent.prompt({
      sessionId: "session-1",
      prompt: [{ type: "text", text: "plain prompt" }],
    });
    expect(withoutPrefix.mock.calls[0]?.[0]).toMatchObject({ message: "plain prompt" });

    const withReceipt = vi.fn(async () => ({ payloads: [], meta: {} }));
    const second = createHarness(withReceipt, { provenanceMode: "meta+receipt" });
    await second.agent.prompt({
      sessionId: "session-1",
      prompt: [{ type: "text", text: "receipt prompt" }],
    });
    const message = (withReceipt.mock.calls[0]?.[0] as { message?: string } | undefined)?.message;
    expect(message).toContain("[Source Receipt]");
    expect(message).toContain("adapter=openclaw-acp");
    expect(message).toContain("targetSession=agent:main:session-1");
    expect(message).toContain("receipt prompt");
  });

  it("rejects prompts larger than the ACP process limit before execution", async () => {
    const executeAgent = vi.fn(async () => ({ payloads: [], meta: {} }));
    const { agent } = createHarness(executeAgent, { prefixCwd: false });

    await expect(
      agent.prompt({
        sessionId: "session-1",
        prompt: [{ type: "text", text: "x".repeat(2 * 1024 * 1024 + 1) }],
      }),
    ).rejects.toThrow("Prompt exceeds maximum allowed size");
    expect(executeAgent).not.toHaveBeenCalled();
  });

  it("projects assistant, thought, and tool events directly to ACP updates", async () => {
    const executeAgent = vi.fn(async (opts: { runId: string }) => {
      emitAgentEvent({
        runId: opts.runId,
        stream: "thinking",
        data: { delta: "considering" },
      });
      emitAgentEvent({
        runId: opts.runId,
        stream: "assistant",
        data: { delta: "answer" },
      });
      emitAgentEvent({
        runId: opts.runId,
        stream: "tool",
        data: {
          phase: "start",
          toolCallId: "tool-1",
          name: "read",
          args: { path: "/tmp/acp-project/file.txt" },
        },
      });
      emitAgentEvent({
        runId: opts.runId,
        stream: "tool",
        data: {
          phase: "result",
          toolCallId: "tool-1",
          result: "file contents",
        },
      });
      return { payloads: [{ text: "answer" }], meta: {} };
    });
    const { agent, updates } = createHarness(executeAgent);

    await agent.prompt({
      sessionId: "session-1",
      prompt: [{ type: "text", text: "run tools" }],
    });

    expect(updates.map((entry) => entry.update.sessionUpdate)).toEqual(
      expect.arrayContaining([
        "agent_thought_chunk",
        "agent_message_chunk",
        "tool_call",
        "tool_call_update",
      ]),
    );
    expect(
      updates.filter((entry) => entry.update.sessionUpdate === "agent_message_chunk"),
    ).toHaveLength(1);
    expect(
      updates.find((entry) => entry.update.sessionUpdate === "tool_call")?.update,
    ).toMatchObject({
      toolCallId: "tool-1",
      status: "in_progress",
      locations: [{ path: "/tmp/acp-project/file.txt" }],
    });
    expect(
      updates.find((entry) => entry.update.sessionUpdate === "tool_call_update")?.update,
    ).toMatchObject({
      toolCallId: "tool-1",
      status: "completed",
    });
  });

  it("preserves leading whitespace while deduplicating the final payload", async () => {
    const executeAgent = vi.fn(async (opts: { runId: string }) => {
      emitAgentEvent({
        runId: opts.runId,
        stream: "assistant",
        data: { delta: "  indented" },
      });
      return { payloads: [{ text: "  indented" }], meta: {} };
    });
    const { agent, updates } = createHarness(executeAgent);

    await agent.prompt({
      sessionId: "session-1",
      prompt: [{ type: "text", text: "format this" }],
    });

    expect(
      updates
        .filter((entry) => entry.update.sessionUpdate === "agent_message_chunk")
        .map((entry) => entry.update),
    ).toEqual([
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "  indented" },
      },
    ]);
  });

  it.each(["max_tokens", "max_turn_requests", "refusal"] as const)(
    "preserves the %s stop reason from the local run",
    async (stopReason) => {
      const executeAgent = vi.fn(async () => ({
        payloads: [],
        meta: { stopReason },
      }));
      const { agent } = createHarness(executeAgent);

      await expect(
        agent.prompt({
          sessionId: "session-1",
          prompt: [{ type: "text", text: "finish" }],
        }),
      ).resolves.toEqual({ stopReason });
    },
  );

  it("keeps a finishing stop reason when the final lifecycle event omits it", async () => {
    const executeAgent = vi.fn(async (opts: { runId: string }) => {
      emitAgentEvent({
        runId: opts.runId,
        stream: "lifecycle",
        data: { phase: "finishing", stopReason: "max_tokens" },
      });
      emitAgentEvent({
        runId: opts.runId,
        stream: "lifecycle",
        data: { phase: "end" },
      });
      return { payloads: [], meta: {} };
    });
    const { agent } = createHarness(executeAgent);

    await expect(
      agent.prompt({
        sessionId: "session-1",
        prompt: [{ type: "text", text: "finish" }],
      }),
    ).resolves.toEqual({ stopReason: "max_tokens" });
  });

  it("propagates local execution failures after draining projected events", async () => {
    const executeAgent = vi.fn(async (opts: { runId: string }) => {
      emitAgentEvent({
        runId: opts.runId,
        stream: "assistant",
        data: { delta: "partial" },
      });
      throw new Error("model failed");
    });
    const { agent, updates } = createHarness(executeAgent);

    await expect(
      agent.prompt({
        sessionId: "session-1",
        prompt: [{ type: "text", text: "fail" }],
      }),
    ).rejects.toThrow("model failed");
    expect(updates).toContainEqual({
      sessionId: "session-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "partial" },
      },
    });
  });

  it("fails the prompt when an ACP event cannot be projected", async () => {
    const executeAgent = vi.fn(async (opts: { runId: string }) => {
      emitAgentEvent({
        runId: opts.runId,
        stream: "assistant",
        data: { delta: "answer" },
      });
      return { payloads: [{ text: "answer" }], meta: {} };
    });
    const sessionUpdate = vi.fn(async () => {
      throw new Error("session update transport failed");
    });
    const { agent } = createHarness(executeAgent, { sessionUpdate });

    await expect(
      agent.prompt({
        sessionId: "session-1",
        prompt: [{ type: "text", text: "project this" }],
      }),
    ).rejects.toThrow("session update transport failed");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { runOpenClawRuntimeTurn } from "./openclaw-runtime-turn.js";

const mocks = vi.hoisted(() => {
  const deps = { marker: "default-deps" };
  return {
    agentCommandFromIngress: vi.fn(),
    createDefaultDeps: vi.fn(() => deps),
    deps,
  };
});

vi.mock("./agent-command.js", () => ({
  agentCommandFromIngress: mocks.agentCommandFromIngress,
}));

vi.mock("../cli/deps.js", () => ({
  createDefaultDeps: mocks.createDefaultDeps,
}));

function createInput(timeoutMs?: number) {
  return {
    runId: "run-1",
    sessionKey: "agent:main:main",
    message: "hello",
    messageChannel: "webchat",
    abortSignal: new AbortController().signal,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
}

describe("runOpenClawRuntimeTurn", () => {
  beforeEach(() => {
    mocks.agentCommandFromIngress.mockReset();
    mocks.agentCommandFromIngress.mockResolvedValue(undefined);
  });

  it("maps the runtime turn into the canonical ingress execution environment", async () => {
    const result = {
      payloads: [{ text: "done" }],
      meta: { durationMs: 1 },
    };
    const abortSignal = new AbortController().signal;
    mocks.agentCommandFromIngress.mockResolvedValue(result);

    await expect(
      runOpenClawRuntimeTurn({
        runId: "run-1",
        sessionKey: "agent:work:main",
        message: "hello",
        messageChannel: "webchat",
        abortSignal,
        agentId: "work",
        sessionId: "session-1",
        thinking: "high",
        timeoutMs: 1_001,
        deliver: false,
      }),
    ).resolves.toBe(result);

    expect(mocks.agentCommandFromIngress).toHaveBeenCalledWith(
      {
        runId: "run-1",
        sessionKey: "agent:work:main",
        message: "hello",
        channel: "webchat",
        runContext: { messageChannel: "webchat" },
        abortSignal,
        agentId: "work",
        sessionId: "session-1",
        thinking: "high",
        timeout: "2",
        deliver: false,
        allowModelOverride: false,
      },
      expect.objectContaining({
        log: expect.any(Function),
        error: expect.any(Function),
        exit: expect.any(Function),
      }),
      mocks.deps,
    );

    await runOpenClawRuntimeTurn(createInput());
    expect(mocks.createDefaultDeps).toHaveBeenCalledTimes(1);
    expect(mocks.agentCommandFromIngress.mock.calls.at(1)?.[2]).toBe(mocks.deps);
  });

  it.each([
    { timeoutMs: undefined, expected: undefined },
    { timeoutMs: 0, expected: "0" },
    { timeoutMs: 1.1, expected: "1" },
    { timeoutMs: 1_001, expected: "2" },
    { timeoutMs: -1, expected: undefined },
    { timeoutMs: Number.POSITIVE_INFINITY, expected: undefined },
  ])(
    "maps $timeoutMs milliseconds to $expected ingress seconds",
    async ({ timeoutMs, expected }) => {
      await runOpenClawRuntimeTurn(createInput(timeoutMs));

      const ingress = mocks.agentCommandFromIngress.mock.calls.at(0)?.[0] as
        | { timeout?: string }
        | undefined;
      expect(ingress?.timeout).toBe(expected);
    },
  );

  it("forwards execution failures unchanged", async () => {
    const error = new Error("run failed");
    mocks.agentCommandFromIngress.mockRejectedValueOnce(error);

    await expect(runOpenClawRuntimeTurn(createInput())).rejects.toBe(error);
  });
});

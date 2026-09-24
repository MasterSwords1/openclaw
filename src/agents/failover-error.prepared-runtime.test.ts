import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { PluginInstanceUnavailableError } from "../plugins/plugin-instance-error.js";
import { runEmbeddedAgentEntry } from "./embedded-agent-runner/run-entry.js";
import { createDirectHarness, makeResult } from "./embedded-agent-runner/run-entry.test-support.js";
import {
  FailoverError,
  coerceToFailoverError,
  describeFailoverError,
  isNonProviderRuntimeCoordinationError,
  resolveFailoverReasonFromError,
  resolveModelFallbackError,
} from "./failover-error.js";
import { runWithModelFallback } from "./model-fallback-runner.js";
import {
  PreparedModelRuntimeOwnerNotPublishedError,
  PreparedModelRuntimePluginGenerationRetiredError,
  PreparedModelRuntimePublicationSupersededError,
} from "./prepared-model-runtime.errors.js";

vi.mock("./harness/runtime-plugin.js", () => ({
  ensureSelectedAgentHarnessPlugin: vi.fn(async () => undefined),
}));

describe("prepared model runtime coordination failures", () => {
  it.each([
    [
      "prepared model runtime publication superseded",
      () =>
        new PreparedModelRuntimePublicationSupersededError(
          "prepared model runtime publication was superseded for /test/agent",
        ),
    ],
    [
      "prepared model runtime owner not published",
      () =>
        new PreparedModelRuntimeOwnerNotPublishedError(
          "prepared model runtime owner is not published",
        ),
    ],
    [
      "prepared model runtime plugin generation retired",
      () =>
        new PreparedModelRuntimePluginGenerationRetiredError(
          "prepared model runtime plugin generation retired",
        ),
    ],
    ["plugin instance unavailable", () => new PluginInstanceUnavailableError("test-plugin")],
  ])("classifies direct and nested %s as coordination errors", (_label, makeError) => {
    const coordination = makeError();
    for (const error of [
      coordination,
      new Error("turn failed", { cause: coordination }),
      new AggregateError([coordination], "turn failed"),
    ]) {
      expect(isNonProviderRuntimeCoordinationError(error)).toBe(true);
      expect(resolveModelFallbackError(error)).toEqual({ kind: "coordination", error });
      expect(resolveFailoverReasonFromError(error)).toBeNull();
      expect(coerceToFailoverError(error)).toBeNull();
      expect(describeFailoverError(error)).toMatchObject({
        reason: undefined,
      });
    }
  });

  it("aborts model fallback immediately when primary candidate encounters superseded publication", async () => {
    const supersededError = new PreparedModelRuntimePublicationSupersededError(
      "prepared model runtime publication was superseded for /agents/test",
    );
    const run = vi.fn().mockImplementation(async (provider: string, model: string) => {
      if (provider === "openai" && model === "gpt-6-luna") {
        throw supersededError;
      }
      return { text: "fallback reply" };
    });
    const onError = vi.fn();
    const onFallbackStep = vi.fn();

    await expect(
      runWithModelFallback({
        cfg: undefined,
        provider: "openai",
        model: "gpt-6-luna",
        fallbacksOverride: ["xai/grok-4.7"],
        skipAuthProfileRuntime: true,
        run,
        onError,
        onFallbackStep,
      }),
    ).rejects.toBe(supersededError);

    // Primary failure must stop the chain immediately: never rotate to fallback models
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith("openai", "gpt-6-luna", expect.anything());
    expect(onError).not.toHaveBeenCalled();
    expect(onFallbackStep).not.toHaveBeenCalledWith(
      expect.objectContaining({ decision: "candidate_failed" }),
    );
  });

  it("aborts model fallback on wrapped superseded publication error", async () => {
    const rootError = new PreparedModelRuntimePublicationSupersededError(
      "prepared model runtime publication was superseded for /agents/test",
    );
    const wrappedError = new Error("lane task error", { cause: rootError });
    const run = vi.fn().mockRejectedValueOnce(wrappedError).mockResolvedValueOnce("too late");

    await expect(
      runWithModelFallback({
        cfg: undefined,
        provider: "openai",
        model: "gpt-6-luna",
        fallbacksOverride: ["xai/grok-4.7"],
        skipAuthProfileRuntime: true,
        run,
      }),
    ).rejects.toBe(wrappedError);

    expect(run).toHaveBeenCalledTimes(1);
  });

  describe("production runtime boundary (runEmbeddedAgentEntry)", () => {
    it("aborts execution immediately on superseded publication without attempting secondary fallbacks", async () => {
      const supersededError = new PreparedModelRuntimePublicationSupersededError(
        "prepared model runtime publication was superseded for /agents/main",
      );
      const candidateCalls: Array<{ provider: string; model: string }> = [];
      const fallbackSteps: Array<{ decision: string }> = [];

      await expect(
        runEmbeddedAgentEntry({
          selection: {
            cfg: {} as OpenClawConfig,
            provider: "openai",
            model: "gpt-6-luna",
            fallbacksOverride: ["xai/grok-4.7"],
          },
          identity: {
            runId: "run-superseded-boundary",
            agentId: "main",
            sessionId: "session-1",
          },
          harness: createDirectHarness(),
          behavior: { kind: "command-rpc", hasCommittedSideEffect: () => false },
          sessionOverride: { kind: "preserve" },
          onFallbackStep: (step) => {
            fallbackSteps.push(step as { decision: string });
          },
          runCandidate: async (provider, model) => {
            candidateCalls.push({ provider, model });
            if (provider === "openai" && model === "gpt-6-luna") {
              throw supersededError;
            }
            return makeResult({ provider, model });
          },
        }),
      ).rejects.toBe(supersededError);

      // Fault verification: runtime boundary halts on first candidate, never calls secondary fallback
      expect(candidateCalls).toEqual([{ provider: "openai", model: "gpt-6-luna" }]);
      expect(fallbackSteps).toHaveLength(0);
    });

    it("advances to fallback candidate on ordinary provider error (control)", async () => {
      const providerError = new FailoverError("rate limit exceeded", {
        provider: "openai",
        model: "gpt-6-luna",
        reason: "rate_limit",
        status: 429,
      });
      const candidateCalls: Array<{ provider: string; model: string }> = [];
      const fallbackSteps: Array<{ decision: string }> = [];

      const result = await runEmbeddedAgentEntry({
        selection: {
          cfg: {} as OpenClawConfig,
          provider: "openai",
          model: "gpt-6-luna",
          fallbacksOverride: ["xai/grok-4.7"],
        },
        identity: {
          runId: "run-fallback-control",
          agentId: "main",
          sessionId: "session-1",
        },
        harness: createDirectHarness(),
        behavior: { kind: "command-rpc", hasCommittedSideEffect: () => false },
        sessionOverride: { kind: "preserve" },
        onFallbackStep: (step) => {
          fallbackSteps.push(step as { decision: string });
        },
        runCandidate: async (provider, model) => {
          candidateCalls.push({ provider, model });
          if (provider === "openai" && model === "gpt-6-luna") {
            throw providerError;
          }
          return makeResult({ provider, model });
        },
      });

      // Control verification: provider error advances to xai/grok-4.7
      expect(result.provider).toBe("xai");
      expect(result.model).toBe("grok-4.7");
      expect(candidateCalls).toEqual([
        { provider: "openai", model: "gpt-6-luna" },
        { provider: "xai", model: "grok-4.7" },
      ]);
      expect(fallbackSteps).toEqual([
        expect.objectContaining({
          fallbackStepFinalOutcome: "next_fallback",
          fallbackStepFromFailureReason: "rate_limit",
          fallbackStepFromModel: "openai/gpt-6-luna",
          fallbackStepToModel: "xai/grok-4.7",
        }),
        expect.objectContaining({
          fallbackStepFinalOutcome: "succeeded",
          fallbackStepFromModel: "openai/gpt-6-luna",
          fallbackStepToModel: "xai/grok-4.7",
        }),
      ]);
    });
  });
});

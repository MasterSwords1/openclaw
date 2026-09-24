import { describe, expect, it, vi } from "vitest";
import { PluginInstanceUnavailableError } from "../plugins/plugin-instance-error.js";
import {
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
});

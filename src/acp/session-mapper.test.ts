/** Tests ACP metadata parsing and local session-runtime delegation. */
import { describe, expect, it, vi } from "vitest";
import type { AcpLocalSessionRuntime } from "./local-session-runtime.js";
import { parseSessionMeta, resetSessionIfNeeded, resolveSessionKey } from "./session-mapper.js";

function createRuntime(): {
  runtime: Pick<AcpLocalSessionRuntime, "resetSessionIfNeeded" | "resolveSessionKey">;
  reset: ReturnType<typeof vi.fn>;
  resolve: ReturnType<typeof vi.fn>;
} {
  const resolve = vi.fn(async () => "agent:main:resolved");
  const reset = vi.fn(async () => undefined);
  return {
    runtime: {
      resolveSessionKey: resolve,
      resetSessionIfNeeded: reset,
    },
    reset,
    resolve,
  };
}

describe("acp session mapper", () => {
  it("parses supported routing aliases", () => {
    expect(
      parseSessionMeta({
        session: "agent:main:work",
        label: "support",
        reset: true,
        requireExistingSession: true,
        prefixCwd: false,
      }),
    ).toEqual({
      sessionKey: "agent:main:work",
      sessionLabel: "support",
      resetSession: true,
      requireExisting: true,
      prefixCwd: false,
    });
  });

  it("delegates resolution without a Gateway-shaped request facade", async () => {
    const { runtime, resolve } = createRuntime();
    const meta = parseSessionMeta({ sessionLabel: "support" });

    await expect(
      resolveSessionKey({
        meta,
        fallbackKey: "acp:fallback",
        runtime,
      }),
    ).resolves.toBe("agent:main:resolved");

    expect(resolve).toHaveBeenCalledWith({
      meta: { sessionLabel: "support" },
      fallbackKey: "acp:fallback",
    });
  });

  it("delegates optional reset behavior to the local runtime", async () => {
    const { runtime, reset } = createRuntime();
    const meta = parseSessionMeta({ resetSession: true });

    await resetSessionIfNeeded({
      meta,
      sessionKey: "agent:main:work",
      cwd: "/workspace/project",
      runtime,
    });

    expect(reset).toHaveBeenCalledWith({
      meta: { resetSession: true },
      sessionKey: "agent:main:work",
      cwd: "/workspace/project",
    });
  });
});

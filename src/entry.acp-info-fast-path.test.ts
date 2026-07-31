import { describe, expect, it, vi } from "vitest";
import { ACP_RUNTIME_INFO } from "./acp/runtime-info.js";
import {
  isAcpRuntimeInfoInvocation,
  tryHandleAcpRuntimeInfoFastPath,
} from "./entry.acp-info-fast-path.js";

describe("ACP runtime info fast path", () => {
  it("matches only the exact local ACP info command", () => {
    expect(isAcpRuntimeInfoInvocation(["node", "openclaw", "acp", "info"])).toBe(true);
    expect(isAcpRuntimeInfoInvocation(["node", "openclaw", "acp"])).toBe(false);
    expect(isAcpRuntimeInfoInvocation(["node", "openclaw", "acp", "info", "--help"])).toBe(false);
  });

  it("writes the versioned contract and marks a successful exit before normal CLI startup", () => {
    const output = vi.fn();
    const exit = vi.fn();

    expect(
      tryHandleAcpRuntimeInfoFastPath(["node", "openclaw", "acp", "info"], {
        output,
        exit,
      }),
    ).toBe(true);
    expect(output).toHaveBeenCalledWith(JSON.stringify(ACP_RUNTIME_INFO));
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("defers container-targeted invocations to the normal dispatcher", () => {
    const output = vi.fn();
    const exit = vi.fn();

    expect(
      tryHandleAcpRuntimeInfoFastPath(["node", "openclaw", "--container", "demo", "acp", "info"], {
        output,
        exit,
      }),
    ).toBe(false);
    expect(output).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });
});

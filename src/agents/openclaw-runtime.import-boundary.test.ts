import { describe, expect, it, vi } from "vitest";

const loads = vi.hoisted(() => ({
  agentCommand: vi.fn(),
  cliDeps: vi.fn(),
}));

vi.mock("./agent-command.js", () => {
  loads.agentCommand();
  return { agentCommandFromIngress: vi.fn() };
});

vi.mock("../cli/deps.js", () => {
  loads.cliDeps();
  return { createDefaultDeps: vi.fn() };
});

describe("OpenClaw runtime import boundary", () => {
  it("does not load turn execution dependencies for observer-only consumers", async () => {
    await import("./openclaw-runtime.js");

    expect(loads.agentCommand).not.toHaveBeenCalled();
    expect(loads.cliDeps).not.toHaveBeenCalled();
  });
});

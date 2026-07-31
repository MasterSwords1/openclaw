import { describe, expect, it, vi } from "vitest";
import type { AgentRunApprovalHost, AgentRunExecApprovalLease } from "../agent-run-approval.js";
import { executeNodeClaudeRun } from "./execute-node-claude.js";
import type { PreparedCliRunContext } from "./types.js";

describe("executeNodeClaudeRun", () => {
  it("uses the run-scoped exec approval lease for paired-node retries", async () => {
    const approvalHost: AgentRunApprovalHost = {
      exec: { request: vi.fn() },
    };
    const approvalLease: AgentRunExecApprovalLease = {
      id: "approval-1",
      expiresAtMs: Date.now() + 60_000,
      wait: vi.fn(),
      resolveAutoReview: vi.fn(),
      cancel: vi.fn(),
    };
    const invokeNodeClaudeCliRun = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        payload: {
          approvalRequired: true,
          systemRunPlan: {
            argv: ["/bin/echo", "ok"],
            cwd: "/tmp",
            commandText: "/bin/echo ok",
            agentId: "main",
            sessionKey: "agent:main:main",
          },
          security: "allowlist",
          ask: "always",
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        payload: {
          exitCode: 0,
          stderrTail: "",
          truncated: false,
        },
      });
    const registerExecApprovalRequestForHostOrThrow = vi.fn().mockResolvedValue(approvalLease);
    const resolveRegisteredExecApprovalDecision = vi.fn().mockResolvedValue("allow-once");
    const context = {
      params: {
        timeoutMs: 30_000,
        agentId: "main",
        sessionKey: "agent:main:main",
        approvalHost,
      },
    } as unknown as PreparedCliRunContext;

    await expect(
      executeNodeClaudeRun({
        context,
        nodePlacement: { nodeId: "node-1", cwd: "/tmp" },
        executionArgs: ["claude", "--print"],
        stdinPayload: "hello",
        noOutputTimeoutMs: 10_000,
        consumeStdout: vi.fn(),
        consumeStderr: vi.fn(),
        deps: {
          invokeNodeClaudeCliRun,
          registerExecApprovalRequestForHostOrThrow,
          resolveRegisteredExecApprovalDecision,
        },
      }),
    ).resolves.toMatchObject({
      result: {
        reason: "exit",
        exitCode: 0,
      },
    });

    expect(registerExecApprovalRequestForHostOrThrow).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalHost,
        approvalId: expect.any(String),
        signal: expect.any(AbortSignal),
      }),
    );
    expect(resolveRegisteredExecApprovalDecision).toHaveBeenCalledWith({
      approval: approvalLease,
      preResolvedDecision: undefined,
      signal: expect.any(AbortSignal),
    });
    expect(invokeNodeClaudeCliRun).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        approvalDecision: "allow-once",
        signal: expect.any(AbortSignal),
      }),
    );
  });
});

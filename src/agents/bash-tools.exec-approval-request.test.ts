/**
 * Exec approval request tests.
 * Covers run-host registration, decision waiting, cancellation, and lazy
 * command highlighting for host/node approval payloads.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgentRunExecApprovalRunAbortedError,
  type AgentRunApprovalHost,
  type AgentRunExecApprovalRequest,
} from "./agent-run-approval.js";

const commandExplainerMock = vi.hoisted(() => ({
  importCount: 0,
  explainShellCommand: vi.fn(async (command: string): Promise<string> => command),
  formatCommandSpans: vi.fn((command: string) => {
    if (command.startsWith("pwsh ") || command.startsWith("cmd.exe ")) {
      return [];
    }
    if (command.startsWith("node ")) {
      return [{ startIndex: 0, endIndex: 4 }];
    }
    return [
      { startIndex: 0, endIndex: 2 },
      { startIndex: 0, endIndex: 4 },
      { startIndex: 5, endIndex: 9 },
      { startIndex: 20, endIndex: 26 },
    ];
  }),
}));

vi.mock("../infra/command-explainer/index.js", () => {
  commandExplainerMock.importCount += 1;
  return {
    explainShellCommand: commandExplainerMock.explainShellCommand,
    formatCommandSpans: commandExplainerMock.formatCommandSpans,
  };
});

let registerExecApprovalRequestForHostOrThrow: typeof import("./bash-tools.exec-approval-request.js").registerExecApprovalRequestForHostOrThrow;
let resolveRegisteredExecApprovalDecision: typeof import("./bash-tools.exec-approval-request.js").resolveRegisteredExecApprovalDecision;
let isExecApprovalRunAbortedError: typeof import("./bash-tools.exec-approval-request.js").isExecApprovalRunAbortedError;
const registerApproval = vi.fn();
const waitForDecision = vi.fn();
const resolveAutoReview = vi.fn();
const cancelApproval = vi.fn();
const approvalLease = {
  id: "approval-id",
  expiresAtMs: 1234,
  wait: waitForDecision,
  resolveAutoReview,
  cancel: cancelApproval,
};
const approvalHost: AgentRunApprovalHost = {
  exec: {
    request: registerApproval,
  },
};

const initialProcessPlatform = Object.getOwnPropertyDescriptor(process, "platform");

function setProcessPlatformForTest(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    configurable: true,
    enumerable: true,
    value: platform,
  });
}

function restoreProcessPlatformForTest(): void {
  if (initialProcessPlatform) {
    Object.defineProperty(process, "platform", initialProcessPlatform);
  }
}

function requireApprovalRequestPayload(callIndex: number): AgentRunExecApprovalRequest {
  const payload = registerApproval.mock.calls[callIndex]?.[0]?.request;
  if (!payload) {
    throw new Error(`expected approval request payload ${callIndex}`);
  }
  return payload as AgentRunExecApprovalRequest;
}

describe("exec approval requests", () => {
  beforeAll(async () => {
    ({
      registerExecApprovalRequestForHostOrThrow,
      resolveRegisteredExecApprovalDecision,
      isExecApprovalRunAbortedError,
    } = await import("./bash-tools.exec-approval-request.js"));
  });

  beforeEach(() => {
    registerApproval.mockReset();
    registerApproval.mockImplementation(async ({ request }) => ({
      ...approvalLease,
      id: request.id,
    }));
    waitForDecision.mockReset();
    resolveAutoReview.mockReset();
    cancelApproval.mockReset();
    resolveAutoReview.mockResolvedValue(undefined);
    cancelApproval.mockResolvedValue(undefined);
    commandExplainerMock.explainShellCommand.mockClear();
    commandExplainerMock.formatCommandSpans.mockClear();
    restoreProcessPlatformForTest();
  });

  afterEach(() => {
    restoreProcessPlatformForTest();
  });

  it("does not load the command explainer when importing approval requests", () => {
    expect(commandExplainerMock.importCount).toBe(0);
  });

  it("binds approval registrations to their run and tool call", async () => {
    await registerExecApprovalRequestForHostOrThrow({
      approvalHost,
      approvalId: "approval-id",
      command: "echo hi",
      workdir: "/tmp",
      host: "gateway",
      security: "allowlist",
      ask: "on-miss",
      sessionId: "session-1",
      runId: "run-1",
      toolCallId: "tool-1",
    });

    expect(requireApprovalRequestPayload(0)).toMatchObject({
      sessionId: "session-1",
      runId: "run-1",
      toolCallId: "tool-1",
    });
  });

  it("distinguishes run abort cancellation from unchanged timeout fallback", async () => {
    waitForDecision
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new AgentRunExecApprovalRunAbortedError());

    await expect(
      resolveRegisteredExecApprovalDecision({
        approval: { ...approvalLease, id: "timeout-approval" },
        preResolvedDecision: undefined,
      }),
    ).resolves.toBeNull();
    await expect(
      resolveRegisteredExecApprovalDecision({
        approval: { ...approvalLease, id: "aborted-approval" },
        preResolvedDecision: undefined,
      }),
    ).rejects.toSatisfy(isExecApprovalRunAbortedError);
  });

  it("lets run cancellation win over pre-resolved and concurrently resolved decisions", async () => {
    const preResolvedAbort = new AbortController();
    preResolvedAbort.abort(new AgentRunExecApprovalRunAbortedError());

    await expect(
      resolveRegisteredExecApprovalDecision({
        approval: approvalLease,
        preResolvedDecision: "allow-once",
        signal: preResolvedAbort.signal,
      }),
    ).rejects.toSatisfy(isExecApprovalRunAbortedError);
    expect(waitForDecision).not.toHaveBeenCalled();

    const waitingAbort = new AbortController();
    waitForDecision.mockImplementationOnce(async () => {
      waitingAbort.abort(new AgentRunExecApprovalRunAbortedError());
      return null;
    });
    await expect(
      resolveRegisteredExecApprovalDecision({
        approval: approvalLease,
        preResolvedDecision: undefined,
        signal: waitingAbort.signal,
      }),
    ).rejects.toSatisfy(isExecApprovalRunAbortedError);
  });

  it("fails closed when the run has no exec approval capability", async () => {
    await expect(
      registerExecApprovalRequestForHostOrThrow({
        approvalId: "approval-id",
        command: "echo hi",
        workdir: "/tmp",
        host: "gateway",
        security: "allowlist",
        ask: "on-miss",
      }),
    ).rejects.toThrow("this run has no exec approval host");
  });

  it("cancels a mismatched host lease before failing registration", async () => {
    registerApproval.mockResolvedValueOnce({
      ...approvalLease,
      id: "wrong-approval-id",
    });

    await expect(
      registerExecApprovalRequestForHostOrThrow({
        approvalHost,
        approvalId: "approval-id",
        command: "echo hi",
        workdir: "/tmp",
        host: "gateway",
        security: "allowlist",
        ask: "on-miss",
      }),
    ).rejects.toThrow("mismatched approval id");
    expect(cancelApproval).toHaveBeenCalledOnce();
  });

  it("adds command spans to host approval registration payloads", async () => {
    await registerExecApprovalRequestForHostOrThrow({
      approvalHost,
      approvalId: "approval-id",
      command: 'ls | grep "stuff" | python -c \'print("hi")\'',
      commandHighlighting: true,
      workdir: "/tmp/project",
      host: "node",
      security: "allowlist",
      ask: "always",
    });

    const payload = requireApprovalRequestPayload(0);
    expect(payload?.commandSpans).toStrictEqual([
      { startIndex: 0, endIndex: 2 },
      { startIndex: 0, endIndex: 4 },
      { startIndex: 5, endIndex: 9 },
      { startIndex: 20, endIndex: 26 },
    ]);
  });

  it("does not generate command spans by default", async () => {
    await registerExecApprovalRequestForHostOrThrow({
      approvalHost,
      approvalId: "approval-id",
      command: 'ls | grep "stuff" | python -c \'print("hi")\'',
      workdir: "/tmp/project",
      host: "node",
      security: "allowlist",
      ask: "always",
    });

    expect(commandExplainerMock.explainShellCommand).not.toHaveBeenCalled();
    expect(commandExplainerMock.formatCommandSpans).not.toHaveBeenCalled();
    const payload = requireApprovalRequestPayload(0);
    expect(payload?.commandSpans).toBeUndefined();
  });

  it("does not generate command spans when command highlighting is disabled", async () => {
    await registerExecApprovalRequestForHostOrThrow({
      approvalHost,
      approvalId: "approval-id",
      command: 'ls | grep "stuff" | python -c \'print("hi")\'',
      commandHighlighting: false,
      workdir: "/tmp/project",
      host: "node",
      security: "allowlist",
      ask: "always",
    });

    expect(commandExplainerMock.explainShellCommand).not.toHaveBeenCalled();
    expect(commandExplainerMock.formatCommandSpans).not.toHaveBeenCalled();
    const payload = requireApprovalRequestPayload(0);
    expect(payload?.commandSpans).toBeUndefined();
  });

  it("uses system run plan command text for host approval explanations", async () => {
    await registerExecApprovalRequestForHostOrThrow({
      approvalHost,
      approvalId: "approval-id",
      systemRunPlan: {
        argv: ["node", "-e", "console.log(1)"],
        cwd: "/tmp/project",
        commandText: 'node -e "console.log(1)"',
        agentId: null,
        sessionKey: null,
      },
      commandHighlighting: true,
      workdir: "/tmp/project",
      host: "node",
      security: "allowlist",
      ask: "always",
    });

    const payload = requireApprovalRequestPayload(0);
    expect(payload?.commandSpans).toStrictEqual([{ startIndex: 0, endIndex: 4 }]);
  });

  it("omits generated command spans for unsupported shell wrapper languages", async () => {
    await registerExecApprovalRequestForHostOrThrow({
      approvalHost,
      approvalId: "approval-id-powershell",
      command: 'pwsh -Command "Get-ChildItem"',
      workdir: "/tmp/project",
      host: "node",
      security: "allowlist",
      ask: "always",
    });
    await registerExecApprovalRequestForHostOrThrow({
      approvalHost,
      approvalId: "approval-id-cmd",
      command: 'cmd.exe /d /s /c "dir"',
      workdir: "/tmp/project",
      host: "node",
      security: "allowlist",
      ask: "always",
    });

    expect(registerApproval.mock.calls).toHaveLength(2);
    expect(requireApprovalRequestPayload(0).commandSpans).toBeUndefined();
    expect(requireApprovalRequestPayload(1).commandSpans).toBeUndefined();
  });

  it("omits generated command spans for Windows gateway PowerShell commands", async () => {
    setProcessPlatformForTest("win32");

    await registerExecApprovalRequestForHostOrThrow({
      approvalHost,
      approvalId: "approval-id-powershell",
      command:
        'Set-Content -Path "windows-agent-proof.txt" -Value "WINDOWS_AGENT_EXEC_OK" -NoNewline',
      workdir: "C:\\project",
      host: "gateway",
      security: "allowlist",
      ask: "always",
    });

    expect(commandExplainerMock.formatCommandSpans).not.toHaveBeenCalled();
    expect(registerApproval.mock.calls).toHaveLength(1);
    expect(requireApprovalRequestPayload(0).commandSpans).toBeUndefined();
  });

  it("omits generated command spans for unsupported shell wrappers through system run carriers", async () => {
    await registerExecApprovalRequestForHostOrThrow({
      approvalHost,
      approvalId: "approval-id-carrier",
      systemRunPlan: {
        argv: ["timeout", "5", "pwsh", "-Command", "Get-ChildItem"],
        cwd: "/tmp/project",
        commandText: 'timeout 5 pwsh -Command "Get-ChildItem"',
        agentId: null,
        sessionKey: null,
      },
      workdir: "/tmp/project",
      host: "node",
      security: "allowlist",
      ask: "always",
    });

    expect(commandExplainerMock.formatCommandSpans).not.toHaveBeenCalled();
    expect(registerApproval.mock.calls).toHaveLength(1);
    expect(requireApprovalRequestPayload(0).commandSpans).toBeUndefined();
  });

  it("keeps explicit command spans", async () => {
    await registerExecApprovalRequestForHostOrThrow({
      approvalHost,
      approvalId: "approval-id",
      command: "echo hi",
      commandSpans: [{ startIndex: 0, endIndex: 4 }],
      commandHighlighting: true,
      workdir: "/tmp/project",
      host: "node",
      security: "allowlist",
      ask: "always",
    });

    const payload = requireApprovalRequestPayload(0);
    expect(payload?.commandSpans).toEqual([{ startIndex: 0, endIndex: 4 }]);
  });
});

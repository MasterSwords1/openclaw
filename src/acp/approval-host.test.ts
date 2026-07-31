import type {
  AgentSideConnection,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRunExecApprovalRequest } from "../agents/agent-run-approval.js";
import type { PluginApprovalRequestPayload } from "../infra/plugin-approvals.js";
import { createAcpApprovalHost } from "./approval-host.js";

type TestAcpConnection = AgentSideConnection & {
  permissionSpy: ReturnType<typeof vi.fn>;
};

function createConnection(
  requestPermission: (request: RequestPermissionRequest) => Promise<RequestPermissionResponse>,
): TestAcpConnection {
  const requestPermissionSpy = vi.fn(requestPermission);
  return {
    requestPermission: requestPermissionSpy,
    permissionSpy: requestPermissionSpy,
  } as unknown as TestAcpConnection;
}

function requestPermissionMock(connection: TestAcpConnection) {
  return connection.permissionSpy;
}

function createHost(connection: AgentSideConnection) {
  return createAcpApprovalHost({ connection, sessionId: "acp-session-1" });
}

function execRequest(
  overrides: Partial<AgentRunExecApprovalRequest> = {},
): AgentRunExecApprovalRequest {
  return {
    id: "exec-approval-1",
    command: "echo hi",
    commandArgv: ["echo", "hi"],
    env: { Z_VAR: "secret-z", A_VAR: "secret-a" },
    cwd: "/tmp/project",
    host: "gateway",
    security: "allowlist",
    ask: "on-miss",
    toolCallId: "tool-1",
    ...overrides,
  };
}

function pluginRequest(
  overrides: Partial<PluginApprovalRequestPayload> = {},
): PluginApprovalRequestPayload {
  return {
    pluginId: "test-plugin",
    title: "Approve operation",
    description: "Review the operation",
    detail: "Operation detail",
    severity: "warning",
    toolName: "test_tool",
    toolCallId: "tool-plugin-1",
    allowedDecisions: ["allow-once"],
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createAcpApprovalHost", () => {
  it("returns an inline exec lease with the exact id, expiry, and ACP payload", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const connection = createConnection(async () => ({
      outcome: { outcome: "selected", optionId: "allow-always" },
    }));
    const host = createHost(connection);

    const lease = await host.exec!.request({
      request: execRequest(),
      timeoutMs: 5_000,
    });

    expect(host.exec!.supportsDetachedExecution).toBeUndefined();
    expect(lease.id).toBe("exec-approval-1");
    expect(lease.expiresAtMs).toBe(1_800_000_005_000);
    expect(requestPermissionMock(connection)).not.toHaveBeenCalled();
    await expect(lease.wait()).resolves.toBe("allow-always");
    expect(requestPermissionMock(connection)).toHaveBeenCalledWith({
      sessionId: "acp-session-1",
      toolCall: {
        toolCallId: "tool-1",
        title: "Command approval requested",
        kind: "execute",
        status: "pending",
        rawInput: {
          name: "exec",
          approvalId: "exec-approval-1",
          host: "gateway",
          security: "allowlist",
          ask: "on-miss",
          command: "echo hi",
          commandArgv: ["echo", "hi"],
          cwd: "/tmp/project",
          envKeys: ["A_VAR", "Z_VAR"],
        },
        _meta: {
          toolName: "exec",
          approvalId: "exec-approval-1",
        },
      },
      options: [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "allow-always", name: "Allow always", kind: "allow_always" },
        { optionId: "deny", name: "Deny", kind: "reject_once" },
      ],
    });
  });

  it("removes unavailable exec decisions from ACP options", async () => {
    const connection = createConnection(async () => ({
      outcome: { outcome: "selected", optionId: "allow-once" },
    }));
    const lease = await createHost(connection).exec!.request({
      request: execRequest({ unavailableDecisions: ["allow-always"] }),
      timeoutMs: 5_000,
    });

    await expect(lease.wait()).resolves.toBe("allow-once");
    expect(requestPermissionMock(connection).mock.calls[0]?.[0].options).toEqual([
      { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
      { optionId: "deny", name: "Deny", kind: "reject_once" },
    ]);
  });

  it.each([
    { outcome: { outcome: "cancelled" as const } },
    { outcome: { outcome: "selected" as const, optionId: "not-offered" } },
  ])("fails closed for cancelled or invalid exec outcomes", async (response) => {
    const connection = createConnection(async () => response);
    const lease = await createHost(connection).exec!.request({
      request: execRequest(),
      timeoutMs: 5_000,
    });

    await expect(lease.wait()).resolves.toBe("deny");
  });

  it("fails closed when the exec permission request throws", async () => {
    const connection = createConnection(async () => {
      throw new Error("client disconnected");
    });
    const lease = await createHost(connection).exec!.request({
      request: execRequest(),
      timeoutMs: 5_000,
    });

    await expect(lease.wait()).resolves.toBe("deny");
  });

  it("fails closed on exec timeout and explicit cancellation", async () => {
    vi.useFakeTimers();
    const expiredConnection = createConnection(async () => ({
      outcome: { outcome: "selected", optionId: "allow-once" },
    }));
    const expiredLease = await createHost(expiredConnection).exec!.request({
      request: execRequest({ id: "exec-expired" }),
      timeoutMs: 0,
    });
    await expiredLease.resolveAutoReview();
    await expect(expiredLease.wait()).resolves.toBe("deny");
    expect(requestPermissionMock(expiredConnection)).not.toHaveBeenCalled();

    const timeoutConnection = createConnection(
      () =>
        new Promise(() => {
          // Intentionally unresolved until the approval deadline.
        }),
    );
    const timeoutLease = await createHost(timeoutConnection).exec!.request({
      request: execRequest(),
      timeoutMs: 100,
    });
    const timeoutDecision = timeoutLease.wait();
    await vi.advanceTimersByTimeAsync(100);
    await expect(timeoutDecision).resolves.toBe("deny");

    const cancelledConnection = createConnection(
      () =>
        new Promise(() => {
          // Intentionally unresolved; cancellation settles the local lease.
        }),
    );
    const cancelledLease = await createHost(cancelledConnection).exec!.request({
      request: execRequest({ id: "exec-cancelled" }),
      timeoutMs: 5_000,
    });
    await cancelledLease.cancel();
    await expect(cancelledLease.wait()).resolves.toBe("deny");
    expect(requestPermissionMock(cancelledConnection)).not.toHaveBeenCalled();
  });

  it("propagates exec run aborts and ignores late client approval", async () => {
    let resolvePermission!: (response: RequestPermissionResponse) => void;
    const connection = createConnection(
      () =>
        new Promise((resolve) => {
          resolvePermission = resolve;
        }),
    );
    const controller = new AbortController();
    const abortReason = new Error("run aborted");
    const lease = await createHost(connection).exec!.request({
      request: execRequest(),
      timeoutMs: 5_000,
      signal: controller.signal,
    });
    const decision = lease.wait();
    await vi.waitFor(() => {
      expect(requestPermissionMock(connection)).toHaveBeenCalledOnce();
    });

    controller.abort(abortReason);
    await expect(decision).rejects.toBe(abortReason);
    resolvePermission({ outcome: { outcome: "selected", optionId: "allow-once" } });
  });

  it("resolves exec auto-review locally without opening ACP permission UI", async () => {
    const connection = createConnection(
      () =>
        new Promise(() => {
          // Auto-review resolves without opening the ACP permission request.
        }),
    );
    const lease = await createHost(connection).exec!.request({
      request: execRequest(),
      timeoutMs: 5_000,
    });

    await lease.resolveAutoReview();
    await expect(lease.wait()).resolves.toBe("allow-once");
    expect(requestPermissionMock(connection)).not.toHaveBeenCalled();
  });

  it("maps plugin approvals, registers their exact id, and adds fail-closed deny", async () => {
    const connection = createConnection(async () => ({
      outcome: { outcome: "selected", optionId: "allow-once" },
    }));
    const onRegistered = vi.fn();

    await expect(
      createHost(connection).plugin!.request({
        request: pluginRequest(),
        timeoutMs: 5_000,
        onRegistered,
      }),
    ).resolves.toEqual({ outcome: "resolved", decision: "allow-once" });

    const approvalId = onRegistered.mock.calls[0]?.[0].id;
    expect(approvalId).toMatch(/^plugin:/);
    expect(requestPermissionMock(connection)).toHaveBeenCalledWith({
      sessionId: "acp-session-1",
      toolCall: {
        toolCallId: "tool-plugin-1",
        title: "Approve operation",
        kind: "other",
        status: "pending",
        rawInput: {
          name: "test_tool",
          approvalId,
          title: "Approve operation",
          description: "Review the operation",
          pluginId: "test-plugin",
          detail: "Operation detail",
          severity: "warning",
        },
        _meta: {
          toolName: "test_tool",
          approvalId,
          pluginId: "test-plugin",
        },
      },
      options: [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "deny", name: "Deny", kind: "reject_once" },
      ],
    });
  });

  it.each([
    { outcome: { outcome: "cancelled" as const } },
    { outcome: { outcome: "selected" as const, optionId: "allow-always" } },
  ])("fails closed for cancelled or unoffered plugin outcomes", async (response) => {
    const connection = createConnection(async () => response);

    await expect(
      createHost(connection).plugin!.request({
        request: pluginRequest(),
        timeoutMs: 5_000,
      }),
    ).resolves.toEqual({ outcome: "resolved", decision: "deny" });
  });

  it("reports plugin timeout and transport failure without approving", async () => {
    vi.useFakeTimers();
    const timeoutConnection = createConnection(
      () =>
        new Promise(() => {
          // Intentionally unresolved until the plugin approval deadline.
        }),
    );
    const timedOut = createHost(timeoutConnection).plugin!.request({
      request: pluginRequest(),
      timeoutMs: 100,
    });
    await vi.advanceTimersByTimeAsync(100);
    await expect(timedOut).resolves.toEqual({ outcome: "timed-out" });

    const failedConnection = createConnection(async () => {
      throw new Error("client disconnected");
    });
    await expect(
      createHost(failedConnection).plugin!.request({
        request: pluginRequest(),
        timeoutMs: 5_000,
      }),
    ).resolves.toEqual({
      outcome: "unavailable",
      reason: "ACP permission request failed.",
    });
  });

  it("rejects a plugin approval response received after its wall-clock deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    let resolvePermission!: (response: RequestPermissionResponse) => void;
    const connection = createConnection(
      () =>
        new Promise((resolve) => {
          resolvePermission = resolve;
        }),
    );
    const approval = createHost(connection).plugin!.request({
      request: pluginRequest(),
      timeoutMs: 100,
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(requestPermissionMock(connection)).toHaveBeenCalledOnce();

    vi.setSystemTime(1_800_000_000_100);
    resolvePermission({ outcome: { outcome: "selected", optionId: "allow-once" } });

    await expect(approval).resolves.toEqual({ outcome: "timed-out" });
  });

  it("propagates plugin aborts and does not call the client when registration fails", async () => {
    const abortConnection = createConnection(
      () =>
        new Promise(() => {
          // Intentionally unresolved until the run aborts.
        }),
    );
    const controller = new AbortController();
    const abortReason = new Error("run aborted");
    const approval = createHost(abortConnection).plugin!.request({
      request: pluginRequest(),
      timeoutMs: 5_000,
      signal: controller.signal,
    });
    await vi.waitFor(() => {
      expect(requestPermissionMock(abortConnection)).toHaveBeenCalledOnce();
    });
    controller.abort(abortReason);
    await expect(approval).rejects.toBe(abortReason);

    const registrationConnection = createConnection(async () => ({
      outcome: { outcome: "selected", optionId: "allow-once" },
    }));
    await expect(
      createHost(registrationConnection).plugin!.request({
        request: pluginRequest(),
        timeoutMs: 5_000,
        onRegistered: () => {
          throw new Error("registration failed");
        },
      }),
    ).rejects.toThrow("registration failed");
    expect(requestPermissionMock(registrationConnection)).not.toHaveBeenCalled();
  });
});

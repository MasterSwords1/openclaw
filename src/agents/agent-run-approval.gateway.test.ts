import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../packages/gateway-protocol/src/schema/error-codes.js";
import { GatewayClientRequestError } from "../gateway/client.js";
import {
  createGatewayAgentRunApprovalHost,
  gatewayAgentRunApprovalHost,
  resolveGatewayAgentRunApprovalHost,
} from "./agent-run-approval.gateway.js";
import {
  AgentRunExecApprovalRunAbortedError,
  noAgentRunApprovalHost,
} from "./agent-run-approval.js";
import { DEFAULT_APPROVAL_TIMEOUT_MS } from "./bash-tools.exec-runtime.js";
import { callGatewayTool } from "./tools/gateway.js";

vi.mock("./tools/gateway.js", () => ({
  callGatewayTool: vi.fn(),
}));

const mockCallGatewayTool = vi.mocked(callGatewayTool);
const requestApproval = gatewayAgentRunApprovalHost.plugin!.request;

function mockAbortableGatewayCall() {
  const abortRequest = vi.fn(async () => ({}));
  mockCallGatewayTool.mockImplementationOnce(
    (_method, _options, _params, extra) =>
      new Promise((_resolve, reject) => {
        const abortOptions = extra as
          | {
              signal?: AbortSignal;
              onSignalAbort?: (request: typeof abortRequest) => unknown;
            }
          | undefined;
        const signal = abortOptions?.signal;
        const onAbort = () => {
          void Promise.resolve(abortOptions?.onSignalAbort?.(abortRequest))
            .catch(() => undefined)
            .finally(() => {
              reject(
                signal?.reason instanceof Error
                  ? signal.reason
                  : new Error("approval request aborted"),
              );
            });
        };
        if (signal?.aborted) {
          onAbort();
          return;
        }
        signal?.addEventListener("abort", onAbort, { once: true });
      }),
  );
  return abortRequest;
}

function requestPayload() {
  return {
    pluginId: "test-plugin",
    title: "Approve operation",
    description: "Review the operation",
    toolName: "exec",
    toolCallId: "call-1",
  };
}

function execRequestPayload() {
  return {
    id: "exec-approval-1",
    command: "echo hi",
    cwd: "/tmp",
    host: "gateway" as const,
    security: "allowlist" as const,
    ask: "on-miss" as const,
    runId: "run-1",
    toolCallId: "tool-1",
  };
}

describe("gatewayAgentRunApprovalHost", () => {
  beforeEach(() => {
    mockCallGatewayTool.mockReset();
  });

  it("returns an immediate decision without waiting", async () => {
    const onRegistered = vi.fn();
    const requestApprovalWithReviewer = createGatewayAgentRunApprovalHost({
      approvalReviewerDeviceIds: ["device-1"],
      runtimeInstanceId: "approval-runtime-1",
    }).plugin!.request;
    mockCallGatewayTool.mockResolvedValueOnce({
      id: "approval-1",
      decision: "allow-once",
    });

    await expect(
      requestApprovalWithReviewer({
        request: requestPayload(),
        timeoutMs: 5_000,
        onRegistered,
      }),
    ).resolves.toEqual({ outcome: "resolved", decision: "allow-once" });
    expect(onRegistered).toHaveBeenCalledWith({ id: "approval-1" });
    expect(mockCallGatewayTool).toHaveBeenCalledOnce();
    expect(mockCallGatewayTool).toHaveBeenCalledWith(
      "plugin.approval.request",
      { timeoutMs: 15_000 },
      {
        ...requestPayload(),
        approvalReviewerDeviceIds: ["device-1"],
        runtimeRequestId: expect.any(String),
        timeoutMs: 5_000,
        twoPhase: true,
      },
      {
        expectFinal: false,
        signal: undefined,
        instanceId: "approval-runtime-1",
        onSignalAbort: expect.any(Function),
      },
    );
  });

  it("adapts exec registration and reviewer selection onto the Gateway wire", async () => {
    const host = createGatewayAgentRunApprovalHost({
      approvalReviewerDeviceIds: ["device-1"],
      runtimeInstanceId: "approval-runtime-1",
    });
    mockCallGatewayTool.mockResolvedValueOnce({
      id: "exec-approval-1",
      expiresAtMs: 1_800_000_120_000,
      decision: "allow-once",
    });

    await expect(
      host.exec!.request({
        request: execRequestPayload(),
        timeoutMs: DEFAULT_APPROVAL_TIMEOUT_MS,
      }),
    ).resolves.toMatchObject({
      id: "exec-approval-1",
      expiresAtMs: 1_800_000_120_000,
      finalDecision: "allow-once",
      wait: expect.any(Function),
      resolveAutoReview: expect.any(Function),
      cancel: expect.any(Function),
    });
    expect(mockCallGatewayTool).toHaveBeenCalledWith(
      "exec.approval.request",
      { timeoutMs: DEFAULT_APPROVAL_TIMEOUT_MS + 10_000 },
      {
        ...execRequestPayload(),
        approvalReviewerDeviceIds: ["device-1"],
        timeoutMs: DEFAULT_APPROVAL_TIMEOUT_MS,
        twoPhase: true,
      },
      {
        expectFinal: false,
        signal: undefined,
        instanceId: "approval-runtime-1",
        onSignalAbort: expect.any(Function),
      },
    );
  });

  it("keeps exec lease cancellation and auto-review bound to the runtime instance", async () => {
    const host = createGatewayAgentRunApprovalHost({
      runtimeInstanceId: "approval-runtime-1",
    });
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "exec-approval-1" })
      .mockResolvedValueOnce({ decision: "deny" })
      .mockResolvedValue({ ok: true });

    const lease = await host.exec!.request({
      request: execRequestPayload(),
      timeoutMs: DEFAULT_APPROVAL_TIMEOUT_MS,
    });
    const registrationAbortRequest = vi.fn().mockResolvedValue({ ok: true });
    await mockCallGatewayTool.mock.calls[0]?.[3]?.onSignalAbort?.(registrationAbortRequest);
    expect(registrationAbortRequest).toHaveBeenCalledWith("exec.approval.cancel", {
      id: "exec-approval-1",
    });

    await expect(lease.wait()).resolves.toBe("deny");
    const waitAbortRequest = vi.fn().mockResolvedValue({ ok: true });
    await mockCallGatewayTool.mock.calls[1]?.[3]?.onSignalAbort?.(waitAbortRequest);
    expect(waitAbortRequest).toHaveBeenCalledWith("exec.approval.cancel", {
      id: "exec-approval-1",
    });

    await lease.resolveAutoReview();
    await lease.cancel();
    expect(mockCallGatewayTool).toHaveBeenNthCalledWith(
      3,
      "exec.approval.resolve",
      { timeoutMs: 15_000 },
      { id: "exec-approval-1", decision: "allow-once" },
      {
        scopes: ["operator.approvals"],
        requireAgentRuntimeIdentity: true,
        instanceId: "approval-runtime-1",
      },
    );
    expect(mockCallGatewayTool).toHaveBeenNthCalledWith(
      4,
      "exec.approval.cancel",
      { timeoutMs: 10_000 },
      { id: "exec-approval-1" },
      { instanceId: "approval-runtime-1" },
    );
  });

  it("cancels an exec approval when the run aborts after registration", async () => {
    const controller = new AbortController();
    const abortReason = new Error("run aborted");
    const host = createGatewayAgentRunApprovalHost({
      runtimeInstanceId: "approval-runtime-1",
    });
    mockCallGatewayTool
      .mockImplementationOnce(async () => {
        controller.abort(abortReason);
        return { id: "exec-approval-1", decision: "allow-once" };
      })
      .mockResolvedValueOnce({ ok: true, cancelled: 1 });

    await expect(
      host.exec!.request({
        request: execRequestPayload(),
        timeoutMs: DEFAULT_APPROVAL_TIMEOUT_MS,
        signal: controller.signal,
      }),
    ).rejects.toBe(abortReason);
    expect(mockCallGatewayTool).toHaveBeenNthCalledWith(
      2,
      "exec.approval.cancel",
      { timeoutMs: 10_000 },
      { id: "exec-approval-1" },
      { instanceId: "approval-runtime-1" },
    );
  });

  it("cancels a registered exec approval before an already-aborted wait", async () => {
    const controller = new AbortController();
    const abortReason = new Error("run aborted");
    const host = createGatewayAgentRunApprovalHost({
      runtimeInstanceId: "approval-runtime-1",
    });
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "exec-approval-1" })
      .mockResolvedValueOnce({ ok: true, cancelled: 1 });
    const lease = await host.exec!.request({
      request: execRequestPayload(),
      timeoutMs: DEFAULT_APPROVAL_TIMEOUT_MS,
    });
    controller.abort(abortReason);

    await expect(lease.wait({ signal: controller.signal })).rejects.toBe(abortReason);
    expect(mockCallGatewayTool).toHaveBeenNthCalledWith(
      2,
      "exec.approval.cancel",
      { timeoutMs: 10_000 },
      { id: "exec-approval-1" },
      { instanceId: "approval-runtime-1" },
    );
  });

  it("bounds missing and invalid exec registration expiries", async () => {
    const host = createGatewayAgentRunApprovalHost();
    const nowMs = 1_800_000_000_000;
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(nowMs);
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "exec-approval-1" })
      .mockResolvedValueOnce({ id: "exec-approval-1", expiresAtMs: Number.MAX_VALUE });

    try {
      await expect(
        host.exec!.request({
          request: execRequestPayload(),
          timeoutMs: DEFAULT_APPROVAL_TIMEOUT_MS,
        }),
      ).resolves.toMatchObject({ expiresAtMs: nowMs + DEFAULT_APPROVAL_TIMEOUT_MS });
      await expect(
        host.exec!.request({
          request: execRequestPayload(),
          timeoutMs: DEFAULT_APPROVAL_TIMEOUT_MS,
        }),
      ).resolves.toMatchObject({ expiresAtMs: nowMs + DEFAULT_APPROVAL_TIMEOUT_MS });
    } finally {
      dateNow.mockRestore();
    }
  });

  it("maps Gateway exec wait outcomes without hiding run cancellation", async () => {
    const host = createGatewayAgentRunApprovalHost({
      runtimeInstanceId: "approval-runtime-1",
    });
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "exec-approval-1" })
      .mockResolvedValueOnce({ id: "exec-aborted" })
      .mockResolvedValueOnce({ decision: null, terminalReason: "timeout" })
      .mockResolvedValueOnce({ decision: null, terminalReason: "run-aborted" });
    const timeoutLease = await host.exec!.request({
      request: execRequestPayload(),
      timeoutMs: DEFAULT_APPROVAL_TIMEOUT_MS,
    });
    const abortedLease = await host.exec!.request({
      request: { ...execRequestPayload(), id: "exec-aborted" },
      timeoutMs: DEFAULT_APPROVAL_TIMEOUT_MS,
    });

    await expect(timeoutLease.wait()).resolves.toBeNull();
    await expect(abortedLease.wait()).rejects.toBeInstanceOf(AgentRunExecApprovalRunAbortedError);
  });

  it("does not accept an immediate decision after registration aborts the run", async () => {
    const controller = new AbortController();
    const abortReason = new Error("run aborted");
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "approval-1", decision: "allow-once" })
      .mockResolvedValueOnce({ ok: true, cancelled: 1 });

    const result = requestApproval({
      request: requestPayload(),
      timeoutMs: 5_000,
      signal: controller.signal,
      onRegistered: () => {
        controller.abort(abortReason);
      },
    });

    await expect(result).rejects.toBe(abortReason);
    expect(mockCallGatewayTool).toHaveBeenNthCalledWith(
      2,
      "plugin.approval.cancel",
      { timeoutMs: 10_000 },
      { id: "approval-1" },
      { instanceId: expect.any(String) },
    );
  });

  it("waits for a decision bound to the registered request", async () => {
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "approval-1" })
      .mockResolvedValueOnce({ id: "approval-1", decision: "deny" });

    await expect(requestApproval({ request: requestPayload(), timeoutMs: 5_000 })).resolves.toEqual(
      { outcome: "resolved", decision: "deny" },
    );
    expect(mockCallGatewayTool).toHaveBeenNthCalledWith(
      2,
      "plugin.approval.waitDecision",
      { timeoutMs: 15_000 },
      { id: "approval-1" },
      {
        signal: undefined,
        instanceId: expect.any(String),
        onSignalAbort: expect.any(Function),
      },
    );
    expect(mockCallGatewayTool.mock.calls[0]?.[3]?.instanceId).toBe(
      mockCallGatewayTool.mock.calls[1]?.[3]?.instanceId,
    );
  });

  it("does not accept a waited decision after the run aborts", async () => {
    const controller = new AbortController();
    const abortReason = new Error("run aborted");
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "approval-1" })
      .mockImplementationOnce(async () => {
        controller.abort(abortReason);
        return { id: "approval-1", decision: "allow-once" };
      })
      .mockResolvedValueOnce({ ok: true, cancelled: 1 });

    await expect(
      requestApproval({
        request: requestPayload(),
        timeoutMs: 5_000,
        signal: controller.signal,
      }),
    ).rejects.toBe(abortReason);
    expect(mockCallGatewayTool).toHaveBeenNthCalledWith(
      3,
      "plugin.approval.cancel",
      { timeoutMs: 10_000 },
      { id: "approval-1" },
      { instanceId: expect.any(String) },
    );
  });

  it("fails closed on a stale decision id", async () => {
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "approval-1", deliveryRoute: "turn-source" })
      .mockResolvedValueOnce({ id: "approval-2", decision: "allow-once" })
      .mockResolvedValueOnce({ ok: true, cancelled: 1 });

    await expect(requestApproval({ request: requestPayload(), timeoutMs: 5_000 })).resolves.toEqual(
      {
        outcome: "unavailable",
        reason: "Plugin approval response did not match the registered request.",
      },
    );
    expect(mockCallGatewayTool).toHaveBeenNthCalledWith(
      3,
      "plugin.approval.cancel",
      { timeoutMs: 10_000 },
      { id: "approval-1" },
      { instanceId: expect.any(String) },
    );
  });

  it("classifies an expired registered approval as timed out", async () => {
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "approval-1", deliveryRoute: "turn-source" })
      .mockRejectedValueOnce(
        new GatewayClientRequestError({
          code: ErrorCodes.INVALID_REQUEST,
          message: "approval expired or not found",
        }),
      );

    await expect(requestApproval({ request: requestPayload(), timeoutMs: 5_000 })).resolves.toEqual(
      { outcome: "timed-out", deliveryRoute: "turn-source" },
    );
  });

  it("reports an unavailable approval route", async () => {
    mockCallGatewayTool.mockResolvedValueOnce({
      id: "approval-1",
      decision: null,
    });

    await expect(requestApproval({ request: requestPayload(), timeoutMs: 5_000 })).resolves.toEqual(
      {
        outcome: "unavailable",
        reason: "Plugin approval unavailable (no approval route)",
      },
    );
  });

  it("classifies an invalid immediate decision as unavailable", async () => {
    mockCallGatewayTool
      .mockResolvedValueOnce({
        id: "approval-1",
        decision: "unexpected",
      })
      .mockResolvedValueOnce({ ok: true, cancelled: 1 });

    await expect(requestApproval({ request: requestPayload(), timeoutMs: 5_000 })).resolves.toEqual(
      {
        outcome: "unavailable",
        reason: "Plugin approval returned an invalid decision.",
      },
    );
    expect(mockCallGatewayTool).toHaveBeenNthCalledWith(
      2,
      "plugin.approval.cancel",
      { timeoutMs: 10_000 },
      { id: "approval-1" },
      { instanceId: expect.any(String) },
    );
  });

  it("cancels a registered approval with an invalid waited decision", async () => {
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "approval-1" })
      .mockResolvedValueOnce({ id: "approval-1", decision: "unexpected" })
      .mockResolvedValueOnce({ ok: true, cancelled: 1 });

    await expect(requestApproval({ request: requestPayload(), timeoutMs: 5_000 })).resolves.toEqual(
      {
        outcome: "unavailable",
        reason: "Plugin approval returned an invalid decision.",
      },
    );
    expect(mockCallGatewayTool).toHaveBeenNthCalledWith(
      3,
      "plugin.approval.cancel",
      { timeoutMs: 10_000 },
      { id: "approval-1" },
      { instanceId: expect.any(String) },
    );
  });

  it("does not tombstone a definitive request rejection", async () => {
    const requestFailure = new GatewayClientRequestError({
      code: ErrorCodes.INVALID_REQUEST,
      message: "request failed",
    });
    mockCallGatewayTool.mockRejectedValueOnce(requestFailure);

    await expect(requestApproval({ request: requestPayload(), timeoutMs: 5_000 })).resolves.toEqual(
      {
        outcome: "unavailable",
        reason: expect.stringContaining("Plugin approval request rejected:"),
      },
    );
    expect(mockCallGatewayTool).toHaveBeenCalledOnce();
  });

  it("cancels an ambiguous request failure by runtime request id", async () => {
    mockCallGatewayTool.mockRejectedValueOnce(new Error("request transport failed"));

    await expect(requestApproval({ request: requestPayload(), timeoutMs: 5_000 })).resolves.toEqual(
      {
        outcome: "unavailable",
        reason: "Plugin approval required (approval host unavailable)",
      },
    );
    const requestParams = mockCallGatewayTool.mock.calls[0]?.[2] as
      | { runtimeRequestId?: unknown }
      | undefined;
    expect(mockCallGatewayTool).toHaveBeenNthCalledWith(
      2,
      "plugin.approval.cancel",
      { timeoutMs: 10_000 },
      { runtimeRequestId: requestParams?.runtimeRequestId },
      { instanceId: expect.any(String) },
    );
  });

  it("cancels a registered approval after a wait transport failure", async () => {
    const waitFailure = new Error("wait failed");
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "approval-1" })
      .mockRejectedValueOnce(waitFailure);

    await expect(requestApproval({ request: requestPayload(), timeoutMs: 5_000 })).resolves.toEqual(
      {
        outcome: "unavailable",
        reason: "Plugin approval required (approval host unavailable)",
      },
    );
    expect(mockCallGatewayTool).toHaveBeenNthCalledWith(
      3,
      "plugin.approval.cancel",
      { timeoutMs: 10_000 },
      { id: "approval-1" },
      { instanceId: expect.any(String) },
    );
  });

  it("rethrows the run abort reason from the decision wait", async () => {
    const controller = new AbortController();
    const abortReason = new Error("run aborted");
    mockCallGatewayTool.mockResolvedValueOnce({ id: "approval-1" });
    const abortRequest = mockAbortableGatewayCall();

    const result = requestApproval({
      request: requestPayload(),
      timeoutMs: 5_000,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(mockCallGatewayTool).toHaveBeenCalledTimes(2));
    controller.abort(abortReason);

    await expect(result).rejects.toBe(abortReason);
    expect(abortRequest).toHaveBeenCalledWith("plugin.approval.cancel", { id: "approval-1" });
  });

  it("cancels when the run aborts between registration and the decision wait", async () => {
    const controller = new AbortController();
    const abortReason = new Error("run aborted");
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "approval-1" })
      .mockResolvedValueOnce({ ok: true, cancelled: 1 });

    const result = requestApproval({
      request: requestPayload(),
      timeoutMs: 5_000,
      signal: controller.signal,
      onRegistered: () => {
        controller.abort(abortReason);
      },
    });

    await expect(result).rejects.toBe(abortReason);
    expect(mockCallGatewayTool).toHaveBeenNthCalledWith(
      2,
      "plugin.approval.cancel",
      { timeoutMs: 10_000 },
      { id: "approval-1" },
      { instanceId: expect.any(String) },
    );
  });

  it("rethrows the run abort reason while registering", async () => {
    const controller = new AbortController();
    const abortReason = new Error("run aborted");
    const abortRequest = mockAbortableGatewayCall();

    const result = requestApproval({
      request: requestPayload(),
      timeoutMs: 5_000,
      signal: controller.signal,
    });
    controller.abort(abortReason);

    await expect(result).rejects.toBe(abortReason);
    expect(mockCallGatewayTool).toHaveBeenCalledWith(
      "plugin.approval.request",
      { timeoutMs: 15_000 },
      {
        ...requestPayload(),
        runtimeRequestId: expect.any(String),
        timeoutMs: 5_000,
        twoPhase: true,
      },
      {
        expectFinal: false,
        signal: controller.signal,
        instanceId: expect.any(String),
        onSignalAbort: expect.any(Function),
      },
    );
    const requestParams = mockCallGatewayTool.mock.calls[0]?.[2] as
      | { runtimeRequestId?: unknown }
      | undefined;
    const runtimeRequestId = requestParams?.runtimeRequestId;
    expect(runtimeRequestId).toEqual(expect.any(String));
    expect(abortRequest).toHaveBeenCalledWith("plugin.approval.cancel", { runtimeRequestId });
  });

  it("does not register an approval for a pre-aborted run", async () => {
    const controller = new AbortController();
    const abortReason = new Error("run aborted");
    controller.abort(abortReason);

    await expect(
      requestApproval({
        request: requestPayload(),
        timeoutMs: 5_000,
        signal: controller.signal,
      }),
    ).rejects.toBe(abortReason);
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
  });

  it("cancels the registered approval when registration notification fails", async () => {
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "approval-1" })
      .mockResolvedValueOnce({ cancelled: true });

    await expect(
      requestApproval({
        request: requestPayload(),
        timeoutMs: 5_000,
        onRegistered: () => {
          throw new Error("registration failed");
        },
      }),
    ).rejects.toThrow("registration failed");
    expect(mockCallGatewayTool).toHaveBeenNthCalledWith(
      2,
      "plugin.approval.cancel",
      { timeoutMs: 10_000 },
      { id: "approval-1" },
      { instanceId: expect.any(String) },
    );
  });
});

describe("resolveGatewayAgentRunApprovalHost", () => {
  it("preserves explicit no-host state ahead of inherited and Gateway defaults", () => {
    const inheritedApprovalHost = createGatewayAgentRunApprovalHost();

    expect(
      resolveGatewayAgentRunApprovalHost({
        approvalHostMode: "none",
        inheritedApprovalHost,
        approvalReviewerDeviceId: "device-reviewer",
      }),
    ).toBe(noAgentRunApprovalHost);
    expect(
      resolveGatewayAgentRunApprovalHost({
        inheritedApprovalHost,
        approvalReviewerDeviceId: "device-reviewer",
      }),
    ).toBe(inheritedApprovalHost);
    expect(resolveGatewayAgentRunApprovalHost({})).toBe(gatewayAgentRunApprovalHost);
  });

  it("binds a Gateway-owned run to its initiating reviewer device", async () => {
    mockCallGatewayTool.mockReset().mockResolvedValueOnce({
      id: "approval-device-bound",
      decision: "deny",
    });
    const host = resolveGatewayAgentRunApprovalHost({
      approvalReviewerDeviceId: " device-reviewer ",
    });

    await expect(
      host.plugin!.request({
        request: requestPayload(),
        timeoutMs: 5_000,
      }),
    ).resolves.toEqual({ outcome: "resolved", decision: "deny" });
    expect(mockCallGatewayTool).toHaveBeenCalledWith(
      "plugin.approval.request",
      { timeoutMs: 15_000 },
      expect.objectContaining({
        approvalReviewerDeviceIds: ["device-reviewer"],
      }),
      expect.objectContaining({
        expectFinal: false,
        instanceId: expect.any(String),
      }),
    );
  });
});

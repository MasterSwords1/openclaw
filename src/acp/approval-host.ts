import { randomUUID } from "node:crypto";
import type {
  AgentSideConnection,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import type {
  AgentRunApprovalHost,
  AgentRunExecApprovalHost,
  AgentRunExecApprovalLease,
  AgentRunExecApprovalRequest,
  AgentRunPluginApprovalHost,
  AgentRunPluginApprovalResult,
} from "../agents/agent-run-approval.js";
import { resolveExecApprovalRequestAllowedDecisions } from "../infra/exec-approvals.js";
import { resolveCanonicalPluginApprovalRequestAllowedDecisions } from "../infra/plugin-approval-canonical-decisions.js";
import type { PluginApprovalRequestPayload } from "../infra/plugin-approvals.js";
import {
  buildAcpPermissionOptions,
  resolveAcpApprovalDecision,
  type AcpApprovalDecision,
} from "./permission-relay.js";

type PermissionRequestResult =
  | { kind: "response"; response: RequestPermissionResponse }
  | { kind: "timeout" }
  | { kind: "aborted"; reason: unknown }
  | { kind: "error" };

type ExecApprovalSettlement =
  | { kind: "decision"; decision: AcpApprovalDecision }
  | { kind: "aborted"; reason: unknown };

function resolveTimeoutMs(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function resolveAbortReason(signal: AbortSignal, fallback: string): unknown {
  return signal.reason ?? new Error(fallback);
}

function buildExecPermissionRequest(params: {
  sessionId: string;
  request: AgentRunExecApprovalRequest;
}): RequestPermissionRequest {
  const request = params.request;
  const command =
    request.command ??
    request.systemRunPlan?.commandPreview ??
    request.systemRunPlan?.commandText ??
    request.commandArgv?.join(" ");
  const rawInput: Record<string, unknown> = {
    name: "exec",
    approvalId: request.id,
    host: request.host,
    security: request.security,
    ask: request.ask,
  };
  if (command) {
    rawInput.command = command;
  }
  if (request.commandArgv?.length) {
    rawInput.commandArgv = request.commandArgv;
  }
  if (request.cwd) {
    rawInput.cwd = request.cwd;
  }
  if (request.nodeId) {
    rawInput.nodeId = request.nodeId;
  }
  if (request.warningText) {
    rawInput.warningText = request.warningText;
  }
  const envKeys = request.env ? Object.keys(request.env).toSorted() : [];
  if (envKeys.length > 0) {
    rawInput.envKeys = envKeys;
  }
  const options = buildAcpPermissionOptions(resolveExecApprovalRequestAllowedDecisions(request));
  return {
    sessionId: params.sessionId,
    toolCall: {
      toolCallId: request.toolCallId ?? `exec:${request.id}`,
      title: "Command approval requested",
      kind: "execute",
      status: "pending",
      rawInput,
      _meta: {
        toolName: "exec",
        approvalId: request.id,
      },
    },
    options,
  };
}

function buildPluginPermissionRequest(params: {
  sessionId: string;
  approvalId: string;
  request: PluginApprovalRequestPayload;
}): RequestPermissionRequest {
  const request = params.request;
  const rawInput: Record<string, unknown> = {
    name: request.toolName ?? request.pluginId ?? "plugin",
    approvalId: params.approvalId,
    title: request.title,
    description: request.description,
  };
  if (request.pluginId) {
    rawInput.pluginId = request.pluginId;
  }
  if (request.detail) {
    rawInput.detail = request.detail;
  }
  if (request.severity) {
    rawInput.severity = request.severity;
  }
  const options = buildAcpPermissionOptions(
    resolveCanonicalPluginApprovalRequestAllowedDecisions(request),
  );
  return {
    sessionId: params.sessionId,
    toolCall: {
      toolCallId: request.toolCallId ?? params.approvalId,
      title: request.title,
      kind: "other",
      status: "pending",
      rawInput,
      _meta: {
        toolName: request.toolName ?? request.pluginId ?? "plugin",
        approvalId: params.approvalId,
        ...(request.pluginId ? { pluginId: request.pluginId } : {}),
      },
    },
    options,
  };
}

async function requestPermissionWithDeadline(params: {
  connection: AgentSideConnection;
  request: RequestPermissionRequest;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<PermissionRequestResult> {
  if (params.signal?.aborted) {
    return {
      kind: "aborted",
      reason: resolveAbortReason(params.signal, "ACP permission request aborted"),
    };
  }
  if (params.timeoutMs <= 0) {
    return { kind: "timeout" };
  }
  const expiresAtMs = Date.now() + params.timeoutMs;

  return new Promise<PermissionRequestResult>((resolve) => {
    let settled = false;
    const finish = (result: PermissionRequestResult) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      params.signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onAbort = () => {
      if (!params.signal) {
        return;
      }
      finish({
        kind: "aborted",
        reason: resolveAbortReason(params.signal, "ACP permission request aborted"),
      });
    };
    const timer = setTimeout(() => finish({ kind: "timeout" }), params.timeoutMs);
    timer.unref?.();
    params.signal?.addEventListener("abort", onAbort, { once: true });
    void Promise.resolve()
      .then(() => params.connection.requestPermission(params.request))
      .then(
        (response) =>
          finish(Date.now() >= expiresAtMs ? { kind: "timeout" } : { kind: "response", response }),
        () => finish(Date.now() >= expiresAtMs ? { kind: "timeout" } : { kind: "error" }),
      );
  });
}

function createExecApprovalLease(params: {
  connection: AgentSideConnection;
  sessionId: string;
  request: AgentRunExecApprovalRequest;
  timeoutMs: number;
  signal?: AbortSignal;
}): AgentRunExecApprovalLease {
  const timeoutMs = resolveTimeoutMs(params.timeoutMs);
  const expiresAtMs = Date.now() + timeoutMs;
  let settled = false;
  let permissionRequestStarted = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let resolveSettlement!: (settlement: ExecApprovalSettlement) => void;
  const settlement = new Promise<ExecApprovalSettlement>((resolve) => {
    resolveSettlement = resolve;
  });
  const finish = (result: ExecApprovalSettlement) => {
    if (settled) {
      return;
    }
    settled = true;
    if (timeout) {
      clearTimeout(timeout);
    }
    params.signal?.removeEventListener("abort", onRequestAbort);
    resolveSettlement(result);
  };
  const finishDecision = (decision: AcpApprovalDecision) => {
    finish({
      kind: "decision",
      decision: decision !== "deny" && Date.now() >= expiresAtMs ? "deny" : decision,
    });
  };
  const onRequestAbort = () => {
    if (!params.signal) {
      return;
    }
    finish({
      kind: "aborted",
      reason: resolveAbortReason(params.signal, "ACP exec approval request aborted"),
    });
  };
  if (timeoutMs <= 0) {
    finishDecision("deny");
  } else {
    timeout = setTimeout(() => finishDecision("deny"), timeoutMs);
    timeout.unref?.();
  }
  params.signal?.addEventListener("abort", onRequestAbort, { once: true });
  if (params.signal?.aborted) {
    onRequestAbort();
  }

  const startPermissionRequest = () => {
    if (settled || permissionRequestStarted) {
      return;
    }
    permissionRequestStarted = true;
    const request = buildExecPermissionRequest({
      sessionId: params.sessionId,
      request: params.request,
    });
    void Promise.resolve()
      .then(() => params.connection.requestPermission(request))
      .then(
        (response) =>
          finishDecision(resolveAcpApprovalDecision(response, request.options) ?? "deny"),
        () => finishDecision("deny"),
      );
  };

  return Object.freeze({
    id: params.request.id,
    expiresAtMs,
    wait: async (waitParams) => {
      const waitSignal = waitParams?.signal;
      const onWaitAbort = () => {
        if (!waitSignal) {
          return;
        }
        finish({
          kind: "aborted",
          reason: resolveAbortReason(waitSignal, "ACP exec approval wait aborted"),
        });
      };
      waitSignal?.addEventListener("abort", onWaitAbort, { once: true });
      if (waitSignal?.aborted) {
        onWaitAbort();
      }
      startPermissionRequest();
      try {
        const result = await settlement;
        if (result.kind === "aborted") {
          throw result.reason;
        }
        return result.decision;
      } finally {
        waitSignal?.removeEventListener("abort", onWaitAbort);
      }
    },
    resolveAutoReview: async () => {
      finishDecision("allow-once");
    },
    cancel: async () => {
      finishDecision("deny");
    },
  });
}

async function requestPluginApproval(params: {
  connection: AgentSideConnection;
  sessionId: string;
  request: PluginApprovalRequestPayload;
  timeoutMs: number;
  signal?: AbortSignal;
  onRegistered?: (registration: { id: string }) => void;
}): Promise<AgentRunPluginApprovalResult> {
  params.signal?.throwIfAborted();
  const approvalId = `plugin:${randomUUID()}`;
  params.onRegistered?.({ id: approvalId });
  params.signal?.throwIfAborted();
  const request = buildPluginPermissionRequest({
    sessionId: params.sessionId,
    approvalId,
    request: params.request,
  });
  const result = await requestPermissionWithDeadline({
    connection: params.connection,
    request,
    timeoutMs: resolveTimeoutMs(params.timeoutMs),
    signal: params.signal,
  });
  if (result.kind === "aborted") {
    throw result.reason;
  }
  if (result.kind === "timeout") {
    return { outcome: "timed-out" };
  }
  if (result.kind === "error") {
    return {
      outcome: "unavailable",
      reason: "ACP permission request failed.",
    };
  }
  return {
    outcome: "resolved",
    decision: resolveAcpApprovalDecision(result.response, request.options) ?? "deny",
  };
}

export type AcpApprovalHostOptions = {
  connection: AgentSideConnection;
  sessionId: string;
};

/** Binds one ACP client connection and session to process-local run approvals. */
export function createAcpApprovalHost(options: AcpApprovalHostOptions): AgentRunApprovalHost {
  const host: AgentRunApprovalHost = {
    exec: Object.freeze<AgentRunExecApprovalHost>({
      request: async ({ request, timeoutMs, signal }) => {
        signal?.throwIfAborted();
        return createExecApprovalLease({
          connection: options.connection,
          sessionId: options.sessionId,
          request,
          timeoutMs,
          signal,
        });
      },
    }),
    plugin: Object.freeze<AgentRunPluginApprovalHost>({
      request: ({ request, timeoutMs, signal, onRegistered }) =>
        requestPluginApproval({
          connection: options.connection,
          sessionId: options.sessionId,
          request,
          timeoutMs,
          signal,
          onRegistered,
        }),
    }),
  };
  return Object.freeze(host);
}

import type { ExecApprovalDecision } from "../infra/exec-approvals.js";
import type { PluginApprovalRequestPayload } from "../infra/plugin-approvals.js";

export type AgentRunPluginApprovalResult =
  | { outcome: "resolved"; decision: ExecApprovalDecision }
  | { outcome: "timed-out"; deliveryRoute?: "turn-source" }
  | { outcome: "unavailable"; reason: string };

export type AgentRunPluginApprovalHost = {
  request: (params: {
    request: PluginApprovalRequestPayload;
    timeoutMs: number;
    signal?: AbortSignal;
    onRegistered?: (registration: { id: string }) => void;
  }) => Promise<AgentRunPluginApprovalResult>;
};

/**
 * Immutable operator-approval capabilities supplied by the runtime adapter.
 * Missing capabilities fail closed; they never fall through to another host.
 */
export type AgentRunApprovalHost = {
  /** Serializable fail-closed marker; live capability hosts omit this field. */
  mode?: "none";
  plugin?: AgentRunPluginApprovalHost;
};

/** Explicit process-local marker for runs that own no approval capabilities. */
export const noAgentRunApprovalHost: AgentRunApprovalHost = Object.freeze({ mode: "none" });

export function isNoAgentRunApprovalHost(
  host: AgentRunApprovalHost | undefined,
): host is AgentRunApprovalHost & { mode: "none" } {
  return host?.mode === "none";
}

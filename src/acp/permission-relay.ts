/** Shared ACP permission decision and option helpers. */
import type { PermissionOption, RequestPermissionResponse } from "@agentclientprotocol/sdk";

export type AcpApprovalDecision = "allow-once" | "allow-always" | "deny";

const FALLBACK_APPROVAL_DECISIONS = ["allow-once", "deny"] as const;

function normalizeAcpApprovalDecision(value: unknown): AcpApprovalDecision | undefined {
  if (value === "allow-once" || value === "allow-always" || value === "deny") {
    return value;
  }
  return undefined;
}

/** Normalizes ACP approval decisions and falls back to a caller-provided safe set. */
export function normalizeAcpApprovalDecisions(
  value: unknown,
  fallback: readonly AcpApprovalDecision[] = FALLBACK_APPROVAL_DECISIONS,
): AcpApprovalDecision[] {
  const normalized = Array.isArray(value)
    ? value
        .map(normalizeAcpApprovalDecision)
        .filter((decision): decision is AcpApprovalDecision => Boolean(decision))
    : [];
  return normalized.length > 0 ? normalized : [...fallback];
}

/** Converts OpenClaw approval decisions into ACP permission options. */
export function buildAcpPermissionOptions(
  decisions: readonly AcpApprovalDecision[],
): PermissionOption[] {
  const unique = new Set<AcpApprovalDecision>(decisions);
  const options: PermissionOption[] = [];
  if (unique.has("allow-once")) {
    options.push({
      optionId: "allow-once",
      name: "Allow once",
      kind: "allow_once",
    });
  }
  if (unique.has("allow-always")) {
    options.push({
      optionId: "allow-always",
      name: "Allow always",
      kind: "allow_always",
    });
  }
  if (unique.has("deny")) {
    options.push({
      optionId: "deny",
      name: "Deny",
      kind: "reject_once",
    });
  }
  return options.length > 0 ? options : buildAcpPermissionOptions(FALLBACK_APPROVAL_DECISIONS);
}

/** Maps a selected ACP permission option back to an offered OpenClaw decision. */
export function resolveAcpApprovalDecision(
  response: RequestPermissionResponse | undefined,
  options: readonly PermissionOption[],
): AcpApprovalDecision | undefined {
  const outcome = response?.outcome;
  if (!outcome || outcome.outcome !== "selected") {
    return undefined;
  }
  const selected = options.find((option) => option.optionId === outcome.optionId);
  return normalizeAcpApprovalDecision(selected?.optionId);
}

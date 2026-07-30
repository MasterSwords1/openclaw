import { readInstallPolicyWarningDetails } from "../../../../packages/gateway-protocol/src/install-policy-warning-details.js";

export type ClawHubInstallMessage = {
  kind: "success" | "error";
  text: string;
  acknowledgeSlug?: string;
  acknowledgeVersion?: string;
  acknowledgeLabel?: string;
  acknowledgeClawHubRisk?: boolean;
  acknowledgeInstallPolicyWarning?: boolean;
};

export type SkillMessage = {
  kind: "success" | "error";
  message: string;
  acknowledgeInstallPolicyWarning?: {
    name: string;
    installId: string;
  };
};

export function readInstallPolicyWarningText(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("details" in error)) {
    return undefined;
  }
  const warning = readInstallPolicyWarningDetails(
    (error as { details?: unknown }).details,
  )?.installPolicyWarning;
  if (!warning) {
    return undefined;
  }
  const findings = (warning.findings ?? []).map((finding) => `• ${finding.message}`);
  return [warning.reason, ...findings].join("\n");
}

// Defines plugin install security scan result types.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { InstallPolicyFinding } from "../security/install-policy.js";

export type InstallPolicyWarning = {
  reason: string;
  findings?: InstallPolicyFinding[];
};

/** Result returned by plugin/skill install security policy checks. */
export type InstallSecurityScanResult =
  | {
      blocked: {
        code?: "security_scan_blocked" | "security_scan_failed";
        reason: string;
      };
      warning?: never;
    }
  | {
      blocked?: never;
      warning: InstallPolicyWarning;
    };

/** Overrides that intentionally loosen install safety policy for trusted/operator paths. */
export type InstallSafetyOverrides = {
  config?: OpenClawConfig;
  acknowledgeInstallPolicyWarning?: boolean;
  onInstallPolicyWarning?: (warning: InstallPolicyWarning) => boolean | Promise<boolean>;
  dangerouslyForceUnsafeInstall?: boolean;
  trustedSourceLinkedOfficialInstall?: boolean;
};

export function buildInstallPolicyAcknowledgementOptions(
  overrides: InstallSafetyOverrides,
): Pick<InstallSafetyOverrides, "acknowledgeInstallPolicyWarning" | "onInstallPolicyWarning"> {
  return {
    ...(overrides.acknowledgeInstallPolicyWarning === true
      ? { acknowledgeInstallPolicyWarning: true }
      : {}),
    ...(overrides.onInstallPolicyWarning
      ? { onInstallPolicyWarning: overrides.onInstallPolicyWarning }
      : {}),
  };
}

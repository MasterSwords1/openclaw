import type { InstallPolicyWarning } from "../../plugins/install-security-scan.js";

/** Normalized output returned by skill install flows and command wrappers. */
export type SkillInstallSkipReason = "brew" | "go" | "uv";

export type SkillInstallResult = {
  ok: boolean;
  message: string;
  stdout: string;
  stderr: string;
  code: number | null;
  skipReason?: SkillInstallSkipReason;
  warnings?: string[];
  installPolicyWarning?: InstallPolicyWarning;
};

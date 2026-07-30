import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import type { InstallPolicyWarning } from "../plugins/install-security-scan.js";
import { promptYesNo } from "./prompt.js";

function canPromptForInstallPolicyWarning(): boolean {
  return process.stdin.isTTY && process.stdout.isTTY;
}

export function resolveInstallPolicyAcknowledgementCliOptions(params: {
  acknowledgeInstallPolicyWarning?: boolean;
  action: "install" | "update";
  allowPrompt?: boolean;
}): {
  acknowledgeInstallPolicyWarning?: boolean;
  onInstallPolicyWarning?: (warning: InstallPolicyWarning) => Promise<boolean>;
} {
  if (params.acknowledgeInstallPolicyWarning === true) {
    return { acknowledgeInstallPolicyWarning: true };
  }
  if (params.allowPrompt === false || !canPromptForInstallPolicyWarning()) {
    return {};
  }
  return {
    onInstallPolicyWarning: async (warning) =>
      await promptYesNo(
        `${params.action === "install" ? "Install" : "Update"} after this policy warning?\n${sanitizeTerminalText(warning.reason)}`,
      ),
  };
}

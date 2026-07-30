import { describe, expect, it } from "vitest";
import {
  buildInstallPolicyWarningDetails,
  readInstallPolicyWarningDetails,
} from "./install-policy-warning-details.js";

describe("install-policy warning details", () => {
  it("round-trips a warning with findings", () => {
    const details = buildInstallPolicyWarningDetails({
      warning: {
        reason: "manual review recommended",
        findings: [
          {
            ruleId: "dangerous-exec",
            severity: "warn",
            message: "The package launches a child process.",
            file: "index.js",
            line: 12,
          },
        ],
      },
    });

    expect(readInstallPolicyWarningDetails(details)).toEqual(details);
  });

  it("requires a non-empty reason and ignores malformed findings", () => {
    expect(
      readInstallPolicyWarningDetails({ installPolicyWarning: { reason: " " } }),
    ).toBeUndefined();
    expect(
      readInstallPolicyWarningDetails({
        installPolicyWarning: {
          reason: "manual review recommended",
          findings: [
            {
              ruleId: "dangerous-exec",
              severity: "unknown",
              message: "The package launches a child process.",
            },
          ],
        },
      }),
    ).toEqual({
      installPolicyWarning: {
        reason: "manual review recommended",
      },
    });
  });

  it("bounds findings read from Gateway error details", () => {
    const findings = Array.from({ length: 101 }, (_, index) => ({
      ruleId: `rule-${index}`,
      severity: "info",
      message: `Finding ${index}`,
    }));

    expect(
      readInstallPolicyWarningDetails({
        installPolicyWarning: { reason: "manual review recommended", findings },
      })?.installPolicyWarning.findings,
    ).toHaveLength(100);
  });
});

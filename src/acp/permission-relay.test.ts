/** Tests shared ACP permission option and outcome helpers. */
import { describe, expect, it } from "vitest";
import {
  buildAcpPermissionOptions,
  normalizeAcpApprovalDecisions,
  resolveAcpApprovalDecision,
} from "./permission-relay.js";

describe("ACP permission helpers", () => {
  it("filters unknown decisions and falls back to allow-once plus deny", () => {
    const optionIds = (decisions: unknown) =>
      buildAcpPermissionOptions(normalizeAcpApprovalDecisions(decisions)).map(
        (option) => option.optionId,
      );

    expect(optionIds(["allow-once", "bogus", "deny"])).toEqual(["allow-once", "deny"]);
    expect(optionIds(["bogus"])).toEqual(["allow-once", "deny"]);
    expect(optionIds(undefined)).toEqual(["allow-once", "deny"]);
  });

  it("deduplicates decisions in stable ACP option order", () => {
    expect(
      buildAcpPermissionOptions(["deny", "allow-once", "deny", "allow-always"]).map(
        (option) => option.optionId,
      ),
    ).toEqual(["allow-once", "allow-always", "deny"]);
  });

  it("accepts only selected options that were offered", () => {
    const options = buildAcpPermissionOptions(["allow-always", "deny"]);

    expect(
      resolveAcpApprovalDecision(
        { outcome: { outcome: "selected", optionId: "allow-always" } },
        options,
      ),
    ).toBe("allow-always");
    expect(
      resolveAcpApprovalDecision(
        { outcome: { outcome: "selected", optionId: "allow-once" } },
        options,
      ),
    ).toBeUndefined();
    expect(
      resolveAcpApprovalDecision({ outcome: { outcome: "cancelled" } }, options),
    ).toBeUndefined();
  });
});

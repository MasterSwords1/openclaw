import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { WizardStepSchema } from "./wizard.js";

describe("WizardStepSchema", () => {
  it("accepts old steps without the additive input flag", () => {
    expect(Value.Check(WizardStepSchema, { id: "name", type: "text" })).toBe(true);
    expect(Value.Check(WizardStepSchema, { id: "open", type: "action" })).toBe(true);
  });

  it.each([
    { type: "note", requiresUserInput: false },
    { type: "select", requiresUserInput: true },
    { type: "text", requiresUserInput: true },
    { type: "confirm", requiresUserInput: true },
    { type: "multiselect", requiresUserInput: true },
    { type: "progress", requiresUserInput: false },
    { type: "action", executor: "client", requiresUserInput: true },
    { type: "action", executor: "gateway", requiresUserInput: false },
  ] as const)("accepts the declared input mode for $type/$executor", (step) => {
    expect(Value.Check(WizardStepSchema, { id: "step", ...step })).toBe(true);
  });

  it.each([
    { type: "note", requiresUserInput: true },
    { type: "text", requiresUserInput: false },
    { type: "action", executor: "client", requiresUserInput: false },
    { type: "action", executor: "gateway", requiresUserInput: true },
  ] as const)("rejects a contradictory input mode for $type/$executor", (step) => {
    expect(Value.Check(WizardStepSchema, { id: "step", ...step })).toBe(false);
  });
});

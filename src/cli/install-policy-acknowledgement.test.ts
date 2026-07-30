import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveInstallPolicyAcknowledgementCliOptions } from "./install-policy-acknowledgement.js";

const promptYesNoMock = vi.hoisted(() => vi.fn());

vi.mock("./prompt.js", () => ({
  promptYesNo: promptYesNoMock,
}));

const originalStdinTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const originalStdoutTty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

function setTty(value: boolean): void {
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value });
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value });
}

function restoreTty(): void {
  if (originalStdinTty) {
    Object.defineProperty(process.stdin, "isTTY", originalStdinTty);
  } else {
    Reflect.deleteProperty(process.stdin, "isTTY");
  }
  if (originalStdoutTty) {
    Object.defineProperty(process.stdout, "isTTY", originalStdoutTty);
  } else {
    Reflect.deleteProperty(process.stdout, "isTTY");
  }
}

describe("resolveInstallPolicyAcknowledgementCliOptions", () => {
  afterEach(() => {
    promptYesNoMock.mockReset();
    restoreTty();
  });

  it("uses an explicit acknowledgement without prompting", () => {
    setTty(true);

    const options = resolveInstallPolicyAcknowledgementCliOptions({
      acknowledgeInstallPolicyWarning: true,
      action: "install",
    });

    expect(options).toEqual({ acknowledgeInstallPolicyWarning: true });
  });

  it("does not prompt outside an interactive terminal or during dry runs", () => {
    setTty(false);
    expect(
      resolveInstallPolicyAcknowledgementCliOptions({ action: "update" }).onInstallPolicyWarning,
    ).toBeUndefined();

    setTty(true);
    expect(
      resolveInstallPolicyAcknowledgementCliOptions({
        action: "update",
        allowPrompt: false,
      }).onInstallPolicyWarning,
    ).toBeUndefined();
  });

  it("sanitizes and confirms an interactive policy warning", async () => {
    setTty(true);
    promptYesNoMock.mockResolvedValueOnce(true);
    const options = resolveInstallPolicyAcknowledgementCliOptions({
      action: "install",
    });

    await expect(
      options.onInstallPolicyWarning?.({
        reason: "Review\nthis\u001b[2K package.",
      }),
    ).resolves.toBe(true);
    expect(promptYesNoMock).toHaveBeenCalledWith(
      "Install after this policy warning?\nReview\\nthis package.",
    );
  });
});

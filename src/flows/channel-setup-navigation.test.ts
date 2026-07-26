import { describe, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import { WizardCancelledError } from "../wizard/prompts.js";
import { runScopedChannelStep } from "./channel-setup-navigation.js";

describe("channel setup navigation", () => {
  it("settles reversible setup work when the controlling session aborts", async () => {
    const abortController = new AbortController();
    const reason = new WizardCancelledError();
    let finishWork: (() => void) | undefined;
    const runner = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finishWork = () => resolve("late result");
        }),
    );

    const task = runScopedChannelStep({
      prompter: createWizardPrompter(),
      options: { abortSignal: abortController.signal },
      runner,
    });
    await vi.waitFor(() => expect(runner).toHaveBeenCalledOnce());

    abortController.abort(reason);

    await expect(task).rejects.toBe(reason);
    finishWork?.();
  });
});

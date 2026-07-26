import type { SetupChannelsOptions } from "../channels/plugins/setup-wizard-types.js";
import { ensureChannelSetupPluginInstalled } from "../commands/channel-setup/plugin-install.js";
import { runWizardWithPromptNavigationScope } from "../wizard/navigation-prompter.js";
import { WizardCancelledError, type WizardPrompter } from "../wizard/prompts.js";

type ScopedChannelStepParams<T> = {
  prompter: WizardPrompter;
  options?: SetupChannelsOptions;
  runner: (prompter: WizardPrompter, options: SetupChannelsOptions) => Promise<T>;
  onPersistentEffect?: () => void;
};

function cancellationReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new WizardCancelledError();
}

async function runWithSetupCancellation<T>(
  signal: AbortSignal | undefined,
  runner: () => Promise<T>,
): Promise<T> {
  if (!signal) {
    return await runner();
  }
  if (signal.aborted) {
    throw cancellationReason(signal);
  }
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const settle = (result: { value: T } | { error: unknown }) => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener("abort", onAbort);
      if ("error" in result) {
        // Preserve adapter errors and cancellation reasons without rewriting them.
        // oxlint-disable-next-line typescript/prefer-promise-reject-errors
        reject(result.error);
      } else {
        resolve(result.value);
      }
    };
    const onAbort = () => settle({ error: cancellationReason(signal) });
    signal.addEventListener("abort", onAbort, { once: true });
    void Promise.resolve()
      .then(runner)
      .then(
        (value) => settle({ value }),
        (error: unknown) => settle({ error }),
      );
    if (signal.aborted) {
      onAbort();
    }
  });
}

export async function runScopedChannelStep<T>(params: ScopedChannelStepParams<T>) {
  return await runWizardWithPromptNavigationScope(params.prompter, async (scopedPrompter) =>
    runWithSetupCancellation(params.options?.abortSignal, async () =>
      params.runner(scopedPrompter, {
        ...params.options,
        beforePersistentEffect: async () => {
          scopedPrompter.disableBackNavigation?.();
          await params.options?.beforePersistentEffect?.();
          // Publish recovery identity only after cancellation is locked; a
          // rejected guard must leave the reversible channel choice unbound.
          params.onPersistentEffect?.();
        },
      }),
    ),
  );
}

type ChannelPluginInstallParams = Omit<
  Parameters<typeof ensureChannelSetupPluginInstalled>[0],
  "prompter" | "beforePersistentEffect"
>;

export async function ensureChannelSetupPluginInstalledWithNavigation(params: {
  install: ChannelPluginInstallParams;
  prompter: WizardPrompter;
  options?: SetupChannelsOptions;
  onPersistentEffect?: () => void;
}) {
  let persistentEffectStarted = false;
  const outcome = await runScopedChannelStep({
    prompter: params.prompter,
    options: params.options,
    runner: async (scopedPrompter, scopedOptions) =>
      await ensureChannelSetupPluginInstalled({
        ...params.install,
        prompter: scopedPrompter,
        beforePersistentEffect: scopedOptions.beforePersistentEffect,
      }),
    onPersistentEffect: () => {
      persistentEffectStarted = true;
      params.onPersistentEffect?.();
    },
  });
  return { ...outcome, persistentEffectStarted };
}

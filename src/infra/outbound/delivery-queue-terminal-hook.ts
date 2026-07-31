import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../errors.js";
import { resolveOutboundChannelMessageAdapter } from "./channel-resolution.js";

/** Provider cleanup runs only after core has made the queue id non-replayable. */
export async function runOutboundQueueTerminalHook(params: {
  cfg: OpenClawConfig;
  queueId: string;
  stateDir?: string;
  channel: string;
  to: string;
  accountId?: string | null;
  warn: (message: string) => void;
}): Promise<void> {
  const adapter = resolveOutboundChannelMessageAdapter({
    channel: params.channel,
    cfg: params.cfg,
    allowBootstrap: true,
  });
  const hook = adapter?.durableFinal?.afterQueueTerminal;
  if (!hook) {
    return;
  }
  try {
    await hook({
      cfg: params.cfg,
      queueId: params.queueId,
      ...(params.stateDir !== undefined ? { deliveryQueueStateDir: params.stateDir } : {}),
      channel: params.channel,
      to: params.to,
      accountId: params.accountId,
    });
  } catch (error) {
    // The queue terminal is authoritative. Plugin artifact cleanup is retried by
    // provider GC and must never resurrect or downgrade a settled delivery.
    params.warn(
      `provider cleanup failed for terminal delivery ${params.queueId}: ${formatErrorMessage(error)}`,
    );
  }
}

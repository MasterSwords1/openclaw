import type { CliDeps } from "../cli/deps.types.js";
import type { OutboundPayloadJson } from "../infra/outbound/payloads.js";
import type { RuntimeEnv } from "../runtime.js";
import type { EmbeddedAgentRunMeta } from "./embedded-agent-runner/types.js";

export type OpenClawRuntimeTurnInput = {
  runId: string;
  sessionKey: string;
  message: string;
  messageChannel: string;
  abortSignal: AbortSignal;
  agentId?: string;
  sessionId?: string;
  thinking?: string;
  timeoutMs?: number;
  deliver?: boolean;
};

export type OpenClawRuntimeTurnResult =
  | {
      payloads: OutboundPayloadJson[];
      meta: EmbeddedAgentRunMeta;
    }
  | undefined;

const silentRuntime: RuntimeEnv = {
  log: () => undefined,
  error: () => undefined,
  exit: (code): never => {
    throw new Error(`OpenClaw runtime exit ${String(code)}`);
  },
};

let defaultDepsPromise: Promise<CliDeps> | undefined;

function loadDefaultDeps(): Promise<CliDeps> {
  defaultDepsPromise ??= import("../cli/deps.js").then(({ createDefaultDeps }) =>
    createDefaultDeps(),
  );
  return defaultDepsPromise;
}

function timeoutSecondsFromMs(timeoutMs: number | undefined): string | undefined {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs < 0) {
    return undefined;
  }
  return String(Math.ceil(timeoutMs / 1000));
}

export async function runOpenClawRuntimeTurn(
  input: OpenClawRuntimeTurnInput,
): Promise<OpenClawRuntimeTurnResult> {
  const [{ agentCommandFromIngress }, deps] = await Promise.all([
    import("./agent-command.js"),
    loadDefaultDeps(),
  ]);
  const timeout = timeoutSecondsFromMs(input.timeoutMs);
  return await agentCommandFromIngress(
    {
      runId: input.runId,
      sessionKey: input.sessionKey,
      message: input.message,
      ...(input.agentId ? { agentId: input.agentId } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      thinking: input.thinking,
      deliver: input.deliver,
      channel: input.messageChannel,
      runContext: {
        messageChannel: input.messageChannel,
      },
      ...(timeout !== undefined ? { timeout } : {}),
      abortSignal: input.abortSignal,
      allowModelOverride: false,
    },
    silentRuntime,
    deps,
  );
}

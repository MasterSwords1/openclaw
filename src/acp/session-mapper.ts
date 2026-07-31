/** Parses ACP request metadata and delegates session routing to the local runtime. */
import { readBool, readString } from "@openclaw/acp-core/meta";
import type { AcpLocalSessionRuntime } from "./local-session-runtime.js";

export type AcpSessionMeta = {
  sessionKey?: string;
  sessionLabel?: string;
  resetSession?: boolean;
  requireExisting?: boolean;
  prefixCwd?: boolean;
};

/** Parses ACP request metadata into OpenClaw session routing hints. */
export function parseSessionMeta(meta: unknown): AcpSessionMeta {
  if (!meta || typeof meta !== "object") {
    return {};
  }
  const record = meta as Record<string, unknown>;
  return {
    sessionKey: readString(record, ["sessionKey", "session", "key"]),
    sessionLabel: readString(record, ["sessionLabel", "label"]),
    resetSession: readBool(record, ["resetSession", "reset"]),
    requireExisting: readBool(record, ["requireExistingSession", "requireExisting"]),
    prefixCwd: readBool(record, ["prefixCwd"]),
  };
}

/** Resolves an ACP request to a canonical process-local session key. */
export async function resolveSessionKey(params: {
  meta: AcpSessionMeta;
  fallbackKey: string;
  runtime: Pick<AcpLocalSessionRuntime, "resolveSessionKey">;
}): Promise<string> {
  return await params.runtime.resolveSessionKey({
    meta: params.meta,
    fallbackKey: params.fallbackKey,
  });
}

/** Applies the optional ACP session reset through the process-local runtime. */
export async function resetSessionIfNeeded(params: {
  meta: AcpSessionMeta;
  sessionKey: string;
  cwd: string;
  runtime: Pick<AcpLocalSessionRuntime, "resetSessionIfNeeded">;
}): Promise<void> {
  await params.runtime.resetSessionIfNeeded({
    meta: params.meta,
    sessionKey: params.sessionKey,
    cwd: params.cwd,
  });
}

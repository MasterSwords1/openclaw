import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { getRuntimeConfig } from "../io.js";
import { resolveSessionStoreTargetWithStore } from "./session-store-target.js";
import type { SessionEntry } from "./types.js";

function loadResolvedSessionEntryWithMode(
  sessionKey: string,
  opts: { agentId?: string; clone?: boolean; includeStoreChildEntries?: boolean } | undefined,
  readOnly: boolean,
) {
  const cfg = getRuntimeConfig();
  const key = normalizeOptionalString(sessionKey) ?? "";
  const target = resolveSessionStoreTargetWithStore({
    cfg,
    key,
    ...(opts?.clone === false ? { clone: false } : {}),
    ...(opts?.agentId ? { agentId: opts.agentId } : {}),
    ...(readOnly
      ? {
          exactRead: true,
          readOnly: true,
          ...(opts?.includeStoreChildEntries ? { includeStoreChildEntries: true } : {}),
        }
      : {}),
  });
  const freshestMatch = resolveFreshestSessionStoreMatchFromStoreKeys(
    target.store,
    target.storeKeys,
  );
  const legacyKey = freshestMatch?.key !== target.canonicalKey ? freshestMatch?.key : undefined;
  const entry =
    readOnly && opts?.clone !== false && freshestMatch?.entry
      ? structuredClone(freshestMatch.entry)
      : freshestMatch?.entry;
  return {
    cfg,
    storePath: target.storePath,
    store: target.store,
    entry,
    canonicalKey: target.canonicalKey,
    storeKeys: target.storeKeys,
    legacyKey,
  };
}

export function loadResolvedSessionEntry(
  sessionKey: string,
  opts?: { agentId?: string; clone?: boolean },
) {
  return loadResolvedSessionEntryWithMode(sessionKey, opts, false);
}

export function loadResolvedSessionEntryReadOnly(
  sessionKey: string,
  opts?: { agentId?: string; clone?: boolean; includeStoreChildEntries?: boolean },
) {
  return loadResolvedSessionEntryWithMode(sessionKey, opts, true);
}

/** Returns both the freshest entry and the exact persisted key that owns it. */
export function resolveFreshestSessionStoreMatchFromStoreKeys(
  store: Record<string, SessionEntry>,
  storeKeys: string[],
): { key: string; entry: SessionEntry } | undefined {
  let freshest: { key: string; entry: SessionEntry } | undefined;
  for (const key of storeKeys) {
    const entry = store[key];
    if (!entry) {
      continue;
    }
    const match = { key, entry };
    if (!freshest || (match.entry.updatedAt ?? 0) > (freshest.entry.updatedAt ?? 0)) {
      freshest = match;
    }
  }
  return freshest;
}

export function resolveFreshestSessionEntryFromStoreKeys(
  store: Record<string, SessionEntry>,
  storeKeys: string[],
): SessionEntry | undefined {
  return resolveFreshestSessionStoreMatchFromStoreKeys(store, storeKeys)?.entry;
}

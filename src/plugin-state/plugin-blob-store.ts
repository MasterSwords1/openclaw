// Public facade for plugin-scoped SQLite blob storage.
import { normalizeSqliteNumber } from "../infra/sqlite-number.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { resolvePluginBlobStorageNamespace } from "../state/openclaw-state-snapshot-policy.js";
import {
  MAX_PLUGIN_BLOB_BYTES_PER_ENTRY,
  MAX_PLUGIN_BLOB_BYTES_PER_PLUGIN,
  MAX_PLUGIN_BLOB_ENTRIES_PER_PLUGIN,
  pluginBlobClear,
  pluginBlobDelete,
  pluginBlobDeleteExpiredKey,
  pluginBlobDeleteExpired,
  pluginBlobEntries,
  pluginBlobLookup,
  pluginBlobRegister,
  pluginBlobRegisterIfAbsent,
  type PluginBlobStoredEntry,
  type PluginBlobStoredInfo,
} from "./plugin-blob-store.sqlite.js";
import type {
  OpenBlobStoreOptions,
  PluginBlobEntry,
  PluginBlobEntryInfo,
  PluginBlobOverflowPolicy,
  PluginBlobRegisterOptions,
  PluginBlobSnapshotPolicy,
  PluginBlobStore,
  PluginBlobStoreOperation,
} from "./plugin-blob-store.types.js";
import { PluginBlobStoreError } from "./plugin-blob-store.types.js";
import {
  serializePluginStoreJson,
  validateOptionalPluginStoreTtlMs,
  validatePluginStoreKey,
  validatePluginStoreNamespace,
  validatePluginStorePositiveInteger,
} from "./plugin-store-validation.js";

export type {
  OpenBlobStoreOptions,
  PluginBlobEntry,
  PluginBlobEntryInfo,
  PluginBlobStore,
} from "./plugin-blob-store.types.js";

type BlobStoreOptionSignature = {
  maxEntries: number;
  maxBytesPerEntry: number;
  maxBytesPerNamespace: number;
  overflowPolicy: PluginBlobOverflowPolicy;
  defaultTtlMs?: number;
  snapshotPolicy: PluginBlobSnapshotPolicy;
};

type PreparedBlob = {
  key: string;
  bytes: Uint8Array;
  metadataJson: string;
  ttlMs?: number;
};

type SnapshotExcludedMetadataEnvelope = {
  version: 1;
  snapshotOwner: { kind: "delivery-queue"; id: string };
  metadata: unknown;
};

const namespaceOptionSignatures = new Map<string, BlobStoreOptionSignature>();

function invalidInput(
  message: string,
  operation: PluginBlobStoreOperation = "register",
): PluginBlobStoreError {
  return new PluginBlobStoreError(message, {
    code: "PLUGIN_BLOB_INVALID_INPUT",
    operation,
  });
}

function limitError(message: string): PluginBlobStoreError {
  return new PluginBlobStoreError(message, {
    code: "PLUGIN_BLOB_LIMIT_EXCEEDED",
    operation: "register",
  });
}

const validationErrors = (operation: PluginBlobStoreOperation) => ({
  invalid: (message: string) => invalidInput(message, operation),
  limit: (message: string) => limitError(message),
});

function validateNamespace(value: string): string {
  return validatePluginStoreNamespace({
    value,
    label: "plugin blob",
    errors: validationErrors("open"),
  });
}

function validateKey(value: string, operation: PluginBlobStoreOperation): string {
  return validatePluginStoreKey({
    value,
    label: "plugin blob",
    errors: validationErrors(operation),
  });
}

function validatePositiveLimit(value: number, label: string, maximum: number): number {
  const normalized = validatePluginStorePositiveInteger({
    value,
    label,
    errors: validationErrors("open"),
  });
  if (normalized > maximum) {
    throw invalidInput(`${label} must be <= ${maximum}`, "open");
  }
  return normalized;
}

function validateOverflowPolicy(value: unknown): PluginBlobOverflowPolicy {
  if (value === undefined || value === "evict-oldest") {
    return "evict-oldest";
  }
  if (value === "reject-new") {
    return value;
  }
  throw invalidInput("plugin blob overflowPolicy must be evict-oldest or reject-new", "open");
}

function validateSnapshotPolicy(value: unknown): PluginBlobSnapshotPolicy {
  if (value === undefined || value === "restorable") {
    return "restorable";
  }
  if (value === "exclude") {
    return value;
  }
  throw invalidInput("plugin blob snapshotPolicy must be restorable or exclude", "open");
}

function validateTtl(
  value: number | undefined,
  operation: PluginBlobStoreOperation,
): number | undefined {
  return validateOptionalPluginStoreTtlMs({
    value,
    label: "plugin blob ttlMs",
    errors: validationErrors(operation),
  });
}

function assertConsistentOptions(
  pluginId: string,
  namespace: string,
  signature: BlobStoreOptionSignature,
): void {
  const key = `${pluginId}\0${namespace}`;
  const existing = namespaceOptionSignatures.get(key);
  if (!existing) {
    namespaceOptionSignatures.set(key, signature);
    return;
  }
  if (
    existing.maxEntries !== signature.maxEntries ||
    existing.maxBytesPerEntry !== signature.maxBytesPerEntry ||
    existing.maxBytesPerNamespace !== signature.maxBytesPerNamespace ||
    existing.overflowPolicy !== signature.overflowPolicy ||
    existing.defaultTtlMs !== signature.defaultTtlMs ||
    existing.snapshotPolicy !== signature.snapshotPolicy
  ) {
    // Namespace limits are a shared contract. Reopening with different limits
    // would make quota and eviction behavior depend on call order.
    throw invalidInput(
      `plugin blob namespace ${namespace} for ${pluginId} was reopened with incompatible options`,
      "open",
    );
  }
}

function prepareBlob(params: {
  key: string;
  bytes: Uint8Array;
  metadata: unknown;
  maxBytesPerEntry: number;
  defaultTtlMs?: number;
  snapshotPolicy: PluginBlobSnapshotPolicy;
  opts?: PluginBlobRegisterOptions;
}): PreparedBlob {
  const key = validateKey(params.key, "register");
  if (!(params.bytes instanceof Uint8Array)) {
    throw invalidInput("plugin blob bytes must be a Uint8Array");
  }
  if (params.bytes.byteLength > params.maxBytesPerEntry) {
    throw limitError(
      `plugin blob entry exceeds the configured ${params.maxBytesPerEntry} byte limit`,
    );
  }
  const snapshotOwner = params.opts?.snapshotOwner;
  if (params.snapshotPolicy === "exclude" && !snapshotOwner) {
    throw invalidInput("snapshot-excluded plugin blobs require a delivery-queue snapshotOwner");
  }
  if (params.snapshotPolicy === "restorable" && snapshotOwner) {
    throw invalidInput("restorable plugin blobs cannot declare a snapshotOwner");
  }
  let storedMetadata: unknown = params.metadata;
  if (snapshotOwner) {
    const snapshotOwnerId =
      typeof snapshotOwner.id === "string" ? snapshotOwner.id.trim() : undefined;
    if (!snapshotOwnerId) {
      throw invalidInput("plugin blob snapshotOwner id must be a non-empty string");
    }
    storedMetadata = {
      version: 1,
      snapshotOwner: { kind: snapshotOwner.kind, id: snapshotOwnerId },
      metadata: params.metadata,
    } satisfies SnapshotExcludedMetadataEnvelope;
  }
  const metadataJson = serializePluginStoreJson({
    value: storedMetadata,
    label: "plugin blob metadata",
    errors: validationErrors("register"),
  });
  const ttlMs = validateTtl(params.opts?.ttlMs, "register") ?? params.defaultTtlMs;
  return {
    key,
    bytes: Uint8Array.from(params.bytes),
    metadataJson,
    ...(ttlMs !== undefined ? { ttlMs } : {}),
  };
}

function parseMetadata(
  raw: string,
  operation: PluginBlobStoreOperation,
  env?: NodeJS.ProcessEnv,
  snapshotPolicy: PluginBlobSnapshotPolicy = "restorable",
): unknown {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (snapshotPolicy !== "exclude") {
      return parsed;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("snapshot metadata envelope is missing");
    }
    const envelope = parsed as Partial<SnapshotExcludedMetadataEnvelope>;
    if (
      envelope.version !== 1 ||
      envelope.snapshotOwner?.kind !== "delivery-queue" ||
      typeof envelope.snapshotOwner.id !== "string" ||
      !envelope.snapshotOwner.id.trim() ||
      !("metadata" in envelope)
    ) {
      throw new Error("snapshot metadata envelope is invalid");
    }
    return envelope.metadata;
  } catch (error) {
    throw new PluginBlobStoreError("Plugin blob entry contains corrupt metadata JSON.", {
      code: "PLUGIN_BLOB_CORRUPT",
      operation,
      path: resolveOpenClawStateSqlitePath(env ?? process.env),
      cause: error,
    });
  }
}

function storedInfoToEntryInfo<TMetadata>(
  row: PluginBlobStoredInfo,
  operation: PluginBlobStoreOperation,
  env?: NodeJS.ProcessEnv,
  snapshotPolicy: PluginBlobSnapshotPolicy = "restorable",
): PluginBlobEntryInfo<TMetadata> {
  const expiresAt = normalizeSqliteNumber(row.expires_at);
  return {
    key: row.entry_key,
    metadata: parseMetadata(row.metadata_json, operation, env, snapshotPolicy) as TMetadata,
    sizeBytes: Number(row.size_bytes),
    createdAt: normalizeSqliteNumber(row.created_at) ?? 0,
    ...(expiresAt != null ? { expiresAt } : {}),
  };
}

function storedEntryToEntry<TMetadata>(
  row: PluginBlobStoredEntry,
  env?: NodeJS.ProcessEnv,
  snapshotPolicy: PluginBlobSnapshotPolicy = "restorable",
): PluginBlobEntry<TMetadata> {
  return {
    ...storedInfoToEntryInfo<TMetadata>(row, "lookup", env, snapshotPolicy),
    bytes: Uint8Array.from(row.blob),
  };
}

function createPluginBlobStoreInternal<TMetadata>(
  pluginId: string,
  options: OpenBlobStoreOptions,
  env?: NodeJS.ProcessEnv,
): PluginBlobStore<TMetadata> {
  if (pluginId.startsWith("core:")) {
    throw invalidInput("Plugin ids starting with 'core:' are reserved for core consumers.", "open");
  }
  const namespace = validateNamespace(options.namespace);
  const maxEntries = validatePositiveLimit(
    options.maxEntries,
    "plugin blob maxEntries",
    MAX_PLUGIN_BLOB_ENTRIES_PER_PLUGIN,
  );
  const maxBytesPerEntry = validatePositiveLimit(
    options.maxBytesPerEntry,
    "plugin blob maxBytesPerEntry",
    MAX_PLUGIN_BLOB_BYTES_PER_ENTRY,
  );
  const maxBytesPerNamespace = validatePositiveLimit(
    options.maxBytesPerNamespace,
    "plugin blob maxBytesPerNamespace",
    MAX_PLUGIN_BLOB_BYTES_PER_PLUGIN,
  );
  if (maxBytesPerEntry > maxBytesPerNamespace) {
    throw invalidInput("plugin blob maxBytesPerEntry must not exceed maxBytesPerNamespace", "open");
  }
  const overflowPolicy = validateOverflowPolicy(options.overflowPolicy);
  const defaultTtlMs = validateTtl(options.defaultTtlMs, "open");
  const snapshotPolicy = validateSnapshotPolicy(options.snapshotPolicy);
  assertConsistentOptions(pluginId, namespace, {
    maxEntries,
    maxBytesPerEntry,
    maxBytesPerNamespace,
    overflowPolicy,
    defaultTtlMs,
    snapshotPolicy,
  });
  const storageNamespace = resolvePluginBlobStorageNamespace({ namespace, snapshotPolicy });

  const writeParams = (blob: PreparedBlob) => ({
    pluginId,
    namespace: storageNamespace,
    key: blob.key,
    bytes: blob.bytes,
    metadataJson: blob.metadataJson,
    maxEntries,
    maxBytesPerNamespace,
    overflowPolicy,
    ...(blob.ttlMs !== undefined ? { ttlMs: blob.ttlMs } : {}),
    ...(env ? { env } : {}),
  });

  return {
    async register(key, bytes, metadata, opts) {
      const blob = prepareBlob({
        key,
        bytes,
        metadata,
        maxBytesPerEntry,
        defaultTtlMs,
        snapshotPolicy,
        opts,
      });
      pluginBlobRegister(writeParams(blob));
    },
    async registerIfAbsent(key, bytes, metadata, opts) {
      const blob = prepareBlob({
        key,
        bytes,
        metadata,
        maxBytesPerEntry,
        defaultTtlMs,
        snapshotPolicy,
        opts,
      });
      return pluginBlobRegisterIfAbsent(writeParams(blob));
    },
    async lookup(key) {
      const row = pluginBlobLookup({
        pluginId,
        namespace: storageNamespace,
        key: validateKey(key, "lookup"),
        ...(env ? { env } : {}),
      });
      return row ? storedEntryToEntry<TMetadata>(row, env, snapshotPolicy) : undefined;
    },
    async entries() {
      return pluginBlobEntries({
        pluginId,
        namespace: storageNamespace,
        ...(env ? { env } : {}),
      }).map((row) => storedInfoToEntryInfo<TMetadata>(row, "entries", env, snapshotPolicy));
    },
    async delete(key) {
      return pluginBlobDelete({
        pluginId,
        namespace: storageNamespace,
        key: validateKey(key, "delete"),
        ...(env ? { env } : {}),
      });
    },
    async deleteExpiredKey(key) {
      const row = pluginBlobDeleteExpiredKey({
        pluginId,
        namespace: storageNamespace,
        key: validateKey(key, "sweep"),
        validateMetadataJson: (raw) => {
          parseMetadata(raw, "sweep", env, snapshotPolicy);
        },
        ...(env ? { env } : {}),
      });
      return row ? storedInfoToEntryInfo<TMetadata>(row, "sweep", env, snapshotPolicy) : undefined;
    },
    async deleteExpired() {
      return pluginBlobDeleteExpired({
        pluginId,
        namespace: storageNamespace,
        validateMetadataJson: (raw) => {
          parseMetadata(raw, "sweep", env, snapshotPolicy);
        },
        ...(env ? { env } : {}),
      }).map((row) => storedInfoToEntryInfo<TMetadata>(row, "sweep", env, snapshotPolicy));
    },
    async clear() {
      pluginBlobClear({
        pluginId,
        namespace: storageNamespace,
        ...(env ? { env } : {}),
      });
    },
  };
}

/** Opens an async blob namespace for a non-core plugin id. */
export function createPluginBlobStore<TMetadata>(
  pluginId: string,
  options: OpenBlobStoreOptions,
): PluginBlobStore<TMetadata> {
  return createPluginBlobStoreInternal<TMetadata>(pluginId, options);
}

/** Test-only factory with an isolated state environment. */
export function createPluginBlobStoreForTests<TMetadata>(
  pluginId: string,
  options: OpenBlobStoreOptions,
  env: NodeJS.ProcessEnv,
): PluginBlobStore<TMetadata> {
  return createPluginBlobStoreInternal<TMetadata>(pluginId, options, env);
}

/** Resets facade signatures and the shared state database handle for tests. */
export function resetPluginBlobStoreForTests(options: { closeDatabase?: boolean } = {}): void {
  namespaceOptionSignatures.clear();
  if (options.closeDatabase !== false) {
    closeOpenClawStateDatabaseForTest();
  }
}

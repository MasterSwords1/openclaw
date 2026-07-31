// Public plugin namespaces cannot start with an underscore, so this encoded
// storage class cannot collide with a plugin-chosen restorable namespace.
export const PLUGIN_BLOB_SNAPSHOT_EXCLUDED_NAMESPACE_PREFIX = "_openclaw_snapshot_excluded_";

export function resolvePluginBlobStorageNamespace(params: {
  namespace: string;
  snapshotPolicy: "restorable" | "exclude";
}): string {
  return params.snapshotPolicy === "exclude"
    ? `${PLUGIN_BLOB_SNAPSHOT_EXCLUDED_NAMESPACE_PREFIX}${params.namespace}`
    : params.namespace;
}

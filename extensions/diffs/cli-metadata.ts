/**
 * Diffs CLI metadata entry. Diffs exposes no standalone CLI subcommands, so this
 * entry is a no-op that exists solely so the CLI metadata loader resolves it
 * instead of the full runtime entry (which allocates an artifact store from
 * `api.runtime.state` and is unavailable on lightweight CLI runtimes).
 */
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "diffs",
  name: "Diffs",
  description: "Read-only diff viewer and PNG/PDF renderer for agents.",
  register() {},
});

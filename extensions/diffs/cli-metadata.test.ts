// Diffs CLI metadata tests cover the lightweight no-op registration path.
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it, vi } from "vitest";
import entry from "./cli-metadata.js";

describe("diffs CLI metadata entry", () => {
  it("registers synchronously without touching state-backed runtime", () => {
    // The CLI metadata loader invokes register against an empty runtime object
    // (`runtime: {} as PluginRuntime`). The full plugin dereferences
    // `api.runtime.state.openBlobStore`, which throws because `state` is absent on
    // the empty object. This no-op entry must complete registration without ever
    // reaching into the runtime so the CLI metadata path loads cleanly.
    const registerCli = vi.fn();
    const registerTool = vi.fn();
    const registerHttpRoute = vi.fn();
    const on = vi.fn();
    const api = createTestPluginApi({
      id: "diffs",
      name: "Diffs",
      registerCli,
      registerTool,
      registerHttpRoute,
      on,
      // Deliberately omit `runtime`: any dereference throws and surfaces the bug.
    });

    entry.register(api);

    // The lightweight entry contributes no CLI commands, tools, or HTTP routes.
    expect(registerCli).not.toHaveBeenCalled();
    expect(registerTool).not.toHaveBeenCalled();
    expect(registerHttpRoute).not.toHaveBeenCalled();
    expect(on).not.toHaveBeenCalled();
  });
});

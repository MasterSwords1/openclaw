// Live Docker Stage tests cover live docker stage script behavior.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hydrateLiveDockerOpenAiAuthProfile } from "../../scripts/live-docker-hydrate-auth-profiles.js";
import { addStagedPrivatePluginSdkExports } from "../../scripts/live-docker-stage-private-sdk-exports.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const stageScriptPath = path.join(repoRoot, "scripts/lib/live-docker-stage.sh");
const liveModelsScriptPath = path.join(repoRoot, "scripts/test-live-models-docker.sh");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function resolveCanonicalLiveStagePath(root: string, candidate: string): string {
  return path.join(realpathSync.native(root), path.relative(root, candidate));
}

describe("live Docker state staging", () => {
  it("hydrates the selected OpenAI profile before live model discovery", async () => {
    const root = tempDirs.make("openclaw-live-stage-auth-");
    const stateDir = path.join(root, "state");
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const upsertAuthProfile = vi.fn(async () => ({ version: 1, profiles: {} }));
    const setAuthProfileOrder = vi.fn(async () => ({ version: 1, profiles: {} }));

    await expect(
      hydrateLiveDockerOpenAiAuthProfile({
        stageRoot: root,
        env: {
          OPENCLAW_LIVE_PROVIDERS: "anthropic, openai",
          OPENAI_API_KEY: "live-openai-fixture", // pragma: allowlist secret
          OPENCLAW_STATE_DIR: stateDir,
        },
        agentDir,
        upsertAuthProfile,
        setAuthProfileOrder,
      }),
    ).resolves.toBe(true);
    expect(upsertAuthProfile).toHaveBeenCalledExactlyOnceWith({
      profileId: "openai:api-key",
      credential: {
        type: "api_key",
        provider: "openai",
        keyRef: {
          source: "env",
          provider: "default",
          id: "OPENAI_API_KEY",
        },
      },
      agentDir: resolveCanonicalLiveStagePath(root, agentDir),
      stateDir: resolveCanonicalLiveStagePath(root, stateDir),
    });
    expect(setAuthProfileOrder).toHaveBeenCalledExactlyOnceWith({
      agentDir: resolveCanonicalLiveStagePath(root, agentDir),
      provider: "openai",
      order: ["openai:api-key"],
    });

    const script = readFileSync(liveModelsScriptPath, "utf8");
    const hydrateIndex = script.indexOf(
      'node --import tsx "$trusted_scripts_dir/live-docker-hydrate-auth-profiles.ts" "$tmp_dir"',
    );
    expect(hydrateIndex).toBeGreaterThanOrEqual(0);
    expect(hydrateIndex).toBeLessThan(
      script.indexOf("node scripts/test-live.mjs -- src/agents/models.profiles.live.test.ts"),
    );
  });

  it.each([
    {
      label: "pins the live-only OpenAI alias ahead of provider-wide environment auth",
      keyEnv: {
        OPENAI_API_KEY: "provider-fixture", // pragma: allowlist secret
        OPENCLAW_LIVE_OPENAI_KEY: "live-only-fixture", // pragma: allowlist secret
      },
    },
    {
      label: "hydrates the selected OpenAI profile from the live-only alias alone",
      keyEnv: {
        OPENCLAW_LIVE_OPENAI_KEY: "live-only-fixture", // pragma: allowlist secret
      },
    },
  ])("$label", async ({ keyEnv }) => {
    const root = tempDirs.make("openclaw-live-stage-auth-key-alias-");
    const stateDir = path.join(root, "state");
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const upsertAuthProfile = vi.fn(async () => ({ version: 1, profiles: {} }));
    const setAuthProfileOrder = vi.fn(async () => ({ version: 1, profiles: {} }));

    await expect(
      hydrateLiveDockerOpenAiAuthProfile({
        stageRoot: root,
        env: {
          OPENCLAW_LIVE_PROVIDERS: "openai",
          OPENCLAW_STATE_DIR: stateDir,
          ...keyEnv,
        },
        agentDir,
        upsertAuthProfile,
        setAuthProfileOrder,
      }),
    ).resolves.toBe(true);
    expect(upsertAuthProfile).toHaveBeenCalledExactlyOnceWith({
      profileId: "openai:api-key",
      credential: {
        type: "api_key",
        provider: "openai",
        keyRef: {
          source: "env",
          provider: "default",
          id: "OPENCLAW_LIVE_OPENAI_KEY",
        },
      },
      agentDir: resolveCanonicalLiveStagePath(root, agentDir),
      stateDir: resolveCanonicalLiveStagePath(root, stateDir),
    });
    expect(setAuthProfileOrder).toHaveBeenCalledExactlyOnceWith({
      agentDir: resolveCanonicalLiveStagePath(root, agentDir),
      provider: "openai",
      order: ["openai:api-key"],
    });
  });

  it("prioritizes the hydrated OpenAI profile without dropping existing stored order", async () => {
    const root = tempDirs.make("openclaw-live-stage-auth-order-");
    const stateDir = path.join(root, "state");
    const agentDir = path.join(stateDir, "agents", "live-default", "agent");
    const upsertAuthProfile = vi.fn(async () => ({
      version: 1,
      profiles: {},
      order: {
        openai: ["openai:existing", "openai:api-key", "openai:backup"],
      },
    }));
    const setAuthProfileOrder = vi.fn(async () => ({ version: 1, profiles: {} }));

    await expect(
      hydrateLiveDockerOpenAiAuthProfile({
        stageRoot: root,
        env: {
          OPENCLAW_LIVE_PROVIDERS: "openai",
          OPENAI_API_KEY: "live-openai-fixture", // pragma: allowlist secret
          OPENCLAW_STATE_DIR: stateDir,
        },
        agentDir,
        upsertAuthProfile,
        setAuthProfileOrder,
      }),
    ).resolves.toBe(true);

    expect(setAuthProfileOrder).toHaveBeenCalledExactlyOnceWith({
      agentDir: resolveCanonicalLiveStagePath(root, agentDir),
      provider: "openai",
      order: ["openai:api-key", "openai:existing", "openai:backup"],
    });
  });

  it("selects the configured agent's SQLite SecretRef as a real model auth profile", () => {
    const root = tempDirs.make("openclaw-live-stage-auth-process-");
    const stateDir = path.join(root, "state");
    const homeDir = path.join(root, "home");
    symlinkSync(
      path.join(repoRoot, "src"),
      path.join(root, "src"),
      process.platform === "win32" ? "junction" : "dir",
    );
    mkdirSync(homeDir, { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      path.join(stateDir, "openclaw.json"),
      JSON.stringify({
        agents: {
          entries: {
            "live-default": { default: true },
          },
        },
        auth: {
          profiles: {
            "openai:existing": { provider: "openai", mode: "api_key" },
          },
          order: {
            openai: ["openai:existing"],
          },
        },
      }),
    );
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: homeDir,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
      OPENCLAW_AGENT_DIR: undefined,
      OPENCLAW_LIVE_TEST: "1",
      OPENCLAW_LIVE_TEST_QUIET: "1",
      OPENCLAW_LIVE_PROVIDERS: "openai",
      OPENCLAW_LIVE_MODELS: "openai/gpt-5.6-luna",
      OPENAI_API_KEY: "provider-openai-process-fixture", // pragma: allowlist secret
      OPENCLAW_LIVE_OPENAI_KEY: "live-openai-process-fixture", // pragma: allowlist secret
    };

    const hydration = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        path.join(repoRoot, "scripts/live-docker-hydrate-auth-profiles.ts"),
        root,
      ],
      { cwd: repoRoot, encoding: "utf8", env, timeout: 30_000 },
    );
    expect(hydration.status, hydration.stderr).toBe(0);

    const verifyWorker = [
      'import assert from "node:assert/strict";',
      'import { existsSync } from "node:fs";',
      'import path from "node:path";',
      'import { DatabaseSync } from "node:sqlite";',
      'import { resolveDefaultAgentDir as resolveLiveLoopDefaultAgentDir } from "./src/agents/agent-scope.ts";',
      'import { resolveDefaultAgentDir } from "./src/agents/agent-scope-config.ts";',
      'import { ensureAuthProfileStoreWithoutExternalProfiles, resolveApiKeyForProfile } from "./src/agents/auth-profiles.ts";',
      'import { getRuntimeConfig } from "./src/config/config.ts";',
      'import { getApiKeyForModel } from "./src/agents/model-auth.ts";',
      'import { activateSecretsRuntimeSnapshot, prepareSecretsRuntimeSnapshot } from "./src/secrets/runtime.ts";',
      'import { installTestEnv } from "./test/test-env.ts";',
      "const config = getRuntimeConfig();",
      "const agentDir = resolveDefaultAgentDir(config);",
      "assert.equal(resolveLiveLoopDefaultAgentDir(config), agentDir);",
      'assert.equal(agentDir, path.join(process.env.OPENCLAW_STATE_DIR, "agents", "live-default", "agent"));',
      'assert.equal(existsSync(path.join(process.env.OPENCLAW_STATE_DIR, "agents", "main", "agent", "openclaw-agent.sqlite")), false);',
      'const database = new DatabaseSync(path.join(agentDir, "openclaw-agent.sqlite"), { readOnly: true });',
      'const row = database.prepare("SELECT store_json FROM auth_profile_store WHERE store_key = ?").get("primary");',
      'const state = database.prepare("SELECT state_json FROM auth_profile_state WHERE state_key = ?").get("primary");',
      "database.close();",
      "assert.ok(row);",
      "assert.ok(!row.store_json.includes(process.env.OPENAI_API_KEY));",
      "assert.ok(!row.store_json.includes(process.env.OPENCLAW_LIVE_OPENAI_KEY));",
      "assert.ok(state);",
      "assert.ok(!state.state_json.includes(process.env.OPENAI_API_KEY));",
      "assert.ok(!state.state_json.includes(process.env.OPENCLAW_LIVE_OPENAI_KEY));",
      'assert.deepEqual(JSON.parse(state.state_json).order.openai, ["openai:api-key"]);',
      'const persisted = JSON.parse(row.store_json).profiles["openai:api-key"];',
      'assert.deepEqual(persisted.keyRef, { source: "env", provider: "default", id: "OPENCLAW_LIVE_OPENAI_KEY" });',
      "assert.equal(persisted.key, undefined);",
      "const prepared = await prepareSecretsRuntimeSnapshot({",
      "  config, env: process.env, agentDirs: [agentDir],",
      "  includeConfigRefs: false, allowUnavailableSecretOwners: true,",
      "});",
      "activateSecretsRuntimeSnapshot(prepared);",
      "const store = ensureAuthProfileStoreWithoutExternalProfiles(agentDir);",
      'const resolved = await resolveApiKeyForProfile({ cfg: config, store, profileId: "openai:api-key", agentDir });',
      "assert.equal(resolved?.apiKey, process.env.OPENCLAW_LIVE_OPENAI_KEY);",
      "const modelAuth = await getApiKeyForModel({",
      '  model: { provider: "openai", id: "gpt-5.4", api: "openai-responses" },',
      '  cfg: config, agentDir, store, profileId: "openai:api-key",',
      '  lockedProfile: true, credentialPrecedence: "profile-first",',
      "});",
      'assert.equal(modelAuth.source, "profile:openai:api-key");',
      'assert.equal(modelAuth.profileId, "openai:api-key");',
      "assert.equal(modelAuth.apiKey, process.env.OPENCLAW_LIVE_OPENAI_KEY);",
      "assert.notEqual(modelAuth.apiKey, process.env.OPENAI_API_KEY);",
      "const liveTestEnv = installTestEnv({ loadProfileEnv: false });",
      "try {",
      "  assert.equal(process.env.HOME, liveTestEnv.tempHome);",
      "  const isolatedAgentDir = path.join(liveTestEnv.tempHome, '.openclaw', 'agents', 'live-default', 'agent');",
      "  assert.equal(resolveDefaultAgentDir(config), isolatedAgentDir);",
      "  assert.equal(existsSync(path.join(isolatedAgentDir, 'auth-profiles.json')), false);",
      "  const isolatedDatabase = new DatabaseSync(path.join(isolatedAgentDir, 'openclaw-agent.sqlite'), { readOnly: true });",
      "  const isolatedRow = isolatedDatabase.prepare('SELECT store_json FROM auth_profile_store WHERE store_key = ?').get('primary');",
      "  const isolatedState = isolatedDatabase.prepare('SELECT state_json FROM auth_profile_state WHERE state_key = ?').get('primary');",
      "  isolatedDatabase.close();",
      "  assert.ok(isolatedRow);",
      "  assert.ok(isolatedState);",
      "  assert.ok(!isolatedRow.store_json.includes(process.env.OPENAI_API_KEY));",
      "  assert.ok(!isolatedRow.store_json.includes(process.env.OPENCLAW_LIVE_OPENAI_KEY));",
      "  assert.deepEqual(JSON.parse(isolatedState.state_json).order.openai, ['openai:api-key']);",
      "  const isolatedProfile = JSON.parse(isolatedRow.store_json).profiles['openai:api-key'];",
      "  assert.deepEqual(isolatedProfile.keyRef, { source: 'env', provider: 'default', id: 'OPENCLAW_LIVE_OPENAI_KEY' });",
      "  assert.equal(isolatedProfile.key, undefined);",
      "  const isolatedSnapshot = await prepareSecretsRuntimeSnapshot({",
      "    config, env: process.env, agentDirs: [isolatedAgentDir],",
      "    includeConfigRefs: false, allowUnavailableSecretOwners: true,",
      "  });",
      "  activateSecretsRuntimeSnapshot(isolatedSnapshot);",
      "  const isolatedStore = ensureAuthProfileStoreWithoutExternalProfiles(isolatedAgentDir);",
      "  const isolatedAuth = await getApiKeyForModel({",
      "    model: { provider: 'openai', id: 'gpt-5.4', api: 'openai-responses' },",
      "    cfg: config, agentDir: isolatedAgentDir, store: isolatedStore,",
      "    profileId: 'openai:api-key', lockedProfile: true, credentialPrecedence: 'profile-first',",
      "  });",
      "  assert.equal(isolatedAuth.source, 'profile:openai:api-key');",
      "  assert.equal(isolatedAuth.profileId, 'openai:api-key');",
      "  assert.equal(isolatedAuth.apiKey, process.env.OPENCLAW_LIVE_OPENAI_KEY);",
      "  assert.notEqual(isolatedAuth.apiKey, process.env.OPENAI_API_KEY);",
      "} finally {",
      "  liveTestEnv.cleanup();",
      "}",
      'process.stdout.write("sqlite-secret-ref-only;configured-agent;canonical-profile-source;isolated-live-home\\n");',
    ].join("\n");
    const worker = spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", verifyWorker],
      { cwd: repoRoot, encoding: "utf8", env, timeout: 30_000 },
    );
    expect(worker.status, worker.stderr).toBe(0);
    expect(worker.stdout).toContain(
      "sqlite-secret-ref-only;configured-agent;canonical-profile-source;isolated-live-home",
    );
  }, 45_000);

  it("loads profile ownership from the staged product instead of the trusted harness", async () => {
    const root = tempDirs.make("openclaw-live-stage-auth-source-");
    const agentDir = path.join(root, "src", "agents");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      path.join(agentDir, "auth-profiles.ts"),
      "export async function upsertAuthProfileWithLock(params) { " +
        "return { version: 1, profiles: { [params.profileId]: params.credential } }; }\n" +
        "export async function setAuthProfileOrder(params) { " +
        "return { version: 1, profiles: {}, order: { [params.provider]: params.order } }; }\n",
    );

    await expect(
      hydrateLiveDockerOpenAiAuthProfile({
        stageRoot: root,
        env: {
          OPENCLAW_LIVE_PROVIDERS: "openai",
          OPENAI_API_KEY: "live-openai-fixture", // pragma: allowlist secret
          OPENCLAW_STATE_DIR: path.join(root, "state"),
        },
        agentDir: path.join(root, "state", "agents", "main", "agent"),
      }),
    ).resolves.toBe(true);
  });

  it("hydrates OpenAI when it is selected only by an explicit model reference", async () => {
    const root = tempDirs.make("openclaw-live-stage-auth-model-");
    const stateDir = path.join(root, "state");
    const upsertAuthProfile = vi.fn(async () => ({ version: 1, profiles: {} }));
    const setAuthProfileOrder = vi.fn(async () => ({ version: 1, profiles: {} }));
    const agentDir = path.join(stateDir, "agents", "main", "agent");

    await expect(
      hydrateLiveDockerOpenAiAuthProfile({
        stageRoot: root,
        env: {
          OPENCLAW_LIVE_MODELS: "anthropic/claude-sonnet-4.6, openai/gpt-5.6-luna",
          OPENAI_API_KEY: "live-openai-fixture", // pragma: allowlist secret
          OPENCLAW_STATE_DIR: stateDir,
        },
        agentDir,
        upsertAuthProfile,
        setAuthProfileOrder,
      }),
    ).resolves.toBe(true);
    expect(upsertAuthProfile).toHaveBeenCalledExactlyOnceWith({
      profileId: "openai:api-key",
      credential: {
        type: "api_key",
        provider: "openai",
        keyRef: {
          source: "env",
          provider: "default",
          id: "OPENAI_API_KEY",
        },
      },
      agentDir: resolveCanonicalLiveStagePath(root, agentDir),
      stateDir: resolveCanonicalLiveStagePath(root, stateDir),
    });
    expect(setAuthProfileOrder).toHaveBeenCalledExactlyOnceWith({
      agentDir: resolveCanonicalLiveStagePath(root, agentDir),
      provider: "openai",
      order: ["openai:api-key"],
    });
  });

  it.each(["gpt-5.4", "GPT-5.4", "gpt-5.4-codex", "anthropic/claude-sonnet-4-6,gpt-5.4"] as const)(
    "hydrates canonical bare OpenAI model target %s from the staged provider contract",
    async (model) => {
      const root = tempDirs.make("openclaw-live-stage-auth-bare-model-");
      const stateDir = path.join(root, "state");
      const agentDir = path.join(stateDir, "agents", "main", "agent");
      const openAiPluginDir = path.join(root, "extensions", "openai");
      mkdirSync(openAiPluginDir, { recursive: true });
      writeFileSync(
        path.join(openAiPluginDir, "model-route-contract.ts"),
        readFileSync(path.join(repoRoot, "extensions/openai/model-route-contract.ts"), "utf8"),
      );
      const upsertAuthProfile = vi.fn(async () => ({ version: 1, profiles: {} }));
      const setAuthProfileOrder = vi.fn(async () => ({ version: 1, profiles: {} }));

      await expect(
        hydrateLiveDockerOpenAiAuthProfile({
          stageRoot: root,
          env: {
            OPENCLAW_LIVE_MODELS: model,
            OPENAI_API_KEY: "live-openai-fixture", // pragma: allowlist secret
            OPENCLAW_STATE_DIR: stateDir,
          },
          agentDir,
          upsertAuthProfile,
          setAuthProfileOrder,
        }),
      ).resolves.toBe(true);
      expect(upsertAuthProfile).toHaveBeenCalledExactlyOnceWith({
        profileId: "openai:api-key",
        credential: {
          type: "api_key",
          provider: "openai",
          keyRef: {
            source: "env",
            provider: "default",
            id: "OPENAI_API_KEY",
          },
        },
        agentDir: resolveCanonicalLiveStagePath(root, agentDir),
        stateDir: resolveCanonicalLiveStagePath(root, stateDir),
      });
      expect(setAuthProfileOrder).toHaveBeenCalledExactlyOnceWith({
        agentDir: resolveCanonicalLiveStagePath(root, agentDir),
        provider: "openai",
        order: ["openai:api-key"],
      });
    },
  );

  it.each(["claude-sonnet-4-6", "gemini-2.5-pro", "mistral-large-latest"] as const)(
    "does not hydrate unrelated bare provider model %s",
    async (model) => {
      const root = tempDirs.make("openclaw-live-stage-auth-other-bare-model-");
      const openAiPluginDir = path.join(root, "extensions", "openai");
      mkdirSync(openAiPluginDir, { recursive: true });
      writeFileSync(
        path.join(openAiPluginDir, "model-route-contract.ts"),
        readFileSync(path.join(repoRoot, "extensions/openai/model-route-contract.ts"), "utf8"),
      );
      const upsertAuthProfile = vi.fn(async () => ({ version: 1, profiles: {} }));
      const setAuthProfileOrder = vi.fn(async () => ({ version: 1, profiles: {} }));

      await expect(
        hydrateLiveDockerOpenAiAuthProfile({
          stageRoot: root,
          env: {
            OPENCLAW_LIVE_MODELS: model,
            OPENAI_API_KEY: "live-openai-fixture", // pragma: allowlist secret
            OPENCLAW_STATE_DIR: path.join(root, "state"),
          },
          agentDir: path.join(root, "state", "agents", "main", "agent"),
          upsertAuthProfile,
          setAuthProfileOrder,
        }),
      ).resolves.toBe(false);
      expect(upsertAuthProfile).not.toHaveBeenCalled();
      expect(setAuthProfileOrder).not.toHaveBeenCalled();
    },
  );

  it.each(["modern", "small", "all"])(
    "does not hydrate OpenAI for the broad %s model sweep",
    async (models) => {
      const upsertAuthProfile = vi.fn(async () => ({ version: 1, profiles: {} }));

      await expect(
        hydrateLiveDockerOpenAiAuthProfile({
          stageRoot: "/unused-live-stage",
          env: {
            OPENCLAW_LIVE_MODELS: models,
            OPENAI_API_KEY: "live-openai-fixture", // pragma: allowlist secret
            OPENCLAW_STATE_DIR: "/isolated-live-state",
          },
          upsertAuthProfile,
        }),
      ).resolves.toBe(false);
      expect(upsertAuthProfile).not.toHaveBeenCalled();
    },
  );

  it("does not hydrate profiles for other selected live providers", async () => {
    const upsertAuthProfile = vi.fn(async () => ({ version: 1, profiles: {} }));

    await expect(
      hydrateLiveDockerOpenAiAuthProfile({
        stageRoot: "/unused-live-stage",
        env: { OPENCLAW_LIVE_PROVIDERS: "anthropic, google" },
        upsertAuthProfile,
      }),
    ).resolves.toBe(false);
    expect(upsertAuthProfile).not.toHaveBeenCalled();
  });

  it("preserves existing OpenAI profile auth when no environment key is supplied", async () => {
    const existingProfile = {
      type: "api_key" as const,
      provider: "openai",
      keyRef: {
        source: "env" as const,
        provider: "default",
        id: "EXISTING_OPENAI_API_KEY",
      },
    };
    const upsertAuthProfile = vi.fn(async () => ({
      version: 1,
      profiles: { "openai:existing": existingProfile },
    }));

    await expect(
      hydrateLiveDockerOpenAiAuthProfile({
        stageRoot: "/unused-live-stage",
        env: {
          OPENCLAW_LIVE_PROVIDERS: "openai",
          EXISTING_OPENAI_API_KEY: "existing-live-fixture", // pragma: allowlist secret
          OPENCLAW_STATE_DIR: "/isolated-live-state",
        },
        upsertAuthProfile,
      }),
    ).resolves.toBe(false);
    expect(upsertAuthProfile).not.toHaveBeenCalled();
  });

  it("preserves existing profile auth for an explicit OpenAI model without an env key", async () => {
    const upsertAuthProfile = vi.fn(async () => ({ version: 1, profiles: {} }));

    await expect(
      hydrateLiveDockerOpenAiAuthProfile({
        stageRoot: "/unused-live-stage",
        env: {
          OPENCLAW_LIVE_MODELS: "openai/gpt-5.6-luna",
          OPENCLAW_STATE_DIR: "/isolated-live-state",
        },
        upsertAuthProfile,
      }),
    ).resolves.toBe(false);
    expect(upsertAuthProfile).not.toHaveBeenCalled();
  });

  it("does not replace staged OpenAI profiles for a whitespace-only environment key", async () => {
    const upsertAuthProfile = vi.fn(async () => ({ version: 1, profiles: {} }));

    await expect(
      hydrateLiveDockerOpenAiAuthProfile({
        stageRoot: "/unused-live-stage",
        env: {
          OPENCLAW_LIVE_PROVIDERS: "openai",
          OPENAI_API_KEY: "   ",
          OPENCLAW_STATE_DIR: "/isolated-live-state",
        },
        upsertAuthProfile,
      }),
    ).resolves.toBe(false);
    expect(upsertAuthProfile).not.toHaveBeenCalled();
  });

  it("rejects OpenAI profile hydration outside isolated staged state", async () => {
    const upsertAuthProfile = vi.fn(async () => ({ version: 1, profiles: {} }));

    await expect(
      hydrateLiveDockerOpenAiAuthProfile({
        stageRoot: "/unused-live-stage",
        env: {
          OPENCLAW_LIVE_PROVIDERS: "openai",
          OPENAI_API_KEY: "live-openai-fixture", // pragma: allowlist secret
        },
        upsertAuthProfile,
      }),
    ).rejects.toThrow("The selected OpenAI live provider requires isolated staged state.");
    expect(upsertAuthProfile).not.toHaveBeenCalled();
  });

  it("rejects a state directory outside the disposable source stage before persistence", async () => {
    const root = tempDirs.make("openclaw-live-stage-auth-state-boundary-");
    const outside = tempDirs.make("openclaw-live-stage-auth-state-outside-");
    const upsertAuthProfile = vi.fn(async () => ({ version: 1, profiles: {} }));
    const setAuthProfileOrder = vi.fn(async () => ({ version: 1, profiles: {} }));

    await expect(
      hydrateLiveDockerOpenAiAuthProfile({
        stageRoot: root,
        env: {
          OPENCLAW_LIVE_PROVIDERS: "openai",
          OPENAI_API_KEY: "live-openai-fixture", // pragma: allowlist secret
          OPENCLAW_STATE_DIR: outside,
        },
        agentDir: path.join(outside, "agents", "main", "agent"),
        upsertAuthProfile,
        setAuthProfileOrder,
      }),
    ).rejects.toThrow(
      "The selected OpenAI live provider requires its state directory to remain inside the disposable staged source root.",
    );
    expect(upsertAuthProfile).not.toHaveBeenCalled();
    expect(setAuthProfileOrder).not.toHaveBeenCalled();
  });

  it("rejects a symlinked state directory that escapes the disposable source stage", async () => {
    const root = tempDirs.make("openclaw-live-stage-auth-state-symlink-");
    const outside = tempDirs.make("openclaw-live-stage-auth-state-symlink-outside-");
    const stateDir = path.join(root, "state");
    symlinkSync(outside, stateDir, process.platform === "win32" ? "junction" : "dir");
    const upsertAuthProfile = vi.fn(async () => ({ version: 1, profiles: {} }));
    const setAuthProfileOrder = vi.fn(async () => ({ version: 1, profiles: {} }));

    await expect(
      hydrateLiveDockerOpenAiAuthProfile({
        stageRoot: root,
        env: {
          OPENCLAW_LIVE_PROVIDERS: "openai",
          OPENAI_API_KEY: "live-openai-fixture", // pragma: allowlist secret
          OPENCLAW_STATE_DIR: stateDir,
        },
        agentDir: path.join(stateDir, "agents", "main", "agent"),
        upsertAuthProfile,
        setAuthProfileOrder,
      }),
    ).rejects.toThrow(
      "The selected OpenAI live provider requires its state directory to remain inside the disposable staged source root.",
    );
    expect(upsertAuthProfile).not.toHaveBeenCalled();
    expect(setAuthProfileOrder).not.toHaveBeenCalled();
  });

  it("passes canonical in-stage symlink paths to both authentication writes", async () => {
    const root = tempDirs.make("openclaw-live-stage-auth-canonical-symlink-");
    const canonicalStateDir = path.join(root, "canonical-state");
    mkdirSync(canonicalStateDir, { recursive: true });
    const stateDir = path.join(root, "state-link");
    symlinkSync(canonicalStateDir, stateDir, process.platform === "win32" ? "junction" : "dir");
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const expectedStateDir = realpathSync.native(canonicalStateDir);
    const expectedAgentDir = path.join(expectedStateDir, "agents", "main", "agent");
    const upsertAuthProfile = vi.fn(async () => ({ version: 1, profiles: {} }));
    const setAuthProfileOrder = vi.fn(async () => ({ version: 1, profiles: {} }));

    await expect(
      hydrateLiveDockerOpenAiAuthProfile({
        stageRoot: root,
        env: {
          OPENCLAW_LIVE_PROVIDERS: "openai",
          OPENAI_API_KEY: "live-openai-fixture", // pragma: allowlist secret
          OPENCLAW_STATE_DIR: stateDir,
        },
        agentDir,
        upsertAuthProfile,
        setAuthProfileOrder,
      }),
    ).resolves.toBe(true);
    expect(upsertAuthProfile).toHaveBeenCalledExactlyOnceWith({
      profileId: "openai:api-key",
      credential: {
        type: "api_key",
        provider: "openai",
        keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
      },
      agentDir: expectedAgentDir,
      stateDir: expectedStateDir,
    });
    expect(setAuthProfileOrder).toHaveBeenCalledExactlyOnceWith({
      agentDir: expectedAgentDir,
      provider: "openai",
      order: ["openai:api-key"],
    });
  });

  it("rejects symlink-and-parent state escapes before creating outside SQLite state", async () => {
    const root = tempDirs.make("openclaw-live-stage-auth-state-symlink-parent-");
    const outside = tempDirs.make("openclaw-live-stage-auth-state-parent-outside-");
    const outsideLinkTarget = path.join(outside, "linked");
    mkdirSync(outsideLinkTarget, { recursive: true });
    const stateLink = path.join(root, "state-link");
    symlinkSync(outsideLinkTarget, stateLink, process.platform === "win32" ? "junction" : "dir");
    const stateDir = `${stateLink}${path.sep}..${path.sep}victim`;
    const upsertAuthProfile = vi.fn(async () => ({ version: 1, profiles: {} }));
    const setAuthProfileOrder = vi.fn(async () => ({ version: 1, profiles: {} }));

    await expect(
      hydrateLiveDockerOpenAiAuthProfile({
        stageRoot: root,
        env: {
          OPENCLAW_LIVE_PROVIDERS: "openai",
          OPENAI_API_KEY: "live-openai-fixture", // pragma: allowlist secret
          OPENCLAW_STATE_DIR: stateDir,
        },
        agentDir: path.join(root, "agent"),
        upsertAuthProfile,
        setAuthProfileOrder,
      }),
    ).rejects.toThrow(
      "The selected OpenAI live provider requires its state directory to remain inside the disposable staged source root.",
    );
    expect(existsSync(path.join(outside, "victim"))).toBe(false);
    expect(upsertAuthProfile).not.toHaveBeenCalled();
    expect(setAuthProfileOrder).not.toHaveBeenCalled();
  });

  it.each(["/", "\\"] as const)(
    "rejects raw parent traversal with the %s path separator",
    async (separator) => {
      const root = tempDirs.make("openclaw-live-stage-auth-state-parent-separator-");
      const upsertAuthProfile = vi.fn(async () => ({ version: 1, profiles: {} }));
      const setAuthProfileOrder = vi.fn(async () => ({ version: 1, profiles: {} }));

      await expect(
        hydrateLiveDockerOpenAiAuthProfile({
          stageRoot: root,
          env: {
            OPENCLAW_LIVE_PROVIDERS: "openai",
            OPENAI_API_KEY: "live-openai-fixture", // pragma: allowlist secret
            OPENCLAW_STATE_DIR: `${path.join(root, "state")}${separator}..${separator}victim`,
          },
          agentDir: path.join(root, "agent"),
          upsertAuthProfile,
          setAuthProfileOrder,
        }),
      ).rejects.toThrow(
        "The selected OpenAI live provider requires its state directory to remain inside the disposable staged source root.",
      );
      expect(upsertAuthProfile).not.toHaveBeenCalled();
      expect(setAuthProfileOrder).not.toHaveBeenCalled();
    },
  );

  it("rejects an agent directory outside the disposable source stage before persistence", async () => {
    const root = tempDirs.make("openclaw-live-stage-auth-agent-boundary-");
    const outside = tempDirs.make("openclaw-live-stage-auth-agent-outside-");
    const upsertAuthProfile = vi.fn(async () => ({ version: 1, profiles: {} }));
    const setAuthProfileOrder = vi.fn(async () => ({ version: 1, profiles: {} }));

    await expect(
      hydrateLiveDockerOpenAiAuthProfile({
        stageRoot: root,
        env: {
          OPENCLAW_LIVE_PROVIDERS: "openai",
          OPENAI_API_KEY: "live-openai-fixture", // pragma: allowlist secret
          OPENCLAW_STATE_DIR: path.join(root, "state"),
        },
        agentDir: path.join(outside, "agents", "main", "agent"),
        upsertAuthProfile,
        setAuthProfileOrder,
      }),
    ).rejects.toThrow(
      "The selected OpenAI live provider requires its agent directory to remain inside the disposable staged source root.",
    );
    expect(upsertAuthProfile).not.toHaveBeenCalled();
    expect(setAuthProfileOrder).not.toHaveBeenCalled();
  });

  it("rejects a symlinked agent directory that escapes the disposable source stage", async () => {
    const root = tempDirs.make("openclaw-live-stage-auth-agent-symlink-");
    const outside = tempDirs.make("openclaw-live-stage-auth-agent-symlink-outside-");
    const stateDir = path.join(root, "state");
    const agentsDir = path.join(stateDir, "agents");
    mkdirSync(agentsDir, { recursive: true });
    symlinkSync(
      outside,
      path.join(agentsDir, "escaped"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const upsertAuthProfile = vi.fn(async () => ({ version: 1, profiles: {} }));
    const setAuthProfileOrder = vi.fn(async () => ({ version: 1, profiles: {} }));

    await expect(
      hydrateLiveDockerOpenAiAuthProfile({
        stageRoot: root,
        env: {
          OPENCLAW_LIVE_PROVIDERS: "openai",
          OPENAI_API_KEY: "live-openai-fixture", // pragma: allowlist secret
          OPENCLAW_STATE_DIR: stateDir,
        },
        agentDir: path.join(agentsDir, "escaped", "main", "agent"),
        upsertAuthProfile,
        setAuthProfileOrder,
      }),
    ).rejects.toThrow(
      "The selected OpenAI live provider requires its agent directory to remain inside the disposable staged source root.",
    );
    expect(upsertAuthProfile).not.toHaveBeenCalled();
    expect(setAuthProfileOrder).not.toHaveBeenCalled();
  });

  it("rejects symlink-and-parent agent escapes before creating outside SQLite state", async () => {
    const root = tempDirs.make("openclaw-live-stage-auth-agent-symlink-parent-");
    const outside = tempDirs.make("openclaw-live-stage-auth-agent-parent-outside-");
    const outsideLinkTarget = path.join(outside, "linked");
    mkdirSync(outsideLinkTarget, { recursive: true });
    const stateDir = path.join(root, "state");
    const agentsDir = path.join(stateDir, "agents");
    mkdirSync(agentsDir, { recursive: true });
    const agentLink = path.join(agentsDir, "escaped");
    symlinkSync(outsideLinkTarget, agentLink, process.platform === "win32" ? "junction" : "dir");
    const agentDir = `${agentLink}${path.sep}..${path.sep}victim${path.sep}agent`;
    const upsertAuthProfile = vi.fn(async () => ({ version: 1, profiles: {} }));
    const setAuthProfileOrder = vi.fn(async () => ({ version: 1, profiles: {} }));

    await expect(
      hydrateLiveDockerOpenAiAuthProfile({
        stageRoot: root,
        env: {
          OPENCLAW_LIVE_PROVIDERS: "openai",
          OPENAI_API_KEY: "live-openai-fixture", // pragma: allowlist secret
          OPENCLAW_STATE_DIR: stateDir,
        },
        agentDir,
        upsertAuthProfile,
        setAuthProfileOrder,
      }),
    ).rejects.toThrow(
      "The selected OpenAI live provider requires its agent directory to remain inside the disposable staged source root.",
    );
    expect(existsSync(path.join(outside, "victim"))).toBe(false);
    expect(upsertAuthProfile).not.toHaveBeenCalled();
    expect(setAuthProfileOrder).not.toHaveBeenCalled();
  });

  it("rejects an inherited configured agent directory outside the disposable source stage", async () => {
    const root = tempDirs.make("openclaw-live-stage-auth-inherited-agent-");
    const outside = tempDirs.make("openclaw-live-stage-auth-inherited-outside-");
    const configDir = path.join(root, "src", "config");
    const agentsDir = path.join(root, "src", "agents");
    mkdirSync(configDir, { recursive: true });
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      path.join(configDir, "config.ts"),
      "export function getRuntimeConfig() { return {}; }\n",
    );
    writeFileSync(
      path.join(agentsDir, "agent-scope-config.ts"),
      "export function resolveDefaultAgentDir(_config, env) { return env.OPENCLAW_AGENT_DIR; }\n",
    );
    const upsertAuthProfile = vi.fn(async () => ({ version: 1, profiles: {} }));
    const setAuthProfileOrder = vi.fn(async () => ({ version: 1, profiles: {} }));

    await expect(
      hydrateLiveDockerOpenAiAuthProfile({
        stageRoot: root,
        env: {
          OPENCLAW_LIVE_PROVIDERS: "openai",
          OPENAI_API_KEY: "live-openai-fixture", // pragma: allowlist secret
          OPENCLAW_STATE_DIR: path.join(root, "state"),
          OPENCLAW_AGENT_DIR: path.join(outside, "agents", "main", "agent"),
        },
        upsertAuthProfile,
        setAuthProfileOrder,
      }),
    ).rejects.toThrow(
      "The selected OpenAI live provider requires its agent directory to remain inside the disposable staged source root.",
    );
    expect(upsertAuthProfile).not.toHaveBeenCalled();
    expect(setAuthProfileOrder).not.toHaveBeenCalled();
  });

  it("fails closed when the canonical OpenAI profile cannot be persisted", async () => {
    const root = tempDirs.make("openclaw-live-stage-auth-upsert-failure-");
    const stateDir = path.join(root, "state");
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const upsertAuthProfile = vi.fn(async () => null);

    await expect(
      hydrateLiveDockerOpenAiAuthProfile({
        stageRoot: root,
        env: {
          OPENCLAW_LIVE_PROVIDERS: "openai",
          OPENAI_API_KEY: "live-openai-fixture", // pragma: allowlist secret
          OPENCLAW_STATE_DIR: stateDir,
        },
        agentDir,
        upsertAuthProfile,
      }),
    ).rejects.toThrow("Failed to persist the selected OpenAI live authentication profile.");
    expect(upsertAuthProfile).toHaveBeenCalledOnce();
  });

  it("fails closed when the canonical OpenAI profile order cannot be activated", async () => {
    const root = tempDirs.make("openclaw-live-stage-auth-order-failure-");
    const stateDir = path.join(root, "state");
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const upsertAuthProfile = vi.fn(async () => ({ version: 1, profiles: {} }));
    const setAuthProfileOrder = vi.fn(async () => null);

    await expect(
      hydrateLiveDockerOpenAiAuthProfile({
        stageRoot: root,
        env: {
          OPENCLAW_LIVE_PROVIDERS: "openai",
          OPENAI_API_KEY: "live-openai-fixture", // pragma: allowlist secret
          OPENCLAW_STATE_DIR: stateDir,
        },
        agentDir,
        upsertAuthProfile,
        setAuthProfileOrder,
      }),
    ).rejects.toThrow("Failed to activate the selected OpenAI live authentication profile.");
    expect(upsertAuthProfile).toHaveBeenCalledOnce();
    expect(setAuthProfileOrder).toHaveBeenCalledOnce();
  });

  it("keeps repo-local generated artifacts out of the source copy", () => {
    const script = readFileSync(stageScriptPath, "utf8");

    expect(script).toContain("--exclude=.artifacts");
    expect(script).toContain('node "$scripts_dir/live-docker-stage-private-sdk-exports.mjs"');
  });

  it("adds private SDK source exports only to the disposable source stage", () => {
    const root = tempDirs.make("openclaw-live-stage-sdk-");
    mkdirSync(path.join(root, "scripts", "lib"), { recursive: true });
    mkdirSync(path.join(root, "src", "plugin-sdk"), { recursive: true });
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ exports: { "./plugin-sdk/core": "./dist/plugin-sdk/core.js" } }),
    );
    writeFileSync(
      path.join(root, "scripts", "lib", "plugin-sdk-private-local-only-subpaths.json"),
      JSON.stringify(["keyed-async-queue"]),
    );
    writeFileSync(path.join(root, "src", "plugin-sdk", "keyed-async-queue.ts"), "export {};\n");

    addStagedPrivatePluginSdkExports(root);

    const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    expect(packageJson.exports).toEqual({
      "./plugin-sdk/core": "./dist/plugin-sdk/core.js",
      "./plugin-sdk/keyed-async-queue": {
        types: "./src/plugin-sdk/keyed-async-queue.ts",
        default: "./src/plugin-sdk/keyed-async-queue.ts",
      },
    });
  });

  it("keeps host-only generated registry state out of the container copy", () => {
    const script = readFileSync(stageScriptPath, "utf8");

    expect(script).toContain("--exclude=workspace");
    expect(script).toContain("--exclude=sandboxes");
    expect(script).toContain("--exclude=plugins/installs.json");
    expect(script).toContain("--exclude=plugins/installs.json.migrated");
    expect(script).toContain("DELETE FROM installed_plugin_index");
    expect(script).toContain("PRAGMA secure_delete = ON");
    expect(script).toContain("VACUUM");
    expect(script).toContain("host-absolute paths");
  });
});

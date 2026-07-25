// Materializes selected live-provider credentials in disposable Docker state.
import { realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { AuthProfileCredential, AuthProfileStore } from "../src/agents/auth-profiles.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";

type UpsertLiveAuthProfile = (params: {
  profileId: string;
  credential: AuthProfileCredential;
  agentDir: string;
  stateDir: string;
}) => Promise<AuthProfileStore | null>;

type SetLiveAuthProfileOrder = (params: {
  agentDir: string;
  provider: string;
  order: string[];
}) => Promise<AuthProfileStore | null>;

function resolveLiveDockerPathThroughExistingAncestor(value: string): string {
  let ancestor = path.resolve(value);
  const unresolvedSegments: string[] = [];
  while (true) {
    try {
      return path.join(realpathSync.native(ancestor), ...unresolvedSegments);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      const parent = path.dirname(ancestor);
      if (parent === ancestor) {
        throw error;
      }
      unresolvedSegments.unshift(path.basename(ancestor));
      ancestor = parent;
    }
  }
}

function resolveLiveDockerPathInsideStage(params: {
  stageRoot: string;
  candidate: string;
  label: "state" | "agent";
}): string {
  // Normalizing `link/../target` first hides a symlink escape from realpath.
  if (params.candidate.split(/[\\/]/).includes("..")) {
    throw new Error(
      `The selected OpenAI live provider requires its ${params.label} directory to remain inside the disposable staged source root.`,
    );
  }
  const stageRoot = realpathSync.native(path.resolve(params.stageRoot));
  const candidate = resolveLiveDockerPathThroughExistingAncestor(params.candidate);
  const relative = path.relative(stageRoot, candidate);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(
      `The selected OpenAI live provider requires its ${params.label} directory to remain inside the disposable staged source root.`,
    );
  }
  return candidate;
}

/** Hydrate the canonical OpenAI profile without persisting its environment key. */
export async function hydrateLiveDockerOpenAiAuthProfile(params: {
  stageRoot: string;
  env?: NodeJS.ProcessEnv;
  agentDir?: string;
  upsertAuthProfile?: UpsertLiveAuthProfile;
  setAuthProfileOrder?: SetLiveAuthProfileOrder;
}): Promise<boolean> {
  const env = params.env ?? process.env;
  const openAiKeyEnvId = env.OPENCLAW_LIVE_OPENAI_KEY?.trim()
    ? "OPENCLAW_LIVE_OPENAI_KEY"
    : env.OPENAI_API_KEY?.trim()
      ? "OPENAI_API_KEY"
      : undefined;
  if (!openAiKeyEnvId) {
    // Existing staged OAuth/API profiles remain authoritative without a supplied env key.
    return false;
  }
  const selectedProviders = (env.OPENCLAW_LIVE_PROVIDERS ?? "")
    .split(",")
    .map((provider) => provider.trim().toLowerCase())
    .filter(Boolean);
  const selectedOpenAi = selectedProviders.includes("openai");
  const selectedModels = (env.OPENCLAW_LIVE_MODELS ?? "")
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean);
  // Match explicit provider refs first; bare model ownership belongs to the staged plugin.
  let selectedOpenAiModel = selectedModels.some((model) => {
    const slash = model.indexOf("/");
    return (
      slash > 0 &&
      model.slice(0, slash).trim().toLowerCase() === "openai" &&
      model.slice(slash + 1).trim().length > 0
    );
  });
  if (!selectedOpenAi && !selectedOpenAiModel && selectedProviders.length === 0) {
    const bareModels = selectedModels.filter(
      (model) => !model.includes("/") && model !== "modern" && model !== "small" && model !== "all",
    );
    if (bareModels.length > 0) {
      const { OPENAI_PROVIDER_MODERN_MODEL_IDS, normalizeOpenAIModelRouteId } = (await import(
        pathToFileURL(path.join(params.stageRoot, "extensions/openai/model-route-contract.ts")).href
      )) as typeof import("../extensions/openai/model-route-contract.js");
      const knownOpenAiModels = new Set<string>(
        OPENAI_PROVIDER_MODERN_MODEL_IDS.map((modelId) => modelId.toLowerCase()),
      );
      selectedOpenAiModel = bareModels.some((model) =>
        knownOpenAiModels.has(normalizeOpenAIModelRouteId(model).toLowerCase()),
      );
    }
  }
  if (!selectedOpenAi && !selectedOpenAiModel) {
    return false;
  }
  const selectedStateDir = env.OPENCLAW_STATE_DIR?.trim();
  if (!selectedStateDir) {
    throw new Error("The selected OpenAI live provider requires isolated staged state.");
  }
  // Pass canonical paths to SQLite so validation and writes cannot disagree.
  const stateDir = resolveLiveDockerPathInsideStage({
    stageRoot: params.stageRoot,
    candidate: selectedStateDir,
    label: "state",
  });

  let config: OpenClawConfig | undefined;
  let agentDir = params.agentDir;
  if (!agentDir) {
    const [{ getRuntimeConfig }, { resolveDefaultAgentDir }] = await Promise.all([
      import(pathToFileURL(path.join(params.stageRoot, "src/config/config.ts")).href) as Promise<
        typeof import("../src/config/config.js")
      >,
      import(
        pathToFileURL(path.join(params.stageRoot, "src/agents/agent-scope-config.ts")).href
      ) as Promise<typeof import("../src/agents/agent-scope-config.js")>,
    ]);
    config = getRuntimeConfig();
    agentDir = resolveDefaultAgentDir(config, env);
  }
  agentDir = resolveLiveDockerPathInsideStage({
    stageRoot: params.stageRoot,
    candidate: agentDir,
    label: "agent",
  });

  // Import the staged product so profile ownership matches the selected image/ref.
  let stagedAuthProfiles: typeof import("../src/agents/auth-profiles.js") | undefined;
  const loadStagedAuthProfiles = async () =>
    (stagedAuthProfiles ??= (await import(
      pathToFileURL(path.join(params.stageRoot, "src/agents/auth-profiles.ts")).href
    )) as typeof import("../src/agents/auth-profiles.js"));
  const upsertAuthProfile =
    params.upsertAuthProfile ?? (await loadStagedAuthProfiles()).upsertAuthProfileWithLock;
  const store = await upsertAuthProfile({
    profileId: "openai:api-key",
    credential: {
      type: "api_key",
      provider: "openai",
      keyRef: {
        source: "env",
        provider: "default",
        id: openAiKeyEnvId,
      },
    },
    agentDir,
    stateDir,
  });
  if (!store) {
    throw new Error("Failed to persist the selected OpenAI live authentication profile.");
  }

  // Stored order owns auth selection; a profile row alone loses to authored config order.
  const configuredProfileIds = Object.entries(config?.auth?.profiles ?? {})
    .filter(([, profile]) => profile.provider.trim().toLowerCase() === "openai")
    .map(([profileId]) => profileId);
  const previousOrder = store.order?.openai ?? config?.auth?.order?.openai ?? configuredProfileIds;
  const order = [
    "openai:api-key",
    ...previousOrder.filter((profileId) => profileId !== "openai:api-key"),
  ];
  const setAuthProfileOrder =
    params.setAuthProfileOrder ?? (await loadStagedAuthProfiles()).setAuthProfileOrder;
  const orderedStore = await setAuthProfileOrder({
    agentDir,
    provider: "openai",
    order,
  });
  if (!orderedStore) {
    throw new Error("Failed to activate the selected OpenAI live authentication profile.");
  }
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const stageRoot = process.argv[2];
  if (!stageRoot) {
    throw new Error("The live Docker authentication profile requires a staged source root.");
  }
  await hydrateLiveDockerOpenAiAuthProfile({ stageRoot });
}

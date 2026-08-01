export const WORKSPACE_TEMPLATE_PACK_PATHS: readonly string[];
export const DIST_RUNTIME_ARTIFACT_BASE_PATHS: readonly string[];
export const DIST_RUNTIME_ARTIFACT_WORKSPACE_PACKAGE_NAMES: readonly string[];
export function createWorkspaceBootstrapSmokeEnv(
  env: NodeJS.ProcessEnv,
  homeDir: string,
  overrides?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv;
export function runInstalledWorkspaceBootstrapSmoke(params: {
  packageRoot: string;
  nodeArgs?: string[];
  envOverrides?: NodeJS.ProcessEnv;
}): void;
export function collectDistRuntimeArtifactPaths(rootDir: string): string[];
export function resolveDistRuntimeArtifactWorkspaceImport(params: {
  artifactRoot: string;
  specifier: string;
  workspacePackageNames: ReadonlySet<string>;
}): string | undefined;
export function buildAndSmokeDistRuntimeArtifact(params: {
  rootDir: string;
  archivePath: string;
  compressor?: string;
}): Promise<{ archivePath: string; artifactPaths: string[] }>;

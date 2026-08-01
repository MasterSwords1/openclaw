import { registerHooks } from "node:module";
import { resolveDistRuntimeArtifactWorkspaceImport } from "./workspace-bootstrap-smoke.mjs";

const artifactRoot = process.env.OPENCLAW_ARTIFACT_ROOT;
if (!artifactRoot) {
  throw new Error("OPENCLAW_ARTIFACT_ROOT is required for the runtime artifact smoke");
}
const workspacePackagesJson = process.env.OPENCLAW_ARTIFACT_WORKSPACE_PACKAGES;
if (!workspacePackagesJson) {
  throw new Error(
    "OPENCLAW_ARTIFACT_WORKSPACE_PACKAGES is required for the runtime artifact smoke",
  );
}
const workspacePackageNames = new Set(JSON.parse(workspacePackagesJson));

registerHooks({
  resolve(specifier, context, nextResolve) {
    const url = resolveDistRuntimeArtifactWorkspaceImport({
      artifactRoot,
      specifier,
      workspacePackageNames,
    });
    if (url) {
      return { shortCircuit: true, url };
    }
    return nextResolve(specifier, context);
  },
});

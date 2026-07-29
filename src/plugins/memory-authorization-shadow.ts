import { createSubsystemLogger } from "../logging/subsystem.js";
import { MEMORY_AUTHORIZATION_CONTRACT_VERSION } from "../memory-host-sdk/host/authorization.js";
import { inspectMemoryAuthorizationRuntime } from "./memory-authorization-runtime.js";
import type { MemoryPluginRuntime } from "./memory-state.js";

const log = createSubsystemLogger("plugins/memory-authorization");
const shadowedRuntimes = new WeakSet<object>();

type MemoryAuthorizationShadowMetadata = Readonly<{
  event: "memory-authorization-backend-surface";
  mode: "shadow";
  contractVersion: 1;
  capabilityDeclaration: "missing" | "malformed" | "partial" | "complete";
  declaredCapabilityCount: number;
  requiredCapabilityCount: number;
  implementedMethodCount: number;
  requiredMethodCount: number;
  surfaceComplete: boolean;
  reasonCode: "surface-complete" | "backend-nonconforming";
}>;

type MemoryAuthorizationShadowEmitter = (metadata: MemoryAuthorizationShadowMetadata) => void;

function emitToSubsystemLog(metadata: MemoryAuthorizationShadowMetadata): void {
  log.debug("memory authorization backend surface evaluated", metadata);
}

/**
 * Emits one content-free, bounded surface inspection per selected runtime object.
 * Agent, session, query, prompt, content, path, and principal fields cannot enter this shape.
 */
export function emitMemoryAuthorizationShadowSurfaceInspection(
  runtime: MemoryPluginRuntime,
  emit: MemoryAuthorizationShadowEmitter = emitToSubsystemLog,
): MemoryAuthorizationShadowMetadata | undefined {
  if (shadowedRuntimes.has(runtime)) {
    return undefined;
  }
  shadowedRuntimes.add(runtime);
  const inspection = inspectMemoryAuthorizationRuntime(runtime);
  const metadata = Object.freeze({
    event: "memory-authorization-backend-surface" as const,
    mode: "shadow" as const,
    contractVersion: MEMORY_AUTHORIZATION_CONTRACT_VERSION,
    capabilityDeclaration: inspection.capabilityDeclaration,
    declaredCapabilityCount: inspection.declaredCapabilityCount,
    requiredCapabilityCount: inspection.requiredCapabilityCount,
    implementedMethodCount: inspection.implementedMethodCount,
    requiredMethodCount: inspection.requiredMethodCount,
    surfaceComplete: inspection.surfaceComplete,
    reasonCode: inspection.reasonCode,
  });
  emit(metadata);
  return metadata;
}

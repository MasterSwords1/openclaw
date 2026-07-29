import {
  MEMORY_AUTHORIZATION_CAPABILITY_NAMES,
  MEMORY_AUTHORIZATION_CONTRACT_VERSION,
  hasCompleteMemoryAuthorizationCapabilities,
  isMemoryAuthorizationCapabilities,
  type AuthorizedMemoryRuntime,
  type MemoryAuthorizationCapabilityName,
} from "../memory-host-sdk/host/authorization.js";

const AUTHORIZED_MEMORY_RUNTIME_METHOD_NAMES = [
  "authorize",
  "searchAuthorized",
  "readAuthorized",
  "writeAuthorized",
  "importAuthorized",
  "syncAuthorized",
  "exportAuthorized",
  "statusAuthorized",
] as const satisfies readonly (keyof AuthorizedMemoryRuntime)[];

type AuthorizedMemoryRuntimeMethodName = (typeof AUTHORIZED_MEMORY_RUNTIME_METHOD_NAMES)[number];

type MemoryAuthorizationRuntimeInspection = Readonly<{
  version: 1;
  capabilityDeclaration: "missing" | "malformed" | "partial" | "complete";
  declaredCapabilityCount: number;
  requiredCapabilityCount: number;
  implementedMethodCount: number;
  requiredMethodCount: number;
  missingCapabilities: readonly MemoryAuthorizationCapabilityName[];
  missingMethods: readonly AuthorizedMemoryRuntimeMethodName[];
  surfaceComplete: boolean;
  reasonCode: "surface-complete" | "backend-nonconforming";
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Inspect only contract shape. This result cannot admit an enforced backend; Phase 1B must bind
 * the runtime implementation to host-verified conformance evidence before enabling it.
 */
export function inspectMemoryAuthorizationRuntime(
  runtime: unknown,
): MemoryAuthorizationRuntimeInspection {
  const runtimeRecord = isRecord(runtime) ? runtime : {};
  const declaration = runtimeRecord.authorization;
  const declarationRecord = isRecord(declaration) ? declaration : {};
  const declaredCapabilityCount = MEMORY_AUTHORIZATION_CAPABILITY_NAMES.filter(
    (name) => declarationRecord[name] === true,
  ).length;
  const missingCapabilities = MEMORY_AUTHORIZATION_CAPABILITY_NAMES.filter(
    (name) => declarationRecord[name] !== true,
  );
  const missingMethods = AUTHORIZED_MEMORY_RUNTIME_METHOD_NAMES.filter(
    (name) => typeof runtimeRecord[name] !== "function",
  );
  const capabilityDeclaration =
    declaration === undefined
      ? "missing"
      : !isMemoryAuthorizationCapabilities(declaration)
        ? "malformed"
        : hasCompleteMemoryAuthorizationCapabilities(declaration)
          ? "complete"
          : "partial";
  const surfaceComplete = capabilityDeclaration === "complete" && missingMethods.length === 0;

  return Object.freeze({
    version: MEMORY_AUTHORIZATION_CONTRACT_VERSION,
    capabilityDeclaration,
    declaredCapabilityCount,
    requiredCapabilityCount: MEMORY_AUTHORIZATION_CAPABILITY_NAMES.length,
    implementedMethodCount: AUTHORIZED_MEMORY_RUNTIME_METHOD_NAMES.length - missingMethods.length,
    requiredMethodCount: AUTHORIZED_MEMORY_RUNTIME_METHOD_NAMES.length,
    missingCapabilities: Object.freeze([...missingCapabilities]),
    missingMethods: Object.freeze([...missingMethods]),
    surfaceComplete,
    reasonCode: surfaceComplete ? "surface-complete" : "backend-nonconforming",
  });
}

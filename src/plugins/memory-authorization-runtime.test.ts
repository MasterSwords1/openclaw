import { describe, expect, it, vi } from "vitest";
import {
  COMPLETE_MEMORY_AUTHORIZATION_CAPABILITIES,
  LEGACY_MEMORY_AUTHORIZATION_CAPABILITIES,
  MEMORY_AUTHORIZATION_CAPABILITY_NAMES,
} from "../memory-host-sdk/host/authorization.js";
import { inspectMemoryAuthorizationRuntime } from "./memory-authorization-runtime.js";
import { emitMemoryAuthorizationShadowSurfaceInspection } from "./memory-authorization-shadow.js";
import type { MemoryPluginRuntime } from "./memory-state.js";

const AUTHORIZED_MEMORY_RUNTIME_METHOD_NAMES = [
  "authorize",
  "searchAuthorized",
  "readAuthorized",
  "writeAuthorized",
  "importAuthorized",
  "syncAuthorized",
  "exportAuthorized",
  "statusAuthorized",
] as const;

type MemoryAuthorizationShadowMetadata = NonNullable<
  ReturnType<typeof emitMemoryAuthorizationShadowSurfaceInspection>
>;

function createLegacyRuntime(): MemoryPluginRuntime {
  return {
    authorization: LEGACY_MEMORY_AUTHORIZATION_CAPABILITIES,
    async getMemorySearchManager() {
      return { manager: null, error: "missing" };
    },
    resolveMemoryBackendConfig() {
      return { backend: "builtin" };
    },
  };
}

function createCompleteRuntime(): MemoryPluginRuntime {
  const notCalled = async (): Promise<never> => {
    throw new Error("not called");
  };
  return {
    ...createLegacyRuntime(),
    authorization: COMPLETE_MEMORY_AUTHORIZATION_CAPABILITIES,
    authorize: notCalled,
    searchAuthorized: notCalled,
    readAuthorized: notCalled,
    writeAuthorized: notCalled,
    importAuthorized: notCalled,
    syncAuthorized: notCalled,
    exportAuthorized: notCalled,
    statusAuthorized: notCalled,
  };
}

describe("authorized memory runtime surface inspection", () => {
  it("flags a context-free selected backend as structurally nonconforming", () => {
    const contextFreeRuntime = {
      async getMemorySearchManager() {
        return { manager: null };
      },
      resolveMemoryBackendConfig() {
        return { backend: "builtin" as const };
      },
    };

    const inspection = inspectMemoryAuthorizationRuntime(contextFreeRuntime);
    expect(inspection).toMatchObject({
      capabilityDeclaration: "missing",
      declaredCapabilityCount: 0,
      implementedMethodCount: 0,
      surfaceComplete: false,
      reasonCode: "backend-nonconforming",
    });
    expect(inspection.missingCapabilities).toEqual(MEMORY_AUTHORIZATION_CAPABILITY_NAMES);
    expect(inspection.missingMethods).toEqual(AUTHORIZED_MEMORY_RUNTIME_METHOD_NAMES);
  });

  it("distinguishes malformed, partial, and structurally complete declarations", () => {
    expect(inspectMemoryAuthorizationRuntime({ authorization: { version: 2 } })).toMatchObject({
      capabilityDeclaration: "malformed",
      surfaceComplete: false,
    });
    expect(inspectMemoryAuthorizationRuntime(createLegacyRuntime())).toMatchObject({
      capabilityDeclaration: "partial",
      declaredCapabilityCount: 0,
      surfaceComplete: false,
    });
    expect(
      inspectMemoryAuthorizationRuntime({
        ...createLegacyRuntime(),
        authorization: COMPLETE_MEMORY_AUTHORIZATION_CAPABILITIES,
      }),
    ).toMatchObject({
      capabilityDeclaration: "complete",
      implementedMethodCount: 0,
      surfaceComplete: false,
    });

    const completeRuntime = createCompleteRuntime();
    const complete = inspectMemoryAuthorizationRuntime(completeRuntime);
    expect(complete).toMatchObject({
      capabilityDeclaration: "complete",
      declaredCapabilityCount: MEMORY_AUTHORIZATION_CAPABILITY_NAMES.length,
      implementedMethodCount: AUTHORIZED_MEMORY_RUNTIME_METHOD_NAMES.length,
      surfaceComplete: true,
      reasonCode: "surface-complete",
    });
    expect(complete.missingCapabilities).toEqual([]);
    expect(complete.missingMethods).toEqual([]);
    expect(Object.isFrozen(complete)).toBe(true);
    expect(Object.isFrozen(complete.missingMethods)).toBe(true);
  });
});

describe("memory authorization shadow surface inspection", () => {
  it("emits one bounded, content-free decision for a selected runtime", () => {
    const runtime = {
      ...createLegacyRuntime(),
      query: "private query sentinel",
      prompt: "private prompt sentinel",
      snippet: "private snippet sentinel",
      content: "private content sentinel",
      principalId: "principal-secret-sentinel",
    };
    const emitted: MemoryAuthorizationShadowMetadata[] = [];

    const first = emitMemoryAuthorizationShadowSurfaceInspection(runtime, (metadata) => {
      emitted.push(metadata);
    });
    const secondEmitter = vi.fn();
    const second = emitMemoryAuthorizationShadowSurfaceInspection(runtime, secondEmitter);

    expect(first).toEqual({
      event: "memory-authorization-backend-surface",
      mode: "shadow",
      contractVersion: 1,
      capabilityDeclaration: "partial",
      declaredCapabilityCount: 0,
      requiredCapabilityCount: MEMORY_AUTHORIZATION_CAPABILITY_NAMES.length,
      implementedMethodCount: 0,
      requiredMethodCount: AUTHORIZED_MEMORY_RUNTIME_METHOD_NAMES.length,
      surfaceComplete: false,
      reasonCode: "backend-nonconforming",
    });
    expect(Object.keys(first ?? {}).toSorted()).toEqual([
      "capabilityDeclaration",
      "contractVersion",
      "declaredCapabilityCount",
      "event",
      "implementedMethodCount",
      "mode",
      "reasonCode",
      "requiredCapabilityCount",
      "requiredMethodCount",
      "surfaceComplete",
    ]);
    expect(JSON.stringify(first)).not.toMatch(
      /private|prompt|query|snippet|content|principal-secret/u,
    );
    expect(emitted).toEqual([first]);
    expect(second).toBeUndefined();
    expect(secondEmitter).not.toHaveBeenCalled();
  });

  it("reports a complete surface without invoking it", () => {
    const runtime = createCompleteRuntime();
    const emit = vi.fn();
    const metadata = emitMemoryAuthorizationShadowSurfaceInspection(runtime, emit);

    expect(metadata).toMatchObject({
      capabilityDeclaration: "complete",
      declaredCapabilityCount: MEMORY_AUTHORIZATION_CAPABILITY_NAMES.length,
      implementedMethodCount: AUTHORIZED_MEMORY_RUNTIME_METHOD_NAMES.length,
      surfaceComplete: true,
      reasonCode: "surface-complete",
    });
    expect(emit).toHaveBeenCalledOnce();
  });
});

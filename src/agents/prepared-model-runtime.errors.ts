import { PluginInstanceUnavailableError } from "../plugins/plugin-instance-error.js";
import type { PreparedModelRuntimeInput } from "./prepared-model-runtime.types.js";

export class PreparedModelRuntimeOwnerNotPublishedError extends Error {
  constructor(message?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PreparedModelRuntimeOwnerNotPublishedError";
  }
}

export class PreparedModelRuntimePublicationSupersededError extends PreparedModelRuntimeOwnerNotPublishedError {
  constructor(message?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PreparedModelRuntimePublicationSupersededError";
  }
}

export class PreparedModelRuntimePluginGenerationRetiredError extends Error {
  constructor(message?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PreparedModelRuntimePluginGenerationRetiredError";
  }
}

export function isPreparedModelRuntimePluginLifecycleFailure(error: unknown): boolean {
  return (
    error instanceof PluginInstanceUnavailableError ||
    error instanceof PreparedModelRuntimePluginGenerationRetiredError ||
    error instanceof PreparedModelRuntimePublicationSupersededError
  );
}

export function assertPreparedModelRuntimeInputCurrent(
  input: PreparedModelRuntimeInput,
  isCurrent: (() => boolean) | undefined,
): void {
  if (isCurrent && !isCurrent()) {
    throw new PreparedModelRuntimePublicationSupersededError(
      `prepared model runtime publication was superseded for ${input.agentDir}`,
    );
  }
}

export function assertPreparedModelRuntimeCandidatesCurrent(
  candidates: readonly {
    input: PreparedModelRuntimeInput;
    isBuildCurrent?: () => boolean;
  }[],
): void {
  for (const candidate of candidates) {
    assertPreparedModelRuntimeInputCurrent(candidate.input, candidate.isBuildCurrent);
  }
}

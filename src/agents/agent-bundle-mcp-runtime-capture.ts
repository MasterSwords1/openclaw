import { AsyncLocalStorage } from "node:async_hooks";
import type { SessionMcpRuntime } from "./agent-bundle-mcp-types.js";

export type SessionMcpRuntimeCapture = (runtime: SessionMcpRuntime) => void;

type SessionMcpRuntimeRetirement = {
  retire: (runtime: SessionMcpRuntime) => Promise<boolean>;
  complete: (runtime: SessionMcpRuntime) => Promise<boolean>;
};

export type SessionMcpRuntimeCollector = {
  capture: SessionMcpRuntimeCapture;
  closeAndRetire: (retirement: SessionMcpRuntimeRetirement) => Promise<void>;
};

const runtimeCaptureStorage = new AsyncLocalStorage<SessionMcpRuntimeCapture | null>();

export function createSessionMcpRuntimeCollector(): SessionMcpRuntimeCollector {
  const claims = new Map<SessionMcpRuntime, (() => void) | undefined>();
  let closed = false;
  let closePromise: Promise<void> | undefined;
  const capture: SessionMcpRuntimeCapture = (runtime) => {
    if (closed || claims.has(runtime)) {
      return;
    }
    claims.set(runtime, runtime.acquireLease?.());
  };
  return {
    capture,
    closeAndRetire(retirement) {
      if (closePromise) {
        return closePromise;
      }
      closed = true;
      const ownedClaims = [...claims];
      closePromise = (async () => {
        const armedRuntimes: SessionMcpRuntime[] = [];
        const errors: unknown[] = [];
        for (const [runtime] of ownedClaims) {
          try {
            if (await retirement.retire(runtime)) {
              armedRuntimes.push(runtime);
            }
          } catch (error) {
            errors.push(error);
          }
        }
        for (const [, release] of ownedClaims) {
          try {
            release?.();
          } catch (error) {
            errors.push(error);
          }
        }
        for (const runtime of armedRuntimes) {
          try {
            await retirement.complete(runtime);
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length > 0) {
          throw new AggregateError(errors, "Failed to retire captured session MCP runtimes");
        }
      })();
      return closePromise;
    },
  };
}

export async function withSessionMcpRuntimeCapture<T>(
  capture: SessionMcpRuntimeCapture | undefined,
  work: () => Promise<T>,
): Promise<T> {
  return await runtimeCaptureStorage.run(capture ?? null, work);
}

export async function withoutSessionMcpRuntimeCapture<T>(work: () => Promise<T>): Promise<T> {
  return await runtimeCaptureStorage.run(null, work);
}

export function captureSessionMcpRuntime(runtime: SessionMcpRuntime): void {
  runtimeCaptureStorage.getStore()?.(runtime);
}

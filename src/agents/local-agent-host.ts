import type { AgentEventPayload } from "../infra/agent-events.js";
import { withAgentEventSink } from "../infra/agent-events.js";

export type LocalAgentTurnHandle<TAdapterState, TResult> = {
  readonly runId: string;
  readonly sessionKey: string;
  readonly agentId?: string;
  readonly adapterState: TAdapterState;
  readonly signal: AbortSignal;
  readonly result: Promise<TResult>;
  cancel: (reason?: unknown) => boolean;
};

type LocalAgentTurnStart<TAdapterState, TResult> = {
  runId: string;
  sessionKey: string;
  agentId?: string;
  adapterState: TAdapterState;
  abortSignal?: AbortSignal;
  execute: (signal: AbortSignal) => Promise<TResult>;
  onEvent?: (event: AgentEventPayload) => void;
};

/**
 * Owns process-local turn handles above an injected agent executor.
 *
 * Adapter state stays opaque. Queue, delivery, presentation, and session policy
 * remain outside this host.
 */
export class LocalAgentHost<TAdapterState, TResult> {
  private readonly active = new Map<string, LocalAgentTurnHandle<TAdapterState, TResult>>();
  private sealed = false;

  startTurn(
    input: LocalAgentTurnStart<TAdapterState, TResult>,
  ): LocalAgentTurnHandle<TAdapterState, TResult> {
    if (this.sealed) {
      throw new Error("Local agent host is sealed");
    }
    if (this.active.has(input.runId)) {
      throw new Error(`Local agent turn "${input.runId}" is already active`);
    }

    const controller = new AbortController();
    const signal = input.abortSignal
      ? AbortSignal.any([controller.signal, input.abortSignal])
      : controller.signal;
    let resolveResult!: (value: TResult | PromiseLike<TResult>) => void;
    let rejectResult!: (reason?: unknown) => void;
    const result = new Promise<TResult>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });

    const handle: LocalAgentTurnHandle<TAdapterState, TResult> = {
      runId: input.runId,
      sessionKey: input.sessionKey,
      agentId: input.agentId,
      adapterState: input.adapterState,
      signal,
      result,
      cancel: (reason) => {
        if (signal.aborted) {
          return false;
        }
        controller.abort(reason);
        return true;
      },
    };
    this.active.set(input.runId, handle);

    const settle = () => {
      if (this.active.get(input.runId) === handle) {
        this.active.delete(input.runId);
      }
    };
    try {
      const execution = withAgentEventSink(
        (event) => {
          if (event.runId === input.runId && this.active.get(input.runId) === handle) {
            input.onEvent?.(event);
          }
        },
        () => input.execute(signal),
      );
      void Promise.resolve(execution).then(
        (value) => {
          settle();
          resolveResult(value);
        },
        (error: unknown) => {
          settle();
          rejectResult(error);
        },
      );
    } catch (error) {
      settle();
      rejectResult(error);
    }

    return handle;
  }

  get(runId: string): LocalAgentTurnHandle<TAdapterState, TResult> | undefined {
    return this.active.get(runId);
  }

  list(): LocalAgentTurnHandle<TAdapterState, TResult>[] {
    return [...this.active.values()];
  }

  seal(): LocalAgentTurnHandle<TAdapterState, TResult>[] {
    this.sealed = true;
    return this.list();
  }

  cancelAll(reason?: unknown): string[] {
    const cancelled: string[] = [];
    for (const handle of this.active.values()) {
      if (handle.cancel(reason)) {
        cancelled.push(handle.runId);
      }
    }
    return cancelled;
  }

  detachAll(reason?: unknown): LocalAgentTurnHandle<TAdapterState, TResult>[] {
    const detached = this.list();
    this.active.clear();
    for (const handle of detached) {
      handle.cancel(reason);
    }
    return detached;
  }
}

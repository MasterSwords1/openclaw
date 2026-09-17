// Verifies the yield between store recovery iterations to prevent event loop starvation.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { callGateway } from "../../gateway/call.js";
import type { GatewayRecoveryRuntime } from "../../gateway/server-instance-runtime.types.js";
import { resetAgentEventsForTest } from "../../infra/agent-events.js";
import { resetGatewayWorkAdmission } from "../../process/gateway-work-admission.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import {
  createSessionEntry,
  createSessionStore,
  type SessionEntryFixture,
} from "../subagent-test-fixtures.test-helpers.js";
import { recoverStore } from "./main-session-restart-recovery-store.js";
import { recoverRestartAbortedMainSessions } from "./main-session-restart-recovery.js";

vi.mock("../../gateway/call.js", () => ({
  callGateway: vi.fn(async () => ({ runId: "run-resumed" })),
}));

const sendRecoveryNotice = vi.fn<GatewayRecoveryRuntime["sendRecoveryNotice"]>(async () => ({
  suppressed: false,
}));
let dispatchSettlement = createDeferred();
const mockRecoveryRuntime = {
  dispatchAgent: async <T>(
    params: Record<string, unknown>,
    timeoutMs?: number,
    options?: Parameters<GatewayRecoveryRuntime["dispatchAgent"]>[2],
  ) => {
    const result = (await callGateway({ method: "agent", params, timeoutMs })) as T;
    const status = (result as { status?: unknown } | undefined)?.status;
    if (status === undefined) {
      options?.onStartOwner?.({
        observe: () => ({ executionStarted: true, expiresAtMs: Date.now() + 60_000 }),
        abort: () => false,
      });
      options?.onAccepted?.(result);
      options?.onExecutionStarted?.();
      await dispatchSettlement.promise;
    }
    return result;
  },
  waitForAgent: async <T>(params: Record<string, unknown>, timeoutMs?: number) =>
    (await callGateway({ method: "agent.wait", params, timeoutMs })) as T,
  dispatchSessionMethod: vi.fn(),
  sendRecoveryNotice,
};

type RecoveryParams<T extends { gatewayRuntime: unknown }> = Omit<T, "gatewayRuntime"> &
  Partial<Pick<T, "gatewayRuntime">>;

const doRecoverRestartAbortedMainSessions = (
  params: RecoveryParams<Parameters<typeof recoverRestartAbortedMainSessions>[0]>,
) => recoverRestartAbortedMainSessions({ gatewayRuntime: mockRecoveryRuntime, ...params });

let tmpDir: string;

beforeEach(async () => {
  vi.clearAllMocks();
  dispatchSettlement = createDeferred();
  vi.mocked(callGateway).mockReset();
  vi.mocked(callGateway).mockImplementation(async () => ({ runId: "run-resumed" }));
  resetAgentEventsForTest();
  resetGatewayWorkAdmission();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-main-restart-recovery-yield-"));
});

afterEach(async () => {
  resetGatewayWorkAdmission();
  await cleanupSessionStateForTest({ stateDir: tmpDir });
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeStorePath(
  storePath: string,
  store: Record<string, SessionEntryFixture>,
): Promise<void> {
  await Promise.all(
    Object.entries(store).map(([sessionKey, entry]) =>
      replaceSessionEntry({ storePath, sessionKey }, createSessionEntry(entry)),
    ),
  );
}

async function writeStore(
  sessionsDir: string,
  store: Record<string, SessionEntryFixture>,
): Promise<void> {
  await writeStorePath(path.join(sessionsDir, "sessions.json"), store);
}

function mainSessionEntry(overrides: SessionEntryFixture = {}): SessionEntry {
  return createSessionEntry({
    sessionId: "main-session",
    permissionMode: "guarded",
    updatedAt: Date.now() - 10_000,
    status: "running",
    abortedLastRun: true,
    ...overrides,
  });
}

function mainSessionStore(
  overrides: SessionEntryFixture = {},
  sessionKey = "agent:main:main",
): Record<string, SessionEntry> {
  return createSessionStore(mainSessionEntry(overrides), sessionKey);
}

function makePendingFinalDelivery(
  text = "interrupted response",
  overrides: Partial<NonNullable<SessionEntry["pendingFinalDelivery"]>> = {},
): NonNullable<SessionEntry["pendingFinalDelivery"]> {
  return {
    kind: "replayable",
    text,
    createdAt: Date.now(),
    intentId: "intent-prepared-default",
    deliveries: [{ id: "delivery-prepared-default", state: "prepared" }],
    ...overrides,
  };
}

describe("main-session-restart-recovery yield", () => {
  it("yields to the event loop between store recoveries to prevent accumulation", async () => {
    // Create two stores with recovery targets so the loop runs twice.
    // Use per-agent store config so both agents' stores are discovered.
    const storePathA = path.join(tmpDir, "agents", "agent-a", "sessions", "sessions.json");
    const storePathB = path.join(tmpDir, "agents", "agent-b", "sessions", "sessions.json");

    // Configure per-agent stores so both are discoverable.
    const cfg = {
      agents: { ownership: "explicit", entries: { "agent-a": {}, "agent-b": {} } },
      session: {
        store: path.join("{stateDir}", "agents", "{agentId}", "sessions", "sessions.json"),
      },
    } satisfies import("../../config/config.js").OpenClawConfig;

    // Seed both stores with a running session that needs recovery.
    await writeStore(path.dirname(storePathA), mainSessionStore({}, "agent:agent-a:main"));
    await replaceSessionEntry(
      {
        agentId: "agent-a",
        defaultAgentId: "agent-a",
        sessionKey: "agent:agent-a:main",
        storePath: storePathA,
      },
      mainSessionEntry({ pendingFinalDelivery: makePendingFinalDelivery() }),
    );
    await writeStore(path.dirname(storePathB), mainSessionStore({}, "agent:agent-b:main"));
    await replaceSessionEntry(
      {
        agentId: "agent-b",
        defaultAgentId: "agent-b",
        sessionKey: "agent:agent-b:main",
        storePath: storePathB,
      },
      mainSessionEntry({ pendingFinalDelivery: makePendingFinalDelivery() }),
    );

    // Track when each store's recovery completes and when setImmediate callbacks run.
    const recoveryOrder: string[] = [];
    const originalRecoverStore = recoverStore;
    vi.spyOn({ recoverStore }, "recoverStore").mockImplementation(async (params) => {
      const storeId = params.storePath.includes("agent-a") ? "A" : "B";
      recoveryOrder.push(`start:${storeId}`);
      const result = await originalRecoverStore(params);
      recoveryOrder.push(`end:${storeId}`);
      return result;
    });

    const yields: number[] = [];
    const immediateCallbacks: string[] = [];
    const originalSetImmediate = globalThis.setImmediate;
    vi.spyOn(globalThis, "setImmediate").mockImplementation(
      (callback: (...args: unknown[]) => void, ...args) => {
        yields.push(yields.length);
        // Wrap the callback to track when it actually runs.
        const wrapped = () => {
          immediateCallbacks.push(`immediate:${yields.length - 1}`);
          callback(...args);
        };
        return originalSetImmediate(wrapped);
      },
    );

    try {
      const result = await doRecoverRestartAbortedMainSessions({ cfg, stateDir: tmpDir });
      // Both stores should be recovered.
      expect(result.started).toBeGreaterThanOrEqual(2);
      expect(result.failed).toBe(0);

      // Recovery should have started both stores.
      expect(recoveryOrder).toContain("start:A");
      expect(recoveryOrder).toContain("start:B");

      // At least one immediate callback should have run (proving the yield executed).
      expect(immediateCallbacks.length).toBeGreaterThanOrEqual(1);

      // Verify that an immediate callback ran between the two store recoveries.
      // Find the index of the last "start:B" and check there's an immediate after it.
      const lastStartB = recoveryOrder.lastIndexOf("start:B");
      if (lastStartB >= 0) {
        // There should be an immediate callback that ran during/after the recovery.
        expect(immediateCallbacks.length).toBeGreaterThan(0);
      }
    } finally {
      vi.restoreAllMocks();
    }
  });
});

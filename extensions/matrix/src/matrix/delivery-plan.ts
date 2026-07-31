// Matrix-owned event plans make queue replay idempotent across process restarts.
import { createHash } from "node:crypto";
import path from "node:path";
import type {
  ChannelMessageUnknownSendContext,
  ChannelMessageUnknownSendReconciliationResult,
  MessageReceiptPartKind,
} from "openclaw/plugin-sdk/channel-outbound";
import { getMatrixRuntime } from "../runtime.js";
import type { MatrixClient } from "./sdk.js";
import { withResolvedMatrixSendClient } from "./send/client.js";
import { resolveMatrixRoomId } from "./send/targets.js";
import type { MatrixOutboundContent } from "./send/types.js";

const DELIVERY_PLAN_VERSION = 1;
const DELIVERY_PLAN_NAMESPACE = "outbound-delivery-plans";
const DELIVERY_PLAN_MAX_ENTRIES = 10_000;
const DELIVERY_PLAN_MAX_BYTES = 8 * 1024 * 1024;
const DELIVERY_PLAN_NAMESPACE_MAX_BYTES = 256 * 1024 * 1024;

class MatrixDeliveryPlanInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MatrixDeliveryPlanInvariantError";
  }
}

export type MatrixPlannedEvent = {
  transactionId: string;
  receiptKind: MessageReceiptPartKind;
  content: MatrixOutboundContent;
};

type MatrixDeliveryPlan = {
  version: typeof DELIVERY_PLAN_VERSION;
  queueId: string;
  queueStateDir: string;
  accountId: string;
  roomId: string;
  wireEventType: "m.room.message" | "m.room.encrypted";
  transactionScopeId: string;
  payloadIndex: number;
  partIndex: number;
  createdAt: number;
  events: MatrixPlannedEvent[];
};

type MatrixDeliveryPlanMetadata = Omit<MatrixDeliveryPlan, "events">;

type MatrixDeliveryIdentity = {
  queueId: string;
  queueStateDir: string;
  payloadIndex: number;
  partIndex: number;
};

function createDeliveryPlanStore() {
  return getMatrixRuntime().state.openBlobStore<MatrixDeliveryPlanMetadata>({
    namespace: DELIVERY_PLAN_NAMESPACE,
    maxEntries: DELIVERY_PLAN_MAX_ENTRIES,
    maxBytesPerEntry: DELIVERY_PLAN_MAX_BYTES,
    maxBytesPerNamespace: DELIVERY_PLAN_NAMESPACE_MAX_BYTES,
    overflowPolicy: "reject-new",
  });
}

function requireIndex(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Matrix durable delivery ${label} must be a non-negative integer`);
  }
  return value;
}

function resolveQueueStateDir(queueStateDir?: string): string {
  return path.resolve(queueStateDir?.trim() || getMatrixRuntime().state.resolveStateDir());
}

function queueDigest(identity: Pick<MatrixDeliveryIdentity, "queueId" | "queueStateDir">): string {
  return createHash("sha256")
    .update(resolveQueueStateDir(identity.queueStateDir))
    .update("\0")
    .update(identity.queueId)
    .digest("hex");
}

function queuePrefix(identity: Pick<MatrixDeliveryIdentity, "queueId" | "queueStateDir">): string {
  return `${queueDigest(identity)}.`;
}

function planKey(identity: MatrixDeliveryIdentity): string {
  return `${queuePrefix(identity)}${requireIndex(identity.payloadIndex, "payload index")}.${requireIndex(identity.partIndex, "part index")}`;
}

const RECEIPT_KINDS = new Set<MessageReceiptPartKind>([
  "text",
  "media",
  "voice",
  "poll",
  "card",
  "preview",
  "unknown",
]);

function isPlan(value: unknown): value is MatrixDeliveryPlan {
  if (!value || typeof value !== "object") {
    return false;
  }
  const plan = value as Partial<MatrixDeliveryPlan>;
  return (
    plan.version === DELIVERY_PLAN_VERSION &&
    typeof plan.queueId === "string" &&
    Boolean(plan.queueId.trim()) &&
    typeof plan.queueStateDir === "string" &&
    Boolean(plan.queueStateDir.trim()) &&
    typeof plan.accountId === "string" &&
    typeof plan.roomId === "string" &&
    Boolean(plan.roomId.trim()) &&
    (plan.wireEventType === "m.room.message" || plan.wireEventType === "m.room.encrypted") &&
    typeof plan.transactionScopeId === "string" &&
    Boolean(plan.transactionScopeId.trim()) &&
    Number.isSafeInteger(plan.payloadIndex) &&
    (plan.payloadIndex ?? -1) >= 0 &&
    Number.isSafeInteger(plan.partIndex) &&
    (plan.partIndex ?? -1) >= 0 &&
    typeof plan.createdAt === "number" &&
    Number.isFinite(plan.createdAt) &&
    Array.isArray(plan.events) &&
    plan.events.length > 0 &&
    plan.events.every(
      (event) =>
        event &&
        typeof event === "object" &&
        typeof event.transactionId === "string" &&
        Boolean(event.transactionId.trim()) &&
        RECEIPT_KINDS.has(event.receiptKind) &&
        Boolean(event.content) &&
        typeof event.content === "object",
    )
  );
}

function planMetadata(plan: MatrixDeliveryPlan): MatrixDeliveryPlanMetadata {
  const { events: _events, ...metadata } = plan;
  return metadata;
}

function isPlanMetadata(value: unknown): value is MatrixDeliveryPlanMetadata {
  if (!value || typeof value !== "object") {
    return false;
  }
  const metadata = value as Partial<MatrixDeliveryPlanMetadata>;
  return (
    metadata.version === DELIVERY_PLAN_VERSION &&
    typeof metadata.queueId === "string" &&
    Boolean(metadata.queueId.trim()) &&
    typeof metadata.queueStateDir === "string" &&
    Boolean(metadata.queueStateDir.trim()) &&
    typeof metadata.accountId === "string" &&
    typeof metadata.roomId === "string" &&
    Boolean(metadata.roomId.trim()) &&
    (metadata.wireEventType === "m.room.message" ||
      metadata.wireEventType === "m.room.encrypted") &&
    typeof metadata.transactionScopeId === "string" &&
    Boolean(metadata.transactionScopeId.trim()) &&
    Number.isSafeInteger(metadata.payloadIndex) &&
    (metadata.payloadIndex ?? -1) >= 0 &&
    Number.isSafeInteger(metadata.partIndex) &&
    (metadata.partIndex ?? -1) >= 0 &&
    typeof metadata.createdAt === "number" &&
    Number.isFinite(metadata.createdAt)
  );
}

function decodePlan(bytes: Uint8Array): MatrixDeliveryPlan {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new MatrixDeliveryPlanInvariantError("Matrix durable delivery plan is invalid JSON");
  }
  if (!isPlan(value)) {
    throw new MatrixDeliveryPlanInvariantError("Matrix durable delivery plan is invalid");
  }
  return value;
}

function metadataMatchesPlan(
  metadata: MatrixDeliveryPlanMetadata,
  plan: MatrixDeliveryPlan,
): boolean {
  return JSON.stringify(metadata) === JSON.stringify(planMetadata(plan));
}

function transactionId(identity: MatrixDeliveryIdentity, eventIndex: number): string {
  const digest = createHash("sha256")
    .update(resolveQueueStateDir(identity.queueStateDir))
    .update("\0")
    .update(identity.queueId)
    .update("\0")
    .update(String(requireIndex(identity.payloadIndex, "payload index")))
    .update("\0")
    .update(String(requireIndex(identity.partIndex, "part index")))
    .update("\0")
    .update(String(requireIndex(eventIndex, "event index")))
    .digest("base64url");
  return `oc_${digest}`;
}

export function createMatrixPlannedEvents(params: {
  identity: MatrixDeliveryIdentity;
  events: readonly Omit<MatrixPlannedEvent, "transactionId">[];
}): MatrixPlannedEvent[] {
  return params.events.map((event, index) => ({
    ...structuredClone(event),
    transactionId: transactionId(params.identity, index),
  }));
}

function assertPlanIdentity(
  plan: MatrixDeliveryPlan,
  params: {
    identity: MatrixDeliveryIdentity;
    accountId?: string | null;
    roomId: string;
    transactionScopeId: string;
    wireEventType: "m.room.message" | "m.room.encrypted";
  },
): void {
  if (
    plan.queueId !== params.identity.queueId ||
    plan.queueStateDir !== resolveQueueStateDir(params.identity.queueStateDir) ||
    plan.payloadIndex !== params.identity.payloadIndex ||
    plan.partIndex !== params.identity.partIndex ||
    plan.accountId !== (params.accountId ?? "") ||
    plan.roomId !== params.roomId ||
    plan.transactionScopeId !== params.transactionScopeId ||
    plan.wireEventType !== params.wireEventType
  ) {
    throw new MatrixDeliveryPlanInvariantError(
      "Matrix durable delivery plan no longer matches the active delivery target",
    );
  }
}

export async function loadMatrixDeliveryPlan(params: {
  identity: MatrixDeliveryIdentity;
  accountId?: string | null;
  roomId: string;
  transactionScopeId: string;
  wireEventType: "m.room.message" | "m.room.encrypted";
}): Promise<MatrixDeliveryPlan | null> {
  const entry = await createDeliveryPlanStore().lookup(planKey(params.identity));
  if (entry === undefined) {
    return null;
  }
  const plan = decodePlan(entry.bytes);
  if (!metadataMatchesPlan(entry.metadata, plan)) {
    throw new MatrixDeliveryPlanInvariantError("Matrix durable delivery metadata is invalid");
  }
  assertPlanIdentity(plan, params);
  return structuredClone(plan);
}

export async function persistMatrixDeliveryPlan(params: {
  identity: MatrixDeliveryIdentity;
  accountId?: string | null;
  roomId: string;
  transactionScopeId: string;
  wireEventType: "m.room.message" | "m.room.encrypted";
  events: readonly MatrixPlannedEvent[];
}): Promise<MatrixDeliveryPlan> {
  if (params.events.length === 0) {
    throw new Error("Matrix durable delivery plan must contain at least one event");
  }
  await ensureMatrixDeliveryPlanGarbageCollection();
  const identity = {
    ...params.identity,
    queueStateDir: resolveQueueStateDir(params.identity.queueStateDir),
  };
  const plan: MatrixDeliveryPlan = {
    version: DELIVERY_PLAN_VERSION,
    queueId: identity.queueId,
    queueStateDir: identity.queueStateDir,
    accountId: params.accountId ?? "",
    roomId: params.roomId,
    wireEventType: params.wireEventType,
    transactionScopeId: params.transactionScopeId,
    payloadIndex: requireIndex(identity.payloadIndex, "payload index"),
    partIndex: requireIndex(identity.partIndex, "part index"),
    createdAt: Date.now(),
    events: params.events.map((event, index) => {
      const expectedTransactionId = transactionId(identity, index);
      if (event.transactionId !== expectedTransactionId) {
        throw new MatrixDeliveryPlanInvariantError(
          "Matrix durable delivery plan has an invalid transaction identifier",
        );
      }
      return structuredClone(event);
    }),
  };
  const store = createDeliveryPlanStore();
  const bytes = new TextEncoder().encode(JSON.stringify(plan));
  if (await store.registerIfAbsent(planKey(identity), bytes, planMetadata(plan))) {
    return plan;
  }
  const existing = await loadMatrixDeliveryPlan(params);
  if (!existing) {
    throw new MatrixDeliveryPlanInvariantError(
      "Matrix durable delivery plan disappeared after registration",
    );
  }
  if (JSON.stringify(existing.events) !== JSON.stringify(plan.events)) {
    throw new MatrixDeliveryPlanInvariantError(
      "Matrix durable delivery plan no longer matches the prepared event batch",
    );
  }
  return existing;
}

export function resolveMatrixDurableDeliveryIdentity(params: {
  queueId?: string;
  queueStateDir?: string;
  payloadIndex?: number;
  partIndex?: number;
}): MatrixDeliveryIdentity | null {
  if (params.queueId === undefined) {
    return null;
  }
  if (params.payloadIndex === undefined || params.partIndex === undefined) {
    throw new Error("Matrix durable delivery requires stable payload and part indexes");
  }
  return {
    queueId: params.queueId,
    queueStateDir: resolveQueueStateDir(params.queueStateDir),
    payloadIndex: requireIndex(params.payloadIndex, "payload index"),
    partIndex: requireIndex(params.partIndex, "part index"),
  };
}

async function requireTransactionScope(client: MatrixClient): Promise<string> {
  const scope = (await client.getTransactionScopeId()).trim();
  if (!scope) {
    throw new MatrixDeliveryPlanInvariantError(
      "Matrix durable delivery requires a stable transaction scope",
    );
  }
  return scope;
}

async function loadQueuePlans(
  identity: Pick<MatrixDeliveryIdentity, "queueId" | "queueStateDir">,
): Promise<MatrixDeliveryPlan[]> {
  const store = createDeliveryPlanStore();
  const keys = (await store.entries())
    .filter((entry) => entry.key.startsWith(queuePrefix(identity)))
    .map((entry) => entry.key);
  return await Promise.all(
    keys.map(async (key) => {
      const entry = await store.lookup(key);
      if (!entry) {
        throw new MatrixDeliveryPlanInvariantError(
          "Matrix durable delivery plan disappeared during reconciliation",
        );
      }
      const plan = decodePlan(entry.bytes);
      if (key !== planKey(plan) || !metadataMatchesPlan(entry.metadata, plan)) {
        throw new MatrixDeliveryPlanInvariantError("Matrix durable delivery metadata is invalid");
      }
      return plan;
    }),
  );
}

export async function reconcileMatrixUnknownSend(
  ctx: ChannelMessageUnknownSendContext,
): Promise<ChannelMessageUnknownSendReconciliationResult> {
  try {
    const plans = await loadQueuePlans({
      queueId: ctx.queueId,
      queueStateDir: resolveQueueStateDir(ctx.deliveryQueueStateDir),
    });
    if (plans.length === 0) {
      return {
        status: "unresolved",
        error: "Matrix ambiguous delivery has no persisted event plan",
        retryable: false,
      };
    }
    return await withResolvedMatrixSendClient(
      { cfg: ctx.cfg, accountId: ctx.accountId },
      async (client) => {
        const transactionScopeId = await requireTransactionScope(client);
        const roomId = await resolveMatrixRoomId(client, ctx.to);
        const wireEventType = await client.getMessageWireEventType(roomId);
        const plannedItems =
          ctx.renderedBatchPlan?.items ??
          ctx.payloads.map((payload, index) => ({
            index,
            mediaUrls: [payload.mediaUrl, ...(payload.mediaUrls ?? [])].filter(Boolean),
          }));
        const expectedPartCounts = new Map(
          plannedItems.map((item) => [item.index, Math.max(1, item.mediaUrls.length)] as const),
        );
        const storedPartsByPayload = new Map<number, Set<number>>();
        for (const plan of plans) {
          assertPlanIdentity(plan, {
            identity: plan,
            accountId: ctx.accountId,
            roomId,
            transactionScopeId,
            wireEventType,
          });
          const expectedPartCount = expectedPartCounts.get(plan.payloadIndex);
          if (expectedPartCount === undefined || plan.partIndex >= expectedPartCount) {
            throw new MatrixDeliveryPlanInvariantError(
              "Matrix durable delivery plan coordinates are not in the queued batch",
            );
          }
          const storedParts = storedPartsByPayload.get(plan.payloadIndex) ?? new Set<number>();
          storedParts.add(plan.partIndex);
          storedPartsByPayload.set(plan.payloadIndex, storedParts);
        }
        for (const storedParts of storedPartsByPayload.values()) {
          const highestPart = Math.max(...storedParts);
          for (let partIndex = 0; partIndex <= highestPart; partIndex += 1) {
            if (!storedParts.has(partIndex)) {
              // A missing tail was never dispatched: every part persists its plan
              // first. A gap inside the persisted prefix is invalid and fails closed.
              throw new MatrixDeliveryPlanInvariantError(
                "Matrix durable delivery plan has a missing dispatched coordinate",
              );
            }
          }
        }
        return { status: "replay_safe" };
      },
    );
  } catch (error) {
    return {
      status: "unresolved",
      error: error instanceof Error ? error.message : String(error),
      retryable: !(error instanceof MatrixDeliveryPlanInvariantError),
    };
  }
}

export async function cleanupMatrixDeliveryPlans(ctx: {
  queueId: string;
  deliveryQueueStateDir?: string;
}): Promise<void> {
  const store = createDeliveryPlanStore();
  try {
    const keys = (await store.entries())
      .filter((entry) =>
        entry.key.startsWith(
          queuePrefix({
            queueId: ctx.queueId,
            queueStateDir: resolveQueueStateDir(ctx.deliveryQueueStateDir),
          }),
        ),
      )
      .map((entry) => entry.key);
    await Promise.all(keys.map(async (key) => await store.delete(key)));
  } finally {
    // A failed terminal cleanup must re-arm GC for the next send in this process.
    initialPlanPrune = undefined;
  }
}

type MatrixDeliveryPlanPruneResult = {
  deleted: number;
  retained: number;
  invalid: number;
};

async function pruneMatrixTerminalDeliveryPlans(): Promise<MatrixDeliveryPlanPruneResult> {
  const getQueueStatus = getMatrixRuntime().state.getOutboundDeliveryQueueStatus;
  if (!getQueueStatus) {
    throw new Error("Matrix durable delivery cleanup requires queue status support");
  }
  const store = createDeliveryPlanStore();
  const entries = await store.entries();
  const statusByQueue = new Map<string, "pending" | "terminal" | "absent">();
  const deletions: string[] = [];
  let retained = 0;
  let invalid = 0;
  for (const entry of entries) {
    const metadata = entry.metadata;
    if (!isPlanMetadata(metadata) || entry.key !== planKey(metadata)) {
      invalid += 1;
      continue;
    }
    const location = JSON.stringify([metadata.queueId, metadata.queueStateDir]);
    let status = statusByQueue.get(location);
    if (!status) {
      status = await getQueueStatus(metadata.queueId, metadata.queueStateDir);
      statusByQueue.set(location, status);
    }
    if (status === "pending") {
      retained += 1;
    } else {
      // Queue ownership commits before plan registration in the same SQLite
      // store, so terminal/absent both prove this plan is no longer replayable.
      deletions.push(entry.key);
    }
  }
  await Promise.all(deletions.map(async (key) => await store.delete(key)));
  return { deleted: deletions.length, retained, invalid };
}

let initialPlanPrune: Promise<MatrixDeliveryPlanPruneResult> | undefined;

export async function ensureMatrixDeliveryPlanGarbageCollection(options?: {
  force?: boolean;
}): Promise<MatrixDeliveryPlanPruneResult> {
  const current =
    options?.force === true
      ? pruneMatrixTerminalDeliveryPlans()
      : (initialPlanPrune ?? pruneMatrixTerminalDeliveryPlans());
  initialPlanPrune = current;
  try {
    return await current;
  } catch (error) {
    if (initialPlanPrune === current) {
      initialPlanPrune = undefined;
    }
    throw error;
  }
}

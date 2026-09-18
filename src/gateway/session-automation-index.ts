import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveCronJobBoundSessionKeys } from "../cron/job-session-bindings.js";
import type { CronJob } from "../cron/types.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import { sessionChanges } from "../sessions/session-row-changes.js";

type SessionAutomationSource = {
  /** Current in-memory cron jobs; undefined until the cron store is loaded. */
  getJobs: () => readonly CronJob[] | undefined;
  getDefaultAgentId: () => string | undefined;
};

let source: SessionAutomationSource | null = null;
let epochCounter = 0;
let registeredEpoch = 0;

let memo: {
  jobs: readonly CronJob[];
  cfg: OpenClawConfig;
  keys: ReadonlySet<string>;
} | null = null;

/** Track the last-emitted keys so we can compute targeted deltas. */
let lastEmittedKeys: ReadonlySet<string> | null = null;

export function claimSessionAutomationEpoch(): number {
  return ++epochCounter;
}

export function registerSessionAutomationSource(
  next: SessionAutomationSource | null,
  epoch?: number,
): void {
  const effectiveEpoch = epoch ?? claimSessionAutomationEpoch();
  if (effectiveEpoch < registeredEpoch) {
    return;
  }
  registeredEpoch = effectiveEpoch;
  source = next;
  lastEmittedKeys = null;
  invalidateSessionAutomationIndex();
}

export function unregisterSessionAutomationSource(owner: SessionAutomationSource): void {
  if (source !== owner) {
    return;
  }
  source = null;
  invalidateSessionAutomationIndex();
}

export function invalidateSessionAutomationIndex(): void {
  // Preserve the previous keys BEFORE clearing, so we can compute deltas.
  const prevKeys = lastEmittedKeys;
  memo = null;
  // Do NOT clear lastEmittedKeys yet — we need it for delta computation below.

  const jobs = source?.getJobs();
  const defaultAgentId = source?.getDefaultAgentId();

  if (!jobs || jobs.length === 0) {
    sessionChanges.emit({ all: true, scope: "automation" });
    lastEmittedKeys = new Set();
    return;
  }

  const currentKeys = buildAutomationKeys(jobs, {} as OpenClawConfig, defaultAgentId);

  // First emission (prevKeys is null); emit global to seed all resident sessions.
  if (prevKeys === null) {
    lastEmittedKeys = currentKeys;
    sessionChanges.emit({ all: true, scope: "automation" });
    return;
  }

  // If bindings unchanged, no invalidation needed.
  if (keysEqual(prevKeys, currentKeys)) {
    lastEmittedKeys = currentKeys;
    return;
  }

  // Emit targeted changes for added/removed session keys.
  const added = [...currentKeys].filter((k) => !prevKeys!.has(k));
  const removed = [...prevKeys!].filter((k) => !currentKeys.has(k));
  for (const key of added) {
    sessionChanges.emit({ sessionKey: key, scope: "automation" });
  }
  for (const key of removed) {
    sessionChanges.emit({ sessionKey: key, scope: "automation" });
  }

  lastEmittedKeys = currentKeys;
}

function keysEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const key of a) {
    if (!b.has(key)) return false;
  }
  return true;
}

function buildAutomationKeys(
  jobs: readonly CronJob[],
  cfg: OpenClawConfig,
  defaultAgentId: string | undefined,
): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const job of jobs) {
    if (!job.enabled) {
      continue;
    }
    for (const key of resolveCronJobBoundSessionKeys(job, {
      cfg,
      defaultAgentId,
    })) {
      const agentId = job.owner?.agentId ?? defaultAgentId;
      if (parseAgentSessionKey(key)) {
        keys.add(key);
      } else if (agentId) {
        keys.add(`${normalizeAgentId(agentId)}\0${key}`);
      }
    }
  }
  return keys;
}

export function sessionHasAutomation(
  sessionKey: string,
  cfg: OpenClawConfig,
  agentId?: string,
): boolean {
  const jobs = source?.getJobs();
  if (!source || !jobs || jobs.length === 0) {
    return false;
  }
  if (!memo || memo.jobs !== jobs || memo.cfg !== cfg) {
    memo = {
      jobs,
      cfg,
      keys: buildAutomationKeys(jobs, cfg, source.getDefaultAgentId()),
    };
  }
  const identity = parseAgentSessionKey(sessionKey)
    ? sessionKey
    : agentId
      ? `${normalizeAgentId(agentId)}\0${sessionKey}`
      : undefined;
  return identity ? memo.keys.has(identity) : false;
}

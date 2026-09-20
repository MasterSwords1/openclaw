import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { sameFileMutationFingerprint } from "../infra/file-descriptor.js";
import { prepareSqliteReadOnlyLocationSync } from "../infra/sqlite-snapshot-source.js";
import { assertSqliteSourceReadAllowed } from "../infra/sqlite-source-handle.js";
import { hasStateDatabaseSourceExclusion } from "../infra/state-database-coordinator.js";
import type { OpenClawStateSchemaReadAdmission } from "./openclaw-state-db-contract.js";
import { withOpenClawStateReadOnlyLocation } from "./openclaw-state-db-read-connection.js";
import {
  retainedUnmutatedStateSnapshots,
  retireRetainedSnapshot,
  type RetainedUnmutatedStateSnapshot,
  type StateDatabaseSourceWitness,
} from "./openclaw-state-db-readonly-cache-store.js";
import type { OpenClawStateReadOnlyDatabase } from "./openclaw-state-read.types.js";

function canonicalDatabasePathname(pathname: string): string {
  try {
    return realpathSync.native(pathname);
  } catch {
    return path.resolve(pathname);
  }
}

function readStateDatabaseSourceWitness(pathname: string): StateDatabaseSourceWitness | undefined {
  try {
    const canonical = canonicalDatabasePathname(pathname);
    const files = ["", "-wal", "-journal"].map((suffix) =>
      statSync(`${canonical}${suffix}`, { bigint: true, throwIfNoEntry: false }),
    );
    return files[0] && files.every((file) => !file || file.isFile())
      ? files.map((stat) =>
          stat
            ? {
                birthtimeNs: stat.birthtimeNs,
                ctimeNs: stat.ctimeNs,
                dev: stat.dev,
                ino: stat.ino,
                mtimeNs: stat.mtimeNs,
                size: stat.size,
              }
            : undefined,
        )
      : undefined;
  } catch {
    return undefined;
  }
}

function matchesStateDatabaseSourceWitness(
  before: StateDatabaseSourceWitness,
  after: StateDatabaseSourceWitness | undefined,
): boolean {
  return Boolean(
    after &&
    before.length === after.length &&
    before.every((file, index) => {
      const current = after[index];
      return file ? current && sameFileMutationFingerprint(file, current) : !current;
    }),
  );
}

function runWithRetainedSnapshot<T>(
  snapshot: RetainedUnmutatedStateSnapshot,
  key: string,
  pathname: string,
  operation: (database: OpenClawStateReadOnlyDatabase) => T,
  openStateSchemaReadAdmission?: OpenClawStateSchemaReadAdmission,
): T {
  const releaseReader = () => {
    snapshot.activeReaders -= 1;
    if (snapshot.retired && snapshot.activeReaders === 0) {
      try {
        snapshot.cleanup();
      } catch {
        // Cleanup failures are handled by the snapshot subsystem.
      }
    }
  };
  let result: T;
  try {
    result = withOpenClawStateReadOnlyLocation(
      operation,
      pathname,
      snapshot.location,
      openStateSchemaReadAdmission,
      undefined,
      snapshot.cleanupRoot,
    );
  } catch (error) {
    if (retainedUnmutatedStateSnapshots.get(key) === snapshot) {
      retainedUnmutatedStateSnapshots.delete(key);
    }
    snapshot.retired = true;
    releaseReader();
    throw error;
  }
  if (isPromiseLike(result)) {
    return Promise.resolve(result)
      .catch((error: unknown) => {
        if (retainedUnmutatedStateSnapshots.get(key) === snapshot) {
          retainedUnmutatedStateSnapshots.delete(key);
        }
        snapshot.retired = true;
        throw error;
      })
      .finally(releaseReader) as T; // SAFETY: Promise-like result resolves to the caller's expected return type T.
  }
  releaseReader();
  return result;
}

export function withRetainedUnmutatedStateSnapshot<T>(
  operation: (database: OpenClawStateReadOnlyDatabase) => T,
  pathname: string,
  openStateSchemaReadAdmission?: OpenClawStateSchemaReadAdmission,
): T {
  if (hasStateDatabaseSourceExclusion(pathname)) {
    const prepared = prepareSqliteReadOnlyLocationSync(pathname);
    return withOpenClawStateReadOnlyLocation(
      operation,
      pathname,
      prepared,
      openStateSchemaReadAdmission,
    );
  }
  assertSqliteSourceReadAllowed(pathname);

  const key = canonicalDatabasePathname(pathname);
  const cached = retainedUnmutatedStateSnapshots.get(key);
  const currentWitness = readStateDatabaseSourceWitness(key);
  if (
    cached &&
    !cached.retired &&
    currentWitness &&
    matchesStateDatabaseSourceWitness(cached.witness, currentWitness) &&
    existsSync(cached.location)
  ) {
    cached.activeReaders += 1;
    return runWithRetainedSnapshot(cached, key, pathname, operation, openStateSchemaReadAdmission);
  }

  if (cached) {
    retainedUnmutatedStateSnapshots.delete(key);
    retireRetainedSnapshot(cached);
  }

  const witnessBefore = currentWitness ?? readStateDatabaseSourceWitness(key);
  const prepared = prepareSqliteReadOnlyLocationSync(key);
  const canonicalAfter = canonicalDatabasePathname(pathname);
  const witnessAfter = readStateDatabaseSourceWitness(key);

  if (
    canonicalAfter !== key ||
    !witnessBefore ||
    !witnessAfter ||
    !matchesStateDatabaseSourceWitness(witnessBefore, witnessAfter)
  ) {
    return withOpenClawStateReadOnlyLocation(
      operation,
      pathname,
      prepared,
      openStateSchemaReadAdmission,
    );
  }

  const displaced = retainedUnmutatedStateSnapshots.get(key);
  if (displaced) {
    retainedUnmutatedStateSnapshots.delete(key);
    retireRetainedSnapshot(displaced);
  }

  const snapshot: RetainedUnmutatedStateSnapshot = {
    location: prepared.location,
    cleanupRoot: prepared.cleanupRoot ?? path.dirname(prepared.location),
    witness: witnessAfter,
    activeReaders: 1,
    retired: false,
    cleanup: prepared.cleanup,
  };
  retainedUnmutatedStateSnapshots.set(key, snapshot);
  return runWithRetainedSnapshot(snapshot, key, pathname, operation, openStateSchemaReadAdmission);
}

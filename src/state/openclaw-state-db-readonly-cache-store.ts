import { realpathSync } from "node:fs";
import path from "node:path";
import type { FileMutationFingerprint } from "../infra/file-descriptor.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

export type StateDatabaseSourceWitness = (FileMutationFingerprint | undefined)[];

export type RetainedUnmutatedStateSnapshot = {
  location: string;
  cleanupRoot: string;
  witness: StateDatabaseSourceWitness;
  activeReaders: number;
  retired: boolean;
  cleanup: () => boolean;
};

export const retainedUnmutatedStateSnapshots = resolveGlobalSingleton(
  Symbol.for("openclaw.retainedUnmutatedStateSnapshots"),
  () => new Map<string, RetainedUnmutatedStateSnapshot>(),
);

export function retireRetainedSnapshot(snapshot: RetainedUnmutatedStateSnapshot): void {
  snapshot.retired = true;
  if (snapshot.activeReaders === 0) {
    try {
      snapshot.cleanup();
    } catch {
      // Diagnostic/cleanup failures are handled by the snapshot cleanup subsystem.
    }
  }
}

export function clearRetainedUnmutatedStateSnapshots(): void {
  for (const [key, snapshot] of retainedUnmutatedStateSnapshots.entries()) {
    retainedUnmutatedStateSnapshots.delete(key);
    retireRetainedSnapshot(snapshot);
  }
}

export function evictRetainedUnmutatedStateSnapshot(pathname: string): void {
  let key: string;
  try {
    key = realpathSync.native(pathname);
  } catch {
    key = path.resolve(pathname);
  }
  const resolvedKey = path.resolve(pathname);
  const snapshot =
    retainedUnmutatedStateSnapshots.get(key) ?? retainedUnmutatedStateSnapshots.get(resolvedKey);
  if (snapshot) {
    retainedUnmutatedStateSnapshots.delete(key);
    retainedUnmutatedStateSnapshots.delete(resolvedKey);
    retireRetainedSnapshot(snapshot);
  }
}

// Re-exports fs-safe helpers with OpenClaw defaults and wrappers.
import "./fs-safe-defaults.js";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  ensureDirectoryWithinRoot,
  findExistingAncestor,
  sameFileIdentity,
  type FileIdentityStat,
} from "@openclaw/fs-safe/advanced";
import { writeExternalFileWithinRoot as writeExternalFileWithinRootBase } from "@openclaw/fs-safe/output";
import {
  root as fsSafeRoot,
  type ReadResult,
  type Root as FsSafeRoot,
  type RootDefaults,
} from "@openclaw/fs-safe/root";
import { writeOwnedTempFile } from "./owned-temp-file.js";

export { FsSafeError, type FsSafeErrorCode } from "@openclaw/fs-safe/errors";
export {
  assertAbsolutePathInput,
  canonicalPathFromExistingAncestor,
  findExistingAncestor,
  resolveAbsolutePathForRead,
  resolveAbsolutePathForWrite,
  type AbsolutePathSymlinkPolicy,
  type EnsureAbsoluteDirectoryOptions,
  type EnsureAbsoluteDirectoryResult,
  type ResolvedAbsolutePath,
  type ResolvedWritableAbsolutePath,
} from "@openclaw/fs-safe/advanced";
export { isPathInside } from "@openclaw/fs-safe/path";
export { pathExists, pathExistsSync } from "@openclaw/fs-safe/advanced";
export { movePathToTrash, type MovePathToTrashOptions } from "@openclaw/fs-safe/advanced";
export { readLocalFileFromRoots, resolveLocalPathFromRootsSync } from "@openclaw/fs-safe/advanced";
export {
  appendRegularFile,
  appendRegularFileSync,
  readRegularFile,
  readRegularFileSync,
  resolveRegularFileAppendFlags,
  statRegularFile,
  statRegularFileSync,
} from "@openclaw/fs-safe/advanced";
export {
  openLocalFileSafely,
  readLocalFileSafely,
  resolveOpenedFileRealPathForHandle,
  type OpenResult,
  type ReadResult,
} from "@openclaw/fs-safe/root";
export { sanitizeUntrustedFileName } from "./fs-safe-advanced.js";
export {
  readSecureFile,
  type SecureFileReadOptions,
  type SecureFileReadResult,
} from "@openclaw/fs-safe/secure-file";
export {
  walkDirectory,
  walkDirectorySync,
  type WalkDirectoryEntry,
  type WalkDirectoryOptions,
  type WalkDirectoryResult,
} from "@openclaw/fs-safe/walk";
export { withTimeout } from "@openclaw/fs-safe/advanced";

// The broad Plugin SDK infra barrel re-exports this facade. Keep fs-safe 0.5's
// new Root.walk capability core-only until a dedicated plugin contract is approved.
export type Root = Omit<FsSafeRoot, "walk">;

export async function root(rootDir: string, defaults?: RootDefaults): Promise<Root> {
  return await fsSafeRoot(rootDir, defaults);
}

export type ExternalFileWriteOptions = {
  rootDir: string;
  path: string;
  write: (tempPath: string) => Promise<void>;
  fallbackFileName?: string;
  tempPrefix?: string;
};

export type ExternalFileWriteResult = {
  path: string;
};

export async function ensureAbsoluteDirectory(
  dirPath: string,
  options?: { scopeLabel?: string; mode?: number },
): Promise<{ ok: true; path: string } | { ok: false; error: Error }> {
  const absolutePath = path.resolve(dirPath);
  const scopeLabel = options?.scopeLabel ?? "directory";
  const existingAncestor = await findExistingAncestor(absolutePath);
  if (!existingAncestor) {
    return { ok: false, error: new Error(`Invalid path: must stay within ${scopeLabel}`) };
  }
  if (existingAncestor === absolutePath) {
    try {
      const stat = await fs.lstat(absolutePath);
      if (!stat.isSymbolicLink() && stat.isDirectory()) {
        return { ok: true, path: absolutePath };
      }
    } catch {
      // Fall through to the uniform invalid-path result below.
    }
    return { ok: false, error: new Error(`Invalid path: must stay within ${scopeLabel}`) };
  }
  const result = await ensureDirectoryWithinRoot({
    rootDir: existingAncestor,
    requestedPath: path.relative(existingAncestor, absolutePath),
    scopeLabel,
    mode: options?.mode,
  });
  if (result.ok) {
    return result;
  }
  return { ok: false, error: new Error(result.error) };
}

export async function writeExternalFileWithinRoot(
  options: ExternalFileWriteOptions,
): Promise<ExternalFileWriteResult> {
  const requestedPath = path.resolve(options.rootDir, options.path);
  const result = await writeExternalFileWithinRootBase({
    rootDir: options.rootDir,
    path: options.path,
    write: (tempPath) => writeOwnedTempFile(tempPath, options.write),
    staging: "sibling",
    fallbackFileName: options.fallbackFileName ?? options.tempPrefix,
  });
  // Preserve the caller-facing path spelling while carrying forward any
  // portable basename selected by fs-safe (for example, /var vs /private/var).
  return { path: path.join(path.dirname(requestedPath), path.basename(result.path)) };
}

/** @deprecated Use root(rootDir).read(relativePath, options). */
export async function readFileWithinRoot(params: {
  rootDir: string;
  relativePath: string;
  rejectHardlinks?: boolean;
  nonBlockingRead?: boolean;
  allowSymlinkTargetWithinRoot?: boolean;
  maxBytes?: number;
}): Promise<ReadResult> {
  const fsRoot = await fsSafeRoot(params.rootDir);
  return await fsRoot.read(params.relativePath, {
    hardlinks: params.rejectHardlinks === false ? "allow" : "reject",
    maxBytes: params.maxBytes,
    nonBlockingRead: params.nonBlockingRead,
    symlinks: params.allowSymlinkTargetWithinRoot === true ? "follow-within-root" : "reject",
  });
}

/** @deprecated Use root(rootDir).write(relativePath, data, options). */
export async function writeFileWithinRoot(params: {
  rootDir: string;
  relativePath: string;
  data: string | Buffer;
  encoding?: BufferEncoding;
  mkdir?: boolean;
}): Promise<void> {
  const fsRoot = await fsSafeRoot(params.rootDir);
  await fsRoot.write(params.relativePath, params.data, {
    encoding: params.encoding,
    mkdir: params.mkdir,
  });
}

/**
 * Identity-bound deletion primitive: removes an immediate child directory within a validated
 * parent root only if its filesystem identity strictly matches expectedIdentity at the deletion effect.
 */
export async function removeChildDirectoryIfIdentityMatches(params: {
  parentRoot: Root;
  dirName: string;
  expectedIdentity: FileIdentityStat;
}): Promise<boolean> {
  const dirName = params.dirName;
  if (dirName.includes("/") || dirName.includes("\\") || dirName === "." || dirName === "..") {
    return false;
  }
  const parentReal = params.parentRoot.rootReal;
  const targetPath = path.join(parentReal, dirName);

  // Deletion primitive with identity enforcement at the final effect:
  // Verifies parent and child identity, executes any test hook in the post-validation/pre-removal
  // interval, and re-verifies child identity immediately at the deletion effect.
  try {
    const parentStat = fsSync.lstatSync(parentReal);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
      return false;
    }
    const currentStat = fsSync.lstatSync(targetPath);
    if (
      !currentStat.isDirectory() ||
      currentStat.isSymbolicLink() ||
      !sameFileIdentity(currentStat, params.expectedIdentity)
    ) {
      return false;
    }

    // Hook for testing replacement after validation and immediately before the deletion effect
    if (process.env.NODE_ENV === "test" || process.env.VITEST) {
      // SAFETY: test hook lookup on globalThis
      const globalDict = globalThis as Record<PropertyKey, unknown>;
      const rawHook =
        globalDict[Symbol.for("openclaw.fsSafeBeforeDeletionEffectHook")] ??
        globalDict[Symbol.for("openclaw.stagingCleanupBeforeRemovalHook")];
      const hook =
        typeof rawHook === "function"
          ? (rawHook as (path: string) => Promise<void>) // SAFETY: test hook callback assertion
          : undefined;
      if (hook) {
        await hook(targetPath);
      }
    }

    // Final-effect identity enforcement: ensures child entry still strictly matches expectedIdentity
    // immediately before rmdir, aborting deletion if a replacement occurred after validation.
    const finalStat = fsSync.lstatSync(targetPath);
    if (
      !finalStat.isDirectory() ||
      finalStat.isSymbolicLink() ||
      !sameFileIdentity(finalStat, params.expectedIdentity)
    ) {
      return false;
    }

    fsSync.rmdirSync(targetPath);
    return true;
  } catch {
    return false;
  }
}

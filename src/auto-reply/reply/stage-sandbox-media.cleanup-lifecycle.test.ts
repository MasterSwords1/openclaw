import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  getRegisteredStagingDirectoriesCount,
  registerProducedStagingDirectory,
  STAGED_INPUT_GITIGNORE,
} from "../../media/staged-inputs.js";
import {
  createSandboxMediaContexts,
  createSandboxMediaStageConfig,
  withSandboxMediaTempHome,
} from "../stage-sandbox-media.test-harness.js";
import { runPreparedReply } from "./get-reply-run.js";
import { getReplyFromConfig } from "./get-reply.js";
import {
  cleanHostWorkspaceStaging,
  completeFollowupRunLifecycle,
  type FollowupRun,
} from "./queue/types.js";
import { stageSandboxMedia } from "./stage-sandbox-media.js";

async function waitForPathAbsence(targetPath: string, timeoutMs = 2000): Promise<boolean> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    const exists = await fs
      .stat(targetPath)
      .then(() => true)
      .catch(() => false);
    if (!exists) {
      return true;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  return false;
}

async function waitForCondition(
  predicate: () => Promise<boolean>,
  timeoutMs = 2000,
): Promise<boolean> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    if (await predicate()) {
      return true;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  return false;
}

describe("stageSandboxMedia host staging lifecycle cleanup", () => {
  it("returns hostWorkspaceStagingDir and staged files remain readable after completeFollowupRunLifecycle (non-empty dir preserved)", async () => {
    await withSandboxMediaTempHome("staging-cleanup-test", async (home) => {
      const mediaDir = path.join(home, ".openclaw", "media", "inbound");
      await fs.mkdir(mediaDir, { recursive: true });
      const sampleFile = path.join(mediaDir, "sample.jpg");
      await fs.writeFile(sampleFile, "test-media-content");

      const mediaUri = `media://inbound/sample.jpg`;
      const { ctx, sessionCtx } = createSandboxMediaContexts(mediaUri);
      const cfg = {
        ...createSandboxMediaStageConfig(home),
        agents: {
          defaults: {
            sandbox: { mode: "off" },
          },
        },
      } as unknown as Parameters<typeof stageSandboxMedia>[0]["cfg"];
      const workspaceDir = path.join(home, "openclaw");

      const result = await stageSandboxMedia({
        ctx,
        sessionCtx,
        cfg,
        sessionKey: "session-1",
        workspaceDir,
      });

      expect(result.staged.size).toBe(1);
      expect(result.hostWorkspaceStagingDir).toBeDefined();

      const stagingDir = result.hostWorkspaceStagingDir!;
      expect(stagingDir).toContain("openclaw-staged-");

      // Verify staged file is readable before lifecycle
      const stagedFilePath = Array.from(result.staged.values())[0]!;
      const fileContent = await fs.readFile(stagedFilePath, "utf-8");
      expect(fileContent).toBe("test-media-content");

      const followupRun: Partial<FollowupRun> = {
        hostWorkspaceStagingDir: stagingDir,
      };

      // Lifecycle cleanup: non-empty dir is preserved (staged files serve subsequent turns)
      completeFollowupRunLifecycle(followupRun as unknown as FollowupRun);

      // Reference is cleared immediately
      expect(followupRun.hostWorkspaceStagingDir).toBeUndefined();

      // Non-empty staging directory must still exist — staged files are needed for transcript replay
      const exists = await waitForCondition(async () => {
        return await fs
          .stat(stagingDir)
          .then(() => true)
          .catch(() => false);
      });
      expect(exists).toBe(true);

      // The staged file itself must remain readable
      const afterContent = await fs.readFile(stagedFilePath, "utf-8");
      expect(afterContent).toBe("test-media-content");
    });
  });

  it("cleans up empty staging directory when all copies fail (producer-owned residue removed at source)", async () => {
    await withSandboxMediaTempHome("failed-copy-cleanup-test", async (home) => {
      const mediaDir = path.join(home, ".openclaw", "media", "inbound");
      await fs.mkdir(mediaDir, { recursive: true });
      // A directory at the attachment path makes the producer reach copyIn,
      // which can create an empty destination parent before rejecting it.
      const mediaUri = `media://inbound/missing.jpg`;
      await fs.mkdir(path.join(mediaDir, "missing.jpg"));
      const { ctx, sessionCtx } = createSandboxMediaContexts(mediaUri);
      const cfg = {
        ...createSandboxMediaStageConfig(home),
        agents: {
          defaults: {
            sandbox: { mode: "off" },
          },
        },
      } as unknown as Parameters<typeof stageSandboxMedia>[0]["cfg"];
      const workspaceDir = path.join(home, "openclaw");

      const result = await stageSandboxMedia({
        ctx,
        sessionCtx,
        cfg,
        sessionKey: "session-fail",
        workspaceDir,
      });

      // No successful stages → no cleanup owner exposed and no producer residue.
      expect(result.staged.size).toBe(0);
      expect(result.hostWorkspaceStagingDir).toBeUndefined();
      const stagingEntries = await fs
        .readdir(path.join(workspaceDir, "media", "inbound"))
        .catch(() => []);
      expect(stagingEntries.filter((entry) => entry.startsWith("openclaw-staged-")).length).toBe(0);
    });
  });

  it("cleans up staging directory when a turn is dropped directly on the active-run path", async () => {
    await withSandboxMediaTempHome("dropped-turn-cleanup-test", async (home) => {
      const mediaDir = path.join(home, ".openclaw", "media", "inbound");
      await fs.mkdir(mediaDir, { recursive: true });
      const sampleFile = path.join(mediaDir, "sample2.jpg");
      await fs.writeFile(sampleFile, "dropped-turn-media-content");

      const mediaUri = `media://inbound/sample2.jpg`;
      const { ctx, sessionCtx } = createSandboxMediaContexts(mediaUri);
      const cfg = {
        ...createSandboxMediaStageConfig(home),
        agents: {
          defaults: {
            sandbox: { mode: "off" },
          },
        },
      } as unknown as Parameters<typeof stageSandboxMedia>[0]["cfg"];
      const workspaceDir = path.join(home, "openclaw");

      const result = await stageSandboxMedia({
        ctx,
        sessionCtx,
        cfg,
        sessionKey: "session-2",
        workspaceDir,
      });

      const stagingDir = result.hostWorkspaceStagingDir!;
      expect(stagingDir).toBeDefined();

      const followupRun: Partial<FollowupRun> = {
        hostWorkspaceStagingDir: stagingDir,
      };

      completeFollowupRunLifecycle(followupRun as unknown as FollowupRun);

      // Reference cleared immediately on drop
      expect(followupRun.hostWorkspaceStagingDir).toBeUndefined();
      // Staged file content is preserved (drop does not delete file data)
      const stagedFilePath = Array.from(result.staged.values())[0]!;
      const content = await waitForCondition(async () => {
        const text = await fs.readFile(stagedFilePath, "utf-8").catch(() => null);
        return text === "dropped-turn-media-content";
      });
      expect(content).toBe(true);
    });
  });

  it("cleans up staging directory on direct non-queued reply completion without firing queue abandonment callbacks", async () => {
    await withSandboxMediaTempHome("direct-turn-cleanup-test", async (home) => {
      const mediaDir = path.join(home, ".openclaw", "media", "inbound");
      await fs.mkdir(mediaDir, { recursive: true });
      const sampleFile = path.join(mediaDir, "sample3.jpg");
      await fs.writeFile(sampleFile, "direct-turn-media-content");

      const mediaUri = `media://inbound/sample3.jpg`;
      const { ctx, sessionCtx } = createSandboxMediaContexts(mediaUri);
      const cfg = {
        ...createSandboxMediaStageConfig(home),
        agents: {
          defaults: {
            sandbox: { mode: "off" },
          },
        },
      } as unknown as Parameters<typeof stageSandboxMedia>[0]["cfg"];
      const workspaceDir = path.join(home, "openclaw");

      const result = await stageSandboxMedia({
        ctx,
        sessionCtx,
        cfg,
        sessionKey: "session-3",
        workspaceDir,
      });

      const stagingDir = result.hostWorkspaceStagingDir!;
      expect(stagingDir).toBeDefined();

      const onAbandoned = vi.fn();
      const followupRun: Partial<FollowupRun> = {
        hostWorkspaceStagingDir: stagingDir,
        turnAdoptionLifecycle: {
          onAdopted: vi.fn(),
          onAbandoned,
        } as unknown as FollowupRun["turnAdoptionLifecycle"],
      };

      // Direct cleanup (no queue involvement) clears the reference but preserves the file
      cleanHostWorkspaceStaging(followupRun as unknown as FollowupRun);

      expect(followupRun.hostWorkspaceStagingDir).toBeUndefined();
      expect(onAbandoned).not.toHaveBeenCalled();

      // Staged files are preserved — non-empty dir is not deleted
      const stagedFilePath = Array.from(result.staged.values())[0]!;
      const content = await waitForCondition(async () => {
        const text = await fs.readFile(stagedFilePath, "utf-8").catch(() => null);
        return text === "direct-turn-media-content";
      });
      expect(content).toBe(true);
    });
  });

  it("defers staging directory cleanup on pre-accepted message injection until active operation settlement", async () => {
    await withSandboxMediaTempHome("preaccepted-turn-cleanup-test", async (home) => {
      const mediaDir = path.join(home, ".openclaw", "media", "inbound");
      await fs.mkdir(mediaDir, { recursive: true });
      const sampleFile = path.join(home, ".openclaw", "media", "inbound", "sample4.jpg");
      await fs.writeFile(sampleFile, "preaccepted-turn-media-content");

      const mediaUri = `media://inbound/sample4.jpg`;
      const { ctx, sessionCtx } = createSandboxMediaContexts(mediaUri);
      const cfg = {
        ...createSandboxMediaStageConfig(home),
        agents: {
          defaults: {
            sandbox: { mode: "off" },
          },
        },
      } as unknown as Parameters<typeof stageSandboxMedia>[0]["cfg"];
      const workspaceDir = path.join(home, "openclaw");

      const result = await stageSandboxMedia({
        ctx,
        sessionCtx,
        cfg,
        sessionKey: "session-4",
        workspaceDir,
      });

      const stagingDir = result.hostWorkspaceStagingDir!;
      expect(stagingDir).toBeDefined();

      let resolveSettlement: (() => void) | undefined;
      const ownerSettlement = new Promise<void>((resolve) => {
        resolveSettlement = resolve;
      });

      const followupRun: Partial<FollowupRun> = {
        hostWorkspaceStagingDir: stagingDir,
      };

      // Simulate pre-accepted injection transferring staging ownership to ownerSettlement
      const hostStagingDir = followupRun.hostWorkspaceStagingDir;
      delete followupRun.hostWorkspaceStagingDir;
      void ownerSettlement.then(() => {
        completeFollowupRunLifecycle({ hostWorkspaceStagingDir: hostStagingDir } as FollowupRun);
      });

      // Staged file must still be readable before settlement
      const stagedFilePath = Array.from(result.staged.values())[0]!;
      const content = await fs.readFile(stagedFilePath, "utf-8");
      expect(content).toBe("preaccepted-turn-media-content");

      // Settle active operation — cleanup fires, but non-empty dir stays (files preserved)
      resolveSettlement!();
      await ownerSettlement;

      // Dir still exists because staging was successful (non-empty)
      const exists = await waitForCondition(async () => {
        return await fs
          .stat(stagingDir)
          .then(() => true)
          .catch(() => false);
      });
      expect(exists).toBe(true);
    });
  });

  it("cleans up staging directory on skipped reply turn admission preparation exit", async () => {
    await withSandboxMediaTempHome("skipped-admission-cleanup-test", async (home) => {
      const mediaDir = path.join(home, ".openclaw", "media", "inbound");
      await fs.mkdir(mediaDir, { recursive: true });
      const sampleFile = path.join(home, ".openclaw", "media", "inbound", "sample5.jpg");
      await fs.writeFile(sampleFile, "skipped-admission-media-content");

      const mediaUri = `media://inbound/sample5.jpg`;
      const { ctx, sessionCtx } = createSandboxMediaContexts(mediaUri);
      const cfg = {
        ...createSandboxMediaStageConfig(home),
        agents: {
          defaults: {
            sandbox: { mode: "off" },
          },
        },
      } as unknown as Parameters<typeof stageSandboxMedia>[0]["cfg"];
      const workspaceDir = path.join(home, "openclaw");

      const result = await stageSandboxMedia({
        ctx,
        sessionCtx,
        cfg,
        sessionKey: "session-5",
        workspaceDir,
      });

      const stagingDir = result.hostWorkspaceStagingDir!;
      expect(stagingDir).toBeDefined();

      const followupRun: Partial<FollowupRun> = {
        hostWorkspaceStagingDir: stagingDir,
      };

      completeFollowupRunLifecycle(followupRun as unknown as FollowupRun);

      expect(followupRun.hostWorkspaceStagingDir).toBeUndefined();
      // Staged files preserved even on skipped admission
      const stagedFilePath = Array.from(result.staged.values())[0]!;
      const content = await waitForCondition(async () => {
        const text = await fs.readFile(stagedFilePath, "utf-8").catch(() => null);
        return text === "skipped-admission-media-content";
      });
      expect(content).toBe(true);
    });
  });

  it("cleans up staging directory on prepared reply early admission / queue-state short-circuit", async () => {
    await withSandboxMediaTempHome("short-circuit-cleanup-test", async (home) => {
      const mediaDir = path.join(home, ".openclaw", "media", "inbound");
      await fs.mkdir(mediaDir, { recursive: true });
      const sampleFile = path.join(home, ".openclaw", "media", "inbound", "sample6.jpg");
      await fs.writeFile(sampleFile, "short-circuit-media-content");

      const mediaUri = `media://inbound/sample6.jpg`;
      const { ctx, sessionCtx } = createSandboxMediaContexts(mediaUri);
      const cfg = {
        ...createSandboxMediaStageConfig(home),
        agents: {
          defaults: {
            sandbox: { mode: "off" },
          },
        },
      } as unknown as Parameters<typeof stageSandboxMedia>[0]["cfg"];
      const workspaceDir = path.join(home, "openclaw");

      const result = await stageSandboxMedia({
        ctx,
        sessionCtx,
        cfg,
        sessionKey: "session-6",
        workspaceDir,
      });

      const stagingDir = result.hostWorkspaceStagingDir!;
      expect(stagingDir).toBeDefined();

      const runOpts: { hostWorkspaceStagingDir?: string } = {
        hostWorkspaceStagingDir: stagingDir,
      };

      // When prepareReplyRunContext returns kind: "reply" (e.g. empty body), runPreparedReply cleans staging opts
      const emptyReply = await runPreparedReply({
        ctx: { ...ctx, Body: "" },
        sessionCtx: { ...sessionCtx, Body: "", media: undefined, MediaPath: undefined },
        cfg,
        agentId: "main",
        agentDir: path.join(home, "agent"),
        agentCfg: (cfg as { agents?: { defaults?: unknown } }).agents?.defaults ?? {},
        sessionCfg: undefined,
        commandAuthorized: true,
        command: { commandBodyNormalized: "" },
        allowTextCommands: true,
        directives: {
          hasThinkDirective: false,
          hasVerboseDirective: false,
          hasFastDirective: false,
          hasReasoningDirective: false,
          hasElevatedDirective: false,
          hasExecDirective: false,
          hasModelDirective: false,
          hasQueueDirective: false,
          hasTraceDirective: false,
          hasStatusDirective: false,
        },
        defaultActivation: "always",
        resolvedThinkLevel: "off",
        typing: {
          cleanup: () => {},
          onReplyStart: async () => {},
        },
        opts: runOpts,
      } as unknown as Parameters<typeof runPreparedReply>[0]);

      expect(emptyReply).toBeDefined();
      // opts reference cleared after early exit (short-circuit path owns cleanup)
      expect(runOpts.hostWorkspaceStagingDir).toBeUndefined();
      // Staged files themselves are preserved
      const stagedFilePath = Array.from(result.staged.values())[0]!;
      const content = await fs.readFile(stagedFilePath, "utf-8").catch(() => null);
      expect(content).toBe("short-circuit-media-content");
    });
  });

  it("onHostStagingDelegated clears outer opts reference so post-handoff errors cannot delete active staged media", async () => {
    await withSandboxMediaTempHome("post-handoff-safety-test", async (home) => {
      const mediaDir = path.join(home, ".openclaw", "media", "inbound");
      await fs.mkdir(mediaDir, { recursive: true });
      const sampleFile = path.join(mediaDir, "sample.jpg");
      await fs.writeFile(sampleFile, "test-media-content");

      const mediaUri = `media://inbound/sample.jpg`;
      const { ctx, sessionCtx } = createSandboxMediaContexts(mediaUri);
      const cfg = {
        ...createSandboxMediaStageConfig(home),
        agents: {
          defaults: {
            sandbox: { mode: "off" },
          },
        },
      } as unknown as Parameters<typeof stageSandboxMedia>[0]["cfg"];
      const workspaceDir = path.join(home, "openclaw");

      const result = await stageSandboxMedia({
        ctx,
        sessionCtx,
        cfg,
        sessionKey: "session-handoff-test",
        workspaceDir,
      });

      const stagingDir = result.hostWorkspaceStagingDir!;
      expect(stagingDir).toBeDefined();

      // Model the exact shape wired in get-reply.ts
      const outerOpts: {
        hostWorkspaceStagingDir?: string;
        onHostStagingDelegated?: () => void;
      } = {
        hostWorkspaceStagingDir: stagingDir,
        onHostStagingDelegated: () => {
          delete outerOpts.hostWorkspaceStagingDir;
        },
      };

      // Simulate executePreparedReplyRun taking ownership and calling the handoff callback
      const followupRun: Partial<FollowupRun> = {
        hostWorkspaceStagingDir: outerOpts.hostWorkspaceStagingDir,
      };
      outerOpts.onHostStagingDelegated?.();

      // After handoff: outer reference is cleared, followupRun owns the dir
      expect(outerOpts.hostWorkspaceStagingDir).toBeUndefined();
      expect(followupRun.hostWorkspaceStagingDir).toBe(stagingDir);

      // Simulate a post-handoff error in the outer caller
      const caughtErr = await (async () => {
        try {
          if (outerOpts.hostWorkspaceStagingDir) {
            cleanHostWorkspaceStaging(outerOpts);
          }
          throw new Error("post-handoff error");
        } catch (err) {
          return err as Error;
        }
      })();
      expect(caughtErr.message).toBe("post-handoff error");

      // Staged file must still be readable — outer catch had no reference to delete it
      const stagedFilePath = Array.from(result.staged.values())[0]!;
      const content = await fs.readFile(stagedFilePath, "utf-8");
      expect(content).toBe("test-media-content");

      // Lifecycle owner can still clean up (empty-dir rmdir attempt on non-empty dir is a no-op)
      completeFollowupRunLifecycle(followupRun as unknown as FollowupRun);
      expect(followupRun.hostWorkspaceStagingDir).toBeUndefined();
      const afterContent = await fs.readFile(stagedFilePath, "utf-8");
      expect(afterContent).toBe("test-media-content");
    });
  });

  it("removes empty staging directory on prepared reply early admission / queue-state short-circuit exit", async () => {
    await withSandboxMediaTempHome("empty-short-circuit-cleanup-test", async (home) => {
      const workspaceDir = path.join(home, "openclaw");
      const emptyStagingDir = path.join(
        workspaceDir,
        "media",
        "inbound",
        "openclaw-staged-11111111-1111-4111-8111-111111111111",
      );
      await fs.mkdir(emptyStagingDir, { recursive: true });
      await fs.writeFile(path.join(emptyStagingDir, ".gitignore"), STAGED_INPUT_GITIGNORE);
      registerProducedStagingDirectory(emptyStagingDir);

      const runOpts: { hostWorkspaceStagingDir?: string } = {
        hostWorkspaceStagingDir: emptyStagingDir,
      };

      const cfg = {
        ...createSandboxMediaStageConfig(home),
        agents: {
          defaults: {
            sandbox: { mode: "off" },
          },
        },
      } as unknown as Parameters<typeof runPreparedReply>[0]["cfg"];

      const emptyReply = await runPreparedReply({
        ctx: { Body: "" },
        sessionCtx: { Body: "", media: undefined, MediaPath: undefined },
        cfg,
        agentId: "main",
        agentDir: path.join(home, "agent"),
        agentCfg: {},
        sessionCfg: undefined,
        commandAuthorized: true,
        command: { commandBodyNormalized: "" },
        allowTextCommands: true,
        directives: {
          hasThinkDirective: false,
          hasVerboseDirective: false,
          hasFastDirective: false,
          hasReasoningDirective: false,
          hasElevatedDirective: false,
          hasExecDirective: false,
          hasModelDirective: false,
          hasQueueDirective: false,
          hasTraceDirective: false,
          hasStatusDirective: false,
        },
        defaultActivation: "always",
        resolvedThinkLevel: "off",
        typing: {
          cleanup: () => {},
          onReplyStart: async () => {},
        },
        opts: runOpts,
      } as unknown as Parameters<typeof runPreparedReply>[0]);

      expect(emptyReply).toBeDefined();
      expect(runOpts.hostWorkspaceStagingDir).toBeUndefined();

      // The empty staging directory must be completely removed from disk
      const removed = await waitForPathAbsence(emptyStagingDir);
      expect(removed).toBe(true);
    });
  });

  it("carries hostWorkspaceStagingDir to queue lifecycle on optionless reply handoff", async () => {
    await withSandboxMediaTempHome("optionless-handoff-test", async (home) => {
      const mediaDir = path.join(home, ".openclaw", "media", "inbound");
      await fs.mkdir(mediaDir, { recursive: true });
      const sampleFile = path.join(mediaDir, "sample-optionless.jpg");
      await fs.writeFile(sampleFile, "optionless-media-content");

      const mediaUri = `media://inbound/sample-optionless.jpg`;
      const { ctx, sessionCtx } = createSandboxMediaContexts(mediaUri);
      const cfg = {
        ...createSandboxMediaStageConfig(home),
        agents: {
          defaults: {
            sandbox: { mode: "off" },
          },
        },
      } as unknown as Parameters<typeof stageSandboxMedia>[0]["cfg"];
      const workspaceDir = path.join(home, "openclaw");

      const stageResult = await stageSandboxMedia({
        ctx,
        sessionCtx,
        cfg,
        sessionKey: "session-optionless",
        workspaceDir,
      });

      const stagingDir = stageResult.hostWorkspaceStagingDir!;
      expect(stagingDir).toBeDefined();

      // When resolvedOpts is undefined (caller provided no opts), runner opts still inherits hostWorkspaceStagingDir
      let hostWorkspaceStagingDir: string | undefined = stageResult.hostWorkspaceStagingDir;
      const runnerOpts: {
        hostWorkspaceStagingDir?: string;
        onHostStagingDelegated?: () => void;
      } = {
        ...(hostWorkspaceStagingDir ? { hostWorkspaceStagingDir } : {}),
        onHostStagingDelegated: () => {
          hostWorkspaceStagingDir = undefined;
        },
      };

      expect(runnerOpts.hostWorkspaceStagingDir).toBe(stagingDir);

      const followupRun: Partial<FollowupRun> = {
        hostWorkspaceStagingDir: runnerOpts.hostWorkspaceStagingDir,
      };
      runnerOpts.onHostStagingDelegated?.();

      expect(hostWorkspaceStagingDir).toBeUndefined();
      expect(followupRun.hostWorkspaceStagingDir).toBe(stagingDir);

      // Settle lifecycle
      completeFollowupRunLifecycle(followupRun as unknown as FollowupRun);
      expect(followupRun.hostWorkspaceStagingDir).toBeUndefined();
    });
  });

  it("rejects foreign caller-supplied hostWorkspaceStagingDir in options and leaves foreign directory untouched", async () => {
    await withSandboxMediaTempHome("foreign-opts-rejection-test", async (home) => {
      const foreignDir = path.join(home, "foreign-user-dir");
      await fs.mkdir(foreignDir, { recursive: true });
      const userGitignore = path.join(foreignDir, ".gitignore");
      await fs.writeFile(userGitignore, "node_modules/\n.env\n");

      const runOpts: { hostWorkspaceStagingDir?: string } = {
        hostWorkspaceStagingDir: foreignDir,
      };

      const cfg = {
        ...createSandboxMediaStageConfig(home),
        agents: {
          defaults: {
            sandbox: { mode: "off" },
          },
        },
      } as unknown as Parameters<typeof runPreparedReply>[0]["cfg"];

      // Run an early return reply (e.g. empty body)
      const emptyReply = await runPreparedReply({
        ctx: { Body: "" },
        sessionCtx: { Body: "", media: undefined, MediaPath: undefined },
        cfg,
        agentId: "main",
        agentDir: path.join(home, "agent"),
        agentCfg: {},
        sessionCfg: undefined,
        commandAuthorized: true,
        command: { commandBodyNormalized: "" },
        allowTextCommands: true,
        directives: {
          hasThinkDirective: false,
          hasVerboseDirective: false,
          hasFastDirective: false,
          hasReasoningDirective: false,
          hasElevatedDirective: false,
          hasExecDirective: false,
          hasModelDirective: false,
          hasQueueDirective: false,
          hasTraceDirective: false,
          hasStatusDirective: false,
        },
        defaultActivation: "always",
        resolvedThinkLevel: "off",
        typing: {
          cleanup: () => {},
          onReplyStart: async () => {},
        },
        opts: runOpts,
      } as unknown as Parameters<typeof runPreparedReply>[0]);

      expect(emptyReply).toBeDefined();

      // Foreign directory and its contents must remain completely intact
      const foreignDirExists = await fs
        .stat(foreignDir)
        .then(() => true)
        .catch(() => false);
      expect(foreignDirExists).toBe(true);
      const gitignoreContent = await fs.readFile(userGitignore, "utf-8");
      expect(gitignoreContent).toBe("node_modules/\n.env\n");
    });
  });

  it("cleanHostWorkspaceStaging rejects non-staging directory names and non-marker .gitignore files", async () => {
    await withSandboxMediaTempHome("cleaner-validation-test", async (home) => {
      // 1. Non-staging directory name
      const nonStagingDir = path.join(home, "arbitrary-folder");
      await fs.mkdir(nonStagingDir, { recursive: true });
      await fs.writeFile(path.join(nonStagingDir, ".gitignore"), "*\n");

      cleanHostWorkspaceStaging({ hostWorkspaceStagingDir: nonStagingDir });

      const nonStagingExists = await fs
        .stat(nonStagingDir)
        .then(() => true)
        .catch(() => false);
      expect(nonStagingExists).toBe(true);

      // 2. Staging-shaped name but custom (non-marker) .gitignore
      const stagingDirWithCustomGitignore = path.join(
        home,
        "openclaw-staged-22222222-2222-4222-8222-222222222222",
      );
      await fs.mkdir(stagingDirWithCustomGitignore, { recursive: true });
      const customGitignorePath = path.join(stagingDirWithCustomGitignore, ".gitignore");
      await fs.writeFile(customGitignorePath, "build/\ndist/\n");

      cleanHostWorkspaceStaging({ hostWorkspaceStagingDir: stagingDirWithCustomGitignore });

      const customExists = await waitForCondition(async () => {
        return await fs
          .stat(stagingDirWithCustomGitignore)
          .then(() => true)
          .catch(() => false);
      });
      expect(customExists).toBe(true);
      const customContent = await fs.readFile(customGitignorePath, "utf-8");
      expect(customContent).toBe("build/\ndist/\n");

      // 3. Staging-shaped name with canonical marker but NOT producer-minted
      const unmintedStagingDir = path.join(
        home,
        "openclaw-staged-44444444-4444-4444-8444-444444444444",
      );
      await fs.mkdir(unmintedStagingDir, { recursive: true });
      const canonicalMarkerPath = path.join(unmintedStagingDir, ".gitignore");
      await fs.writeFile(canonicalMarkerPath, STAGED_INPUT_GITIGNORE);

      cleanHostWorkspaceStaging({ hostWorkspaceStagingDir: unmintedStagingDir });

      const unmintedExists = await waitForCondition(async () => {
        return await fs
          .stat(unmintedStagingDir)
          .then(() => true)
          .catch(() => false);
      });
      expect(unmintedExists).toBe(true);
      const markerStillExists = await fs
        .stat(canonicalMarkerPath)
        .then(() => true)
        .catch(() => false);
      expect(markerStillExists).toBe(true);
    });
  });

  it("getReplyFromConfig rejects caller-supplied hostWorkspaceStagingDir options even if shaped like UUID with canonical marker", async () => {
    await withSandboxMediaTempHome("public-opts-forged-test", async (home) => {
      const forgedDir = path.join(home, "openclaw-staged-55555555-5555-4555-8555-555555555555");
      await fs.mkdir(forgedDir, { recursive: true });
      const markerPath = path.join(forgedDir, ".gitignore");
      await fs.writeFile(markerPath, STAGED_INPUT_GITIGNORE);

      const cfg = {
        ...createSandboxMediaStageConfig(home),
        agents: {
          defaults: {
            sandbox: { mode: "off" },
          },
        },
      } as unknown as Parameters<typeof getReplyFromConfig>[2];

      const ctx = {
        Body: "test forged options",
        SessionKey: "forged-opts-session",
      } as Parameters<typeof getReplyFromConfig>[0];

      // Pass forged hostWorkspaceStagingDir via GetReplyOptions
      const opts = {
        hostWorkspaceStagingDir: forgedDir,
      } as unknown as Parameters<typeof getReplyFromConfig>[1];

      await getReplyFromConfig(ctx, opts, cfg).catch(() => {});

      // Forged directory must remain completely untouched
      const forgedExists = await waitForCondition(async () => {
        return await fs
          .stat(forgedDir)
          .then(() => true)
          .catch(() => false);
      });
      expect(forgedExists).toBe(true);
      const markerExists = await fs
        .stat(markerPath)
        .then(() => true)
        .catch(() => false);
      expect(markerExists).toBe(true);
    });
  });

  it("direct and non-auto-reply stageSandboxMedia callers do not leak registry entries", async () => {
    await withSandboxMediaTempHome("no-registry-leak-test", async (home) => {
      const initialCount = getRegisteredStagingDirectoriesCount();

      const mediaDir = path.join(home, ".openclaw", "media", "inbound");
      await fs.mkdir(mediaDir, { recursive: true });
      const sampleFile = path.join(mediaDir, "sample.jpg");
      await fs.writeFile(sampleFile, "sibling-media-content");

      const mediaUri = `media://inbound/sample.jpg`;
      const { ctx, sessionCtx } = createSandboxMediaContexts(mediaUri);
      const cfg = {
        ...createSandboxMediaStageConfig(home),
        agents: {
          defaults: {
            sandbox: { mode: "off" },
          },
        },
      } as unknown as Parameters<typeof stageSandboxMedia>[0]["cfg"];
      const workspaceDir = path.join(home, "openclaw");

      // Repeatedly stage through non-auto-reply caller
      for (let i = 0; i < 5; i++) {
        const { ctx, sessionCtx } = createSandboxMediaContexts(mediaUri);
        const result = await stageSandboxMedia({
          ctx,
          sessionCtx,
          cfg,
          sessionKey: `sibling-session-${i}`,
          workspaceDir,
        });
        expect(result.hostWorkspaceStagingDir).toBeDefined();
      }

      // No entries should be added to the registry
      expect(getRegisteredStagingDirectoriesCount()).toBe(initialCount);
    });
  });
});

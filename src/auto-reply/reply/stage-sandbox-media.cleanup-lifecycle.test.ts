import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createSandboxMediaContexts,
  createSandboxMediaStageConfig,
  withSandboxMediaTempHome,
} from "../stage-sandbox-media.test-harness.js";
import { runPreparedReply } from "./get-reply-run.js";
import {
  cleanHostWorkspaceStaging,
  completeFollowupRunLifecycle,
  type FollowupRun,
} from "./queue/types.js";
import { stageSandboxMedia } from "./stage-sandbox-media.js";

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

      // Allow the async rmdir attempt to settle
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 50);
      });

      // Non-empty staging directory must still exist — staged files are needed for transcript replay
      const exists = await fs
        .stat(stagingDir)
        .then(() => true)
        .catch(() => false);
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
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 50);
      });
      const stagedFilePath = Array.from(result.staged.values())[0]!;
      const content = await fs.readFile(stagedFilePath, "utf-8").catch(() => null);
      expect(content).toBe("dropped-turn-media-content");
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
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 50);
      });
      const stagedFilePath = Array.from(result.staged.values())[0]!;
      const content = await fs.readFile(stagedFilePath, "utf-8").catch(() => null);
      expect(content).toBe("direct-turn-media-content");
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
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 50);
      });

      // Dir still exists because staging was successful (non-empty)
      const exists = await fs
        .stat(stagingDir)
        .then(() => true)
        .catch(() => false);
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
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 50);
      });
      const stagedFilePath = Array.from(result.staged.values())[0]!;
      const content = await fs.readFile(stagedFilePath, "utf-8").catch(() => null);
      expect(content).toBe("skipped-admission-media-content");
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
});

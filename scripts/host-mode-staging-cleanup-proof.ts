import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { getReplyFromConfig } from "../src/auto-reply/reply/get-reply.js";
import { createSandboxMediaContexts } from "../src/auto-reply/stage-sandbox-media.test-harness.js";
import {
  clearConfigCache,
  clearRuntimeConfigSnapshot,
  type OpenClawConfig,
} from "../src/config/config.js";
import {
  disconnectGatewayClient,
  startGatewayWithClient,
} from "../src/gateway/test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "../src/gateway/test-openai-responses-model.js";
import { captureEnv, setTestEnvValue } from "../src/test-utils/env.js";

const envKeys = [
  "HOME",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_GATEWAY_TOKEN",
  "OPENCLAW_SKIP_CHANNELS",
  "OPENCLAW_SKIP_GMAIL_WATCHER",
  "OPENCLAW_SKIP_CRON",
  "OPENCLAW_SKIP_CANVAS_HOST",
  "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER",
  "OPENCLAW_SKIP_PROVIDERS",
  "OPENCLAW_BUNDLED_PLUGINS_DIR",
  "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
] as const;

function writeAssistantSseResponse(res: ServerResponse, text: string): void {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const message = {
    type: "message",
    id: "proof-message-id",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  res.end(
    [
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { ...message, status: "in_progress", content: [] },
      },
      { type: "response.output_item.done", output_index: 0, item: message },
      {
        type: "response.completed",
        response: {
          status: "completed",
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        },
      },
    ]
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .concat("data: [DONE]\n\n")
      .join(""),
  );
}

async function waitForStagingDirCount(
  dir: string,
  expectedCount: number,
  timeoutMs = 2000,
): Promise<string[]> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    try {
      const entries = await fs.readdir(dir);
      const stagingDirs = entries.filter((e) => e.startsWith("openclaw-staged-"));
      if (stagingDirs.length === expectedCount) {
        return stagingDirs;
      }
    } catch {
      // Directory doesn't exist yet
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  }
  const entries = await fs.readdir(dir).catch(() => []);
  return entries.filter((e) => e.startsWith("openclaw-staged-"));
}

async function runHostModeStagingCleanupProof(): Promise<void> {
  console.log("=== Host-Mode Staging Media Cleanup Proof (Failed Copy Scenario) ===");

  const envSnapshot = captureEnv([...envKeys]);
  let tempHome: string | undefined;
  let providerServer: ReturnType<typeof createServer> | undefined;
  let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;

  try {
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-host-staging-cleanup-proof-"));
    const stateDir = path.join(tempHome, ".openclaw");
    const workspaceDir = path.join(tempHome, "workspace");
    const configPath = path.join(stateDir, "openclaw.json");
    const mediaDir = path.join(stateDir, "media", "inbound");

    await Promise.all([
      fs.mkdir(workspaceDir, { recursive: true }),
      fs.mkdir(mediaDir, { recursive: true }),
      fs.mkdir(path.dirname(configPath), { recursive: true }),
    ]);

    for (const [key, value] of Object.entries({
      HOME: tempHome,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_GATEWAY_TOKEN: "proof-gateway-token-128454",
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_GMAIL_WATCHER: "1",
      OPENCLAW_SKIP_CRON: "1",
      OPENCLAW_SKIP_CANVAS_HOST: "1",
      OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
      OPENCLAW_SKIP_PROVIDERS: "1",
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    })) {
      setTestEnvValue(key, value);
    }

    // Setup local mock HTTP model server
    providerServer = createServer((_req, res) => {
      writeAssistantSseResponse(res, "I analyzed the inbound media attachment.");
    });

    await new Promise<void>((resolve, reject) => {
      providerServer?.once("error", reject);
      providerServer?.listen(0, "127.0.0.1", resolve);
    });

    const providerAddress = providerServer.address();
    if (!providerAddress || typeof providerAddress === "string") {
      throw new Error("Proof provider did not bind a loopback port");
    }
    const provider = buildMockOpenAiResponsesProvider(
      `http://127.0.0.1:${providerAddress.port}/v1`,
    );
    provider.config.models[0].input = ["text", "image"];

    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          skipBootstrap: true,
          sandbox: { mode: "off" },
          model: { primary: provider.modelRef },
          models: {
            [provider.modelRef]: { params: { transport: "sse", openaiWsWarmup: false } },
          },
        },
        entries: { main: { default: true } },
      },
      models: { mode: "replace", providers: { [provider.providerId]: provider.config } },
      gateway: { auth: { mode: "token", token: "proof-gateway-token-128454" } },
    };

    console.log("\n[1/4] Starting real Gateway server in host mode (sandbox: off)...");
    gateway = await startGatewayWithClient({
      cfg,
      configPath,
      token: "proof-gateway-token-128454",
      clientDisplayName: "proof-client-host-staging-cleanup",
    });

    const workspaceMediaInbound = path.join(workspaceDir, "media", "inbound");

    // ================================================================
    // SCENARIO: Failed copy - empty staging directory cleanup
    // ================================================================
    console.log("\n[2/4] Scenario: Failed copy triggers empty staging directory cleanup...");
    const sessionKey = "agent:main:proof-session-host-staging-cleanup";
    // Use a DIRECTORY at the attachment path as the source. It resolves to a real
    // media reference (so staging reaches copyIn) but copyIn cannot read a
    // directory as a file stream, so it creates the empty host staging directory
    // and then the failed-copy owner removes it. A non-existent URI instead
    // resolves to no source and is skipped before any directory exists, which
    // would make the zero-dir assertion vacuous (this is the prior bug).
    const failedDirName = "prof-dir-128454-cleanup";
    const failedDirPath = path.join(mediaDir, failedDirName);
    await fs.mkdir(failedDirPath);
    const mediaUri = `media://inbound/${failedDirName}`;
    const { ctx } = createSandboxMediaContexts(mediaUri);
    ctx.media = [{ ...ctx.media?.[0], contentType: "image/png" }];
    ctx.Body = "Please inspect this attached image";
    ctx.SessionKey = sessionKey;

    const replyPromise = getReplyFromConfig(ctx, undefined, cfg);

    // The failed copy creates the empty staging directory synchronously inside
    // copyIn and the failed-copy owner removes it before the reply settles, so
    // it is usually gone before this poll can observe it. The observation below
    // is best-effort; the post-settlement zero-count is the authoritative
    // cleanup assertion. (The create-then-clean mechanism is deterministic in
    // src/auto-reply/reply/stage-sandbox-media.cleanup-lifecycle.test.ts.)
    const preStagingDirs = await waitForStagingDirCount(workspaceMediaInbound, 1, 2000);
    console.log(
      `  -> Pre-settlement staging directories: count=${preStagingDirs.length} (best-effort; empty dir created by failed copy, remove may win the race)`,
    );

    // Await settlement - copy fails, staging dir should be cleaned up
    await replyPromise;
    console.log("  -> Auto-reply settled (with failed copy).");

    // Verify empty staging directory was cleaned up
    const postStagingDirs = await waitForStagingDirCount(workspaceMediaInbound, 0, 1000);
    console.log(
      `  -> Post-settlement staging directories: count=${postStagingDirs.length} (expected=0, empty dir cleaned up)`,
    );
    assert.equal(
      postStagingDirs.length,
      0,
      "Empty staging directory from failed copy should be cleaned up",
    );

    // ================================================================
    // SCENARIO 2: Mixed success/failure - only empty dirs cleaned
    // ================================================================
    console.log("\n[3/4] Scenario: Mixed success/failure - empty dirs cleaned, retained kept...");

    // First, successful staging
    const PNG_1X1 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=";
    const sampleFileName = "proof-sample.png";
    const sampleFilePath = path.join(mediaDir, sampleFileName);
    await fs.writeFile(sampleFilePath, Buffer.from(PNG_1X1, "base64"));

    const ctxSuccess = createSandboxMediaContexts(`media://inbound/${sampleFileName}`);
    ctxSuccess.ctx.media = [{ ...ctxSuccess.ctx.media?.[0], contentType: "image/png" }];
    ctxSuccess.ctx.Body = "Please inspect this attached image";
    ctxSuccess.ctx.SessionKey = "agent:main:proof-session-host-success";

    const successPromise = getReplyFromConfig(ctxSuccess.ctx, undefined, cfg);

    // Wait for successful staging
    const successStagingDirs = await waitForStagingDirCount(workspaceMediaInbound, 1, 1000);
    console.log(`  -> After successful staging: count=${successStagingDirs.length}`);

    // Then, failed staging via a directory source (resolves to a real reference
    // and reaches copyIn, which fails reading the directory as a file and leaves
    // an empty staging directory for the failed-copy owner to clean).
    const mixedFailedDirName = "prof-dir-128454-mixed";
    await fs.mkdir(path.join(mediaDir, mixedFailedDirName));
    const ctxFailure = createSandboxMediaContexts(`media://inbound/${mixedFailedDirName}`);
    ctxFailure.ctx.media = [{ ...ctxFailure.ctx.media?.[0], contentType: "image/png" }];
    ctxFailure.ctx.Body = "Please inspect this attached image";
    ctxFailure.ctx.SessionKey = "agent:main:proof-session-host-failure";

    const failurePromise = getReplyFromConfig(ctxFailure.ctx, undefined, cfg);

    // Wait for both to settle
    await Promise.all([successPromise, failurePromise]);

    // Give cleanup time
    await new Promise((resolve) => {
      setTimeout(resolve, 500);
    });

    const finalStagingDirs = await waitForStagingDirCount(workspaceMediaInbound, 1, 1000);
    console.log(
      `  -> Final staging directories: count=${finalStagingDirs.length} (expected=1, empty dir cleaned)`,
    );
    assert.equal(
      finalStagingDirs.length,
      1,
      "Only the successful staging directory should remain after both settlements",
    );

    // Verify the remaining directory is non-empty
    const remainingDir = path.join(workspaceMediaInbound, finalStagingDirs[0]!);
    const remainingFiles = await fs.readdir(remainingDir);
    assert.ok(remainingFiles.length >= 1, "Remaining directory should contain files");
    console.log(
      `  -> Remaining directory contains ${remainingFiles.length} file(s): ${remainingFiles.join(", ")}`,
    );

    // Clean up gateway
    await disconnectGatewayClient(gateway.client);
    await gateway.server.close({ reason: "Proof complete" });
    gateway = undefined;

    console.log(
      "\n[4/4] Cleanup verification: Empty staging directories removed, persisted media retained.",
    );
    console.log("\n=== Production Host-Mode Staging Cleanup Proof Execution Complete: SUCCESS ===");
  } finally {
    if (gateway) {
      await disconnectGatewayClient(gateway.client);
      await gateway.server.close({ reason: "Proof complete" });
    }
    if (providerServer) {
      providerServer.close();
    }
    clearConfigCache();
    clearRuntimeConfigSnapshot();
    envSnapshot.restore();
    if (tempHome) {
      await fs.rm(tempHome, { recursive: true, force: true });
    }
  }
}

runHostModeStagingCleanupProof().catch((err: unknown) => {
  console.error("Proof Execution Failed:", err);
  process.exit(1);
});

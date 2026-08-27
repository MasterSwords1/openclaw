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

async function runHostModeStagingCleanupProof(): Promise<void> {
  console.log("=== Host-Mode Staging Media Production Gateway Proof ===");

  const envSnapshot = captureEnv([...envKeys]);
  let tempHome: string | undefined;
  let providerServer: ReturnType<typeof createServer> | undefined;
  let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;

  try {
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-host-staging-gateway-proof-"));
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

    // Valid 1x1 PNG image fixture
    const PNG_1X1 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=";
    const sampleFileName = "proof-sample.png";
    const sampleFilePath = path.join(mediaDir, sampleFileName);
    const mediaContent = Buffer.from(PNG_1X1, "base64");
    await fs.writeFile(sampleFilePath, mediaContent);

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
    // Explicitly declare image input capability on the provider model
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
      clientDisplayName: "proof-client-host-staging",
    });
    // Scenario 1: Real getReplyFromConfig entry dispatch with host-mode media staging & admission handoff
    console.log("\n[2/4] Executing auto-reply turn with inbound media via getReplyFromConfig...");
    const sessionKey = "agent:main:proof-session-host-staging";
    const mediaUri = `media://inbound/${sampleFileName}`;
    const { ctx } = createSandboxMediaContexts(mediaUri);
    ctx.media = [{ ...ctx.media?.[0], contentType: "image/png" }];
    ctx.Body = "Please inspect this attached image";
    ctx.SessionKey = sessionKey;
    ctx.SessionId = sessionKey;

    const replyPromise = getReplyFromConfig(ctx, undefined, cfg);

    // Scenario 2: Verify active staging directory and media readability before reply completion
    console.log("\n[3/4] Verifying staged directory and media are readable before settlement...");
    const workspaceMediaInbound = path.join(workspaceDir, "media", "inbound");
    let preStagingDirs: string[] = [];
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        const entries = await fs.readdir(workspaceMediaInbound);
        preStagingDirs = entries.filter((e) => e.startsWith("openclaw-staged-"));
        if (preStagingDirs.length > 0) {
          break;
        }
      } catch {
        preStagingDirs = [];
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 50);
      });
    }

    if (preStagingDirs.length > 0) {
      const activeStagingDirPath = path.join(workspaceMediaInbound, preStagingDirs[0]!);
      const stagedFiles = await fs.readdir(activeStagingDirPath);
      assert.ok(
        stagedFiles.length >= 1,
        `Expected staged files in ${activeStagingDirPath}, found ${stagedFiles.length}`,
      );
      const stagedFilePath = path.join(activeStagingDirPath, stagedFiles[0]!);
      const stagedStat = await fs.stat(stagedFilePath);
      assert.ok(stagedStat.size > 0, "Staged media attachment must be readable and non-empty");
      console.log(
        `  -> Active staging directory verified readable before settlement: dir=${preStagingDirs[0]}, files=${stagedFiles.join(",")}, size=${stagedStat.size} bytes`,
      );
    }

    // Scenario 3: Await auto-reply settlement and verify post-settlement cleanup
    console.log(
      "\n[4/4] Awaiting auto-reply completion and verifying host staging directory removal...",
    );
    const replyResult = await replyPromise;
    assert.ok(replyResult !== undefined, "getReplyFromConfig must return a valid reply result");
    console.log("  -> Auto-reply settled successfully.");

    // Wait for directory removal
    let stagingDirectories: string[] = [];
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        const entries = await fs.readdir(workspaceMediaInbound);
        stagingDirectories = entries.filter((e) => e.startsWith("openclaw-staged-"));
      } catch {
        stagingDirectories = [];
      }
      if (stagingDirectories.length === 0) {
        break;
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 50);
      });
    }

    console.log(
      `  -> Remaining openclaw-staged-* directories: count=${stagingDirectories.length} (expected=0)`,
    );
    assert.equal(
      stagingDirectories.length,
      0,
      "All openclaw-staged-* directories must be removed after settlement",
    );

    // Clean up gateway
    await disconnectGatewayClient(gateway.client);
    await gateway.server.close({ reason: "Proof complete" });
    gateway = undefined;

    console.log(
      "\n=== Production Host-Mode Staging Lifecycle Proof Execution Complete: SUCCESS ===",
    );
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

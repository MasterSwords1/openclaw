// Process regression coverage for ACP help commands returning without loading runtime transports.
import {
  execFile,
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { ACP_RUNTIME_INFO } from "../acp/runtime-info.js";

const execFileAsync = promisify(execFile);
const CHILD_PROCESS_TIMEOUT_MS = 30_000;

const INITIALIZE_FRAME = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    },
  },
};

function createAcpProcessEnv(stateDir?: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_ENV: undefined,
    NODE_OPTIONS: "--use-openssl-ca",
    NODE_USE_SYSTEM_CA: "0",
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    OPENCLAW_CONFIG_PATH: stateDir ? path.join(stateDir, "openclaw.json") : undefined,
    OPENCLAW_NO_RESPAWN: "1",
    OPENCLAW_STATE_DIR: stateDir,
    VITEST: undefined,
  };
}

function waitForExit(child: ChildProcessWithoutNullStreams) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

function waitForJsonLine(child: ChildProcessWithoutNullStreams, id: number) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    let stdout = "";
    const timeout = setTimeout(
      () => reject(new Error("timed out waiting for ACP response")),
      CHILD_PROCESS_TIMEOUT_MS,
    );
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      reject(new Error(`ACP process exited before response (code=${code}, signal=${signal})`));
    };
    const finish = (response: Record<string, unknown>) => {
      clearTimeout(timeout);
      child.off("exit", onExit);
      child.stdout.off("data", onData);
      resolve(response);
    };

    child.once("exit", onExit);
    const onData = (chunk: Buffer) => {
      stdout += chunk.toString();
      const lines = stdout.split("\n");
      stdout = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }
        const response = JSON.parse(line) as Record<string, unknown>;
        if (response.id === id) {
          finish(response);
          return;
        }
      }
    };
    child.stdout.on("data", onData);
  });
}

function requestJsonLine(
  child: ChildProcessWithoutNullStreams,
  request: { id: number; method: string; params: Record<string, unknown> },
) {
  const response = waitForJsonLine(child, request.id);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...request })}\n`);
  return response;
}

describe("ACP CLI process exit", () => {
  it("flushes the runtime contract to piped stdout before exiting", async () => {
    const result = await execFileAsync(
      process.execPath,
      ["--import", "tsx", "src/entry.ts", "acp", "info"],
      {
        cwd: path.resolve("."),
        encoding: "utf8",
        env: createAcpProcessEnv(),
        killSignal: "SIGKILL",
        timeout: CHILD_PROCESS_TIMEOUT_MS,
      },
    );

    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(`${JSON.stringify(ACP_RUNTIME_INFO)}\n`);
  });

  it.each([
    { args: ["acp", "--help"], usage: "Usage: openclaw acp [options] [command]" },
    { args: ["acp", "client", "--help"], usage: "Usage: openclaw acp client [options]" },
    { args: ["acp", "info", "--help"], usage: "Usage: openclaw acp info [options]" },
  ])(
    "exits promptly after $args",
    async ({ args, usage }) => {
      const result = await execFileAsync(
        process.execPath,
        ["--import", "tsx", "src/entry.ts", ...args],
        {
          cwd: path.resolve("."),
          encoding: "utf8",
          env: {
            ...createAcpProcessEnv(),
            NODE_OPTIONS: process.platform === "darwin" ? "--use-system-ca" : undefined,
            NODE_USE_SYSTEM_CA: undefined,
          },
          killSignal: "SIGKILL",
          timeout: CHILD_PROCESS_TIMEOUT_MS,
        },
      );

      expect(result.stderr).toBe("");
      expect(result.stdout).toContain(usage);
    },
    CHILD_PROCESS_TIMEOUT_MS + 5_000,
  );

  it.each([
    { name: "empty stdin", input: "" },
    {
      name: "an initialize frame",
      input: `${JSON.stringify(INITIALIZE_FRAME)}\n`,
    },
  ])("exits when the bridge starts with $name and the client disconnects", ({ input }) => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "src/entry.ts", "acp", "--require-existing"],
      {
        cwd: path.resolve("."),
        encoding: "utf8",
        env: createAcpProcessEnv(),
        input,
        killSignal: "SIGKILL",
        timeout: CHILD_PROCESS_TIMEOUT_MS,
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("processes an initialize frame written immediately after spawn", async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), "openclaw-acp-exit-"));
    let child: ChildProcessWithoutNullStreams | undefined;

    try {
      child = spawn(process.execPath, ["--import", "tsx", "src/entry.ts", "acp"], {
        cwd: path.resolve("."),
        env: createAcpProcessEnv(stateDir),
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      const exitPromise = waitForExit(child);
      const responsePromise = waitForJsonLine(child, INITIALIZE_FRAME.id);

      // The direct stdio runtime must retain frames written while its local
      // config and state stores are still initializing.
      child.stdin.write(`${JSON.stringify(INITIALIZE_FRAME)}\n`);
      const response = await responsePromise;
      expect(response).toMatchObject({
        jsonrpc: "2.0",
        id: INITIALIZE_FRAME.id,
        result: { protocolVersion: INITIALIZE_FRAME.params.protocolVersion },
      });

      child.stdin.end();
      const exit = await exitPromise;
      expect(exit).toEqual({ code: 0, signal: null });
      expect(stderr).toBe("");
    } finally {
      child?.kill("SIGKILL");
      rmSync(stateDir, { force: true, recursive: true });
    }
  }, 40_000);

  it("runs concurrent stdio agents against one local state directory", async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), "openclaw-acp-concurrent-"));
    const children = Array.from({ length: 2 }, () =>
      spawn(process.execPath, ["--import", "tsx", "src/entry.ts", "acp"], {
        cwd: path.resolve("."),
        env: createAcpProcessEnv(stateDir),
        stdio: ["pipe", "pipe", "pipe"],
      }),
    );
    const stderr = ["", ""];
    children.forEach((child, index) => {
      child.stderr.on("data", (chunk: Buffer) => {
        stderr[index] += chunk.toString();
      });
    });

    try {
      const initialized = await Promise.all(
        children.map((child, index) =>
          requestJsonLine(child, {
            id: index + 1,
            method: "initialize",
            params: INITIALIZE_FRAME.params,
          }),
        ),
      );
      for (const response of initialized) {
        expect(response).toMatchObject({
          result: { protocolVersion: INITIALIZE_FRAME.params.protocolVersion },
        });
      }

      const sessions = await Promise.all(
        children.map((child, index) =>
          requestJsonLine(child, {
            id: index + 10,
            method: "session/new",
            params: { cwd: stateDir, mcpServers: [] },
          }),
        ),
      );
      const sessionIds = sessions.map((response) => {
        const result = response.result as { sessionId?: unknown } | undefined;
        expect(typeof result?.sessionId).toBe("string");
        return String(result?.sessionId);
      });
      expect(new Set(sessionIds).size).toBe(sessionIds.length);

      const exits = children.map(waitForExit);
      children.forEach((child) => child.stdin.end());
      await expect(Promise.all(exits)).resolves.toEqual([
        { code: 0, signal: null },
        { code: 0, signal: null },
      ]);
      expect(stderr).toEqual(["", ""]);
    } finally {
      children.forEach((child) => child.kill("SIGKILL"));
      rmSync(stateDir, { force: true, recursive: true });
    }
  }, 60_000);
});

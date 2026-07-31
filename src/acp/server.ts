#!/usr/bin/env node
/** Self-contained ACP stdio server backed by the process-local OpenClaw agent runtime. */
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  AGENT_METHODS,
  AgentSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type Agent,
  type AnyMessage,
} from "@agentclientprotocol/sdk";
import type { AcpServerOptions } from "@openclaw/acp-core/types";
import { isMainModule } from "../infra/is-main.js";
import { routeLogsToStderr } from "../logging/console.js";
import { closeOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { AcpAgent } from "./agent.js";
import { createSqliteAcpEventLedger } from "./event-ledger.js";
import { normalizeAcpProvenanceMode } from "./types.js";

type JsonObject = Record<string, unknown>;

type AcpRuntimeAgent = Agent & {
  start?: () => void;
  shutdown: (reason?: unknown) => Promise<void>;
};

export type AcpServerDependencies = {
  input?: ReadableStream<Uint8Array>;
  output?: WritableStream<Uint8Array>;
  createAgent?: (connection: AgentSideConnection, options: AcpServerOptions) => AcpRuntimeAgent;
  closeStateDatabase?: () => void;
  ownStateDatabase?: boolean;
  closeTransport?: () => void;
  installSignalHandlers?: boolean;
};

/** Starts the self-contained ACP agent and serves it over stdio. */
export async function serveAcp(
  opts: AcpServerOptions = {},
  deps: AcpServerDependencies = {},
): Promise<void> {
  routeLogsToStderr();

  const input =
    deps.input ?? (Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>);
  const output = deps.output ?? Writable.toWeb(process.stdout);
  const stream = ndJsonStream(output, input);
  let inputEndedNormally = false;
  const readable = stream.readable.pipeThrough(
    new TransformStream<AnyMessage, AnyMessage>({
      transform(message, controller) {
        controller.enqueue(normalizeAcpInitializeProtocolVersion(message));
      },
      flush() {
        inputEndedNormally = true;
      },
    }),
  );

  let agent: AcpRuntimeAgent | undefined;
  let shutdownPromise: Promise<void> | undefined;
  let resolveClosed!: () => void;
  let rejectClosed!: (error: unknown) => void;
  const closed = new Promise<void>((resolve, reject) => {
    resolveClosed = resolve;
    rejectClosed = reject;
  });
  const closeStateDatabase =
    deps.closeStateDatabase ?? (deps.ownStateDatabase ? closeOpenClawStateDatabase : undefined);
  let stateDatabaseClosed = false;
  const closeOwnedStateDatabase = () => {
    if (!closeStateDatabase || stateDatabaseClosed) {
      return;
    }
    stateDatabaseClosed = true;
    try {
      closeStateDatabase();
    } catch (error) {
      console.warn(`acp: state database close failed during shutdown: ${String(error)}`);
    }
  };
  const shutdown = (reason?: unknown, fatalReason?: unknown) => {
    shutdownPromise ??= (async () => {
      let shutdownError = fatalReason;
      try {
        await agent?.shutdown(reason);
      } catch (error) {
        if (shutdownError === undefined) {
          shutdownError = error;
        } else {
          console.warn(`acp: shutdown cleanup failed: ${String(error)}`);
        }
      } finally {
        closeOwnedStateDatabase();
        if (shutdownError !== undefined) {
          rejectClosed(shutdownError);
        } else {
          resolveClosed();
        }
      }
      if (shutdownError !== undefined) {
        throw shutdownError;
      }
    })();
    return shutdownPromise;
  };
  const requestShutdown = (reason?: unknown, fatalReason?: unknown) => {
    void shutdown(reason, fatalReason).catch(() => {
      // `closed` carries the same failure to the serveAcp caller.
    });
  };

  let connection: AgentSideConnection;
  try {
    connection = new AgentSideConnection(
      (conn: AgentSideConnection) => {
        agent =
          deps.createAgent?.(conn, opts) ??
          new AcpAgent(conn, {
            ...opts,
            eventLedger: createSqliteAcpEventLedger(),
          });
        agent.start?.();
        return agent;
      },
      { ...stream, readable },
    );
  } catch (error) {
    try {
      await agent?.shutdown(error);
    } catch (shutdownError) {
      console.warn(`acp: startup cleanup failed: ${String(shutdownError)}`);
    } finally {
      closeOwnedStateDatabase();
    }
    throw error;
  }

  const onSignal = () => {
    try {
      (deps.closeTransport ?? (() => process.stdin.destroy()))();
    } catch (error) {
      console.warn(`acp: stdio close failed during shutdown: ${String(error)}`);
    }
    requestShutdown(new Error("ACP process shutting down"));
  };
  const installSignalHandlers = deps.installSignalHandlers !== false;
  if (installSignalHandlers) {
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  }

  void connection.closed.then(() => {
    // ACP SDK 1.3 resolves `closed` for EOF and stream errors alike. The
    // transform flush is the stable distinction; abort reasons are not.
    const reason = inputEndedNormally
      ? undefined
      : (connection.signal.reason ?? new Error("ACP transport closed unexpectedly"));
    requestShutdown(reason, reason);
  });

  try {
    await closed;
  } finally {
    if (installSignalHandlers) {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    }
  }
}

export function normalizeAcpInitializeProtocolVersion(message: AnyMessage): AnyMessage {
  if (!isJsonObject(message) || message.method !== AGENT_METHODS.initialize) {
    return message;
  }
  const params = message.params;
  if (!isJsonObject(params) || isUint16Integer(params.protocolVersion)) {
    return message;
  }
  return {
    ...message,
    params: {
      ...params,
      protocolVersion: PROTOCOL_VERSION,
    },
  } as AnyMessage;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUint16Integer(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffff;
}

function parseArgs(args: string[]): AcpServerOptions {
  const opts: AcpServerOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--session") {
      opts.defaultSessionKey = args[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--session-label") {
      opts.defaultSessionLabel = args[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--require-existing") {
      opts.requireExistingSession = true;
      continue;
    }
    if (arg === "--reset-session") {
      opts.resetSession = true;
      continue;
    }
    if (arg === "--no-prefix-cwd") {
      opts.prefixCwd = false;
      continue;
    }
    if (arg === "--provenance") {
      const provenanceMode = normalizeAcpProvenanceMode(args[index + 1]);
      if (!provenanceMode) {
        throw new Error("Invalid --provenance value. Use off, meta, or meta+receipt.");
      }
      opts.provenanceMode = provenanceMode;
      index += 1;
      continue;
    }
    if (arg === "--verbose" || arg === "-v") {
      opts.verbose = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  return opts;
}

function printHelp(): void {
  console.log(`Usage: openclaw acp [options]

Self-contained OpenClaw ACP server for IDE and agent-host integration.

Options:
  --session <key>         Default session key (e.g. "agent:main:main")
  --session-label <label> Default session label to resolve
  --require-existing      Fail if the session key/label does not exist
  --reset-session         Reset the session key before first use
  --no-prefix-cwd         Do not prefix prompts with the working directory
  --provenance <mode>     ACP provenance mode: off, meta, or meta+receipt
  --verbose, -v           Verbose logging to stderr
  --help, -h              Show this help message
`);
}

if (isMainModule({ currentFile: fileURLToPath(import.meta.url) })) {
  const opts = parseArgs(process.argv.slice(2));
  serveAcp(opts, { ownStateDatabase: true }).catch((error: unknown) => {
    console.error(String(error));
    process.exit(1);
  });
}

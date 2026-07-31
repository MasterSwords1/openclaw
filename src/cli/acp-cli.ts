// Commander registration for the self-contained ACP agent and interactive client.
import type { Command } from "commander";
import { formatDocsLink } from "../../packages/terminal-core/src/links.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import { ACP_RUNTIME_INFO } from "../acp/runtime-info.js";
import { normalizeAcpProvenanceMode } from "../acp/types.js";
import { formatErrorMessage } from "../infra/errors.js";
import { defaultRuntime } from "../runtime.js";
import { inheritOptionFromParent } from "./command-options.js";

export function registerAcpCli(program: Command) {
  const acp = program.command("acp").description("Run OpenClaw as a self-contained ACP agent");

  acp
    .option("--session <key>", "Default session key (e.g. agent:main:main)")
    .option("--session-label <label>", "Default session label to resolve")
    .option("--require-existing", "Fail if the session key/label does not exist", false)
    .option("--reset-session", "Reset the session key before first use", false)
    .option("--no-prefix-cwd", "Do not prefix prompts with the working directory")
    .option("--provenance <mode>", "ACP provenance mode: off, meta, or meta+receipt")
    .option("--configure-model", "Configure model authentication and exit", false)
    .option("-v, --verbose", "Verbose logging to stderr", false)
    .addHelpText(
      "after",
      () => `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/acp", "docs.openclaw.ai/cli/acp")}\n`,
    )
    .action(async (opts) => {
      try {
        if (opts.configureModel) {
          const { configureCommandFromSectionsArg } = await import("../commands/configure.js");
          await configureCommandFromSectionsArg(["model"], defaultRuntime);
          return;
        }
        const provenanceMode = normalizeAcpProvenanceMode(opts.provenance as string | undefined);
        if (opts.provenance && !provenanceMode) {
          throw new Error('Invalid --provenance. Use "off", "meta", or "meta+receipt".');
        }
        const { serveAcp } = await import("../acp/server.js");
        await serveAcp(
          {
            defaultSessionKey: opts.session as string | undefined,
            defaultSessionLabel: opts.sessionLabel as string | undefined,
            requireExistingSession: Boolean(opts.requireExisting),
            resetSession: Boolean(opts.resetSession),
            prefixCwd: opts.prefixCwd !== false,
            provenanceMode,
            verbose: Boolean(opts.verbose),
          },
          { ownStateDatabase: true },
        );
      } catch (err) {
        defaultRuntime.error(`ACP agent failed: ${formatErrorMessage(err)}`);
        defaultRuntime.exit(1);
      }
    });

  acp
    .command("info")
    .description("Print the ACP runtime contract as JSON")
    .action(() => {
      defaultRuntime.writeJson(ACP_RUNTIME_INFO, 0);
    });

  acp
    .command("client")
    .description("Run an interactive ACP client against the local ACP agent")
    .option("--cwd <dir>", "Working directory for the ACP session")
    .option("--server <command>", "ACP server command (default: openclaw)")
    .option("--server-args <args...>", "Extra arguments for the ACP server")
    .option("--server-verbose", "Enable verbose logging on the ACP server", false)
    .option("-v, --verbose", "Verbose client logging", false)
    .action(async (opts, command) => {
      const inheritedVerbose = inheritOptionFromParent<boolean>(command, "verbose");
      try {
        const { runAcpClientInteractive } = await import("../acp/client.js");
        await runAcpClientInteractive({
          cwd: opts.cwd as string | undefined,
          serverCommand: opts.server as string | undefined,
          serverArgs: opts.serverArgs as string[] | undefined,
          serverVerbose: Boolean(opts.serverVerbose),
          verbose: Boolean(opts.verbose || inheritedVerbose),
        });
      } catch (err) {
        defaultRuntime.error(formatErrorMessage(err));
        defaultRuntime.exit(1);
      }
    });
}

// ACP CLI option tests cover the self-contained agent and interactive client boundaries.
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ACP_RUNTIME_INFO } from "../acp/runtime-info.js";
import { runRegisteredCli } from "../test-utils/command-runner.js";
import { registerAcpCli } from "./acp-cli.js";

type AcpClientOptions = {
  verbose?: boolean;
};

type AcpServerOptions = {
  defaultSessionKey?: string;
  defaultSessionLabel?: string;
  prefixCwd?: boolean;
  provenanceMode?: string;
  requireExistingSession?: boolean;
  resetSession?: boolean;
  verbose?: boolean;
};

const mocks = vi.hoisted(() => ({
  configureCommandFromSectionsArg: vi.fn(async (_sections: string[], _runtime: unknown) => {}),
  runAcpClientInteractive: vi.fn(async (_opts: AcpClientOptions) => {}),
  serveAcp: vi.fn(async (_opts: AcpServerOptions, _deps?: { ownStateDatabase?: boolean }) => {}),
  defaultRuntime: {
    log: vi.fn(),
    error: vi.fn(),
    writeStdout: vi.fn(),
    writeJson: vi.fn(),
    exit: vi.fn(),
  },
}));

const { configureCommandFromSectionsArg, runAcpClientInteractive, serveAcp, defaultRuntime } =
  mocks;

vi.mock("../commands/configure.js", () => ({
  configureCommandFromSectionsArg: (sections: string[], runtime: unknown) =>
    mocks.configureCommandFromSectionsArg(sections, runtime),
}));

vi.mock("../acp/client.js", () => ({
  runAcpClientInteractive: (opts: AcpClientOptions) => mocks.runAcpClientInteractive(opts),
}));

vi.mock("../acp/server.js", () => ({
  serveAcp: (opts: AcpServerOptions, deps?: { ownStateDatabase?: boolean }) =>
    mocks.serveAcp(opts, deps),
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: mocks.defaultRuntime,
}));

describe("acp cli options", () => {
  function createAcpProgram() {
    const program = new Command();
    registerAcpCli(program);
    return program;
  }

  async function parseAcp(args: string[]) {
    const program = createAcpProgram();
    await program.parseAsync(["acp", ...args], { from: "user" });
  }

  function requireFirstMockArg(mock: { mock: { calls: ReadonlyArray<ReadonlyArray<unknown>> } }) {
    const call = mock.mock.calls[0];
    if (!call) {
      throw new Error("expected mock to have at least one call");
    }
    return call[0];
  }

  beforeEach(() => {
    configureCommandFromSectionsArg.mockClear();
    runAcpClientInteractive.mockClear();
    serveAcp.mockClear();
    defaultRuntime.log.mockClear();
    defaultRuntime.error.mockClear();
    defaultRuntime.writeStdout.mockClear();
    defaultRuntime.writeJson.mockClear();
    defaultRuntime.exit.mockClear();
  });

  it("forwards --verbose to `acp client` when parent and child option names collide", async () => {
    await runRegisteredCli({
      register: registerAcpCli as (program: Command) => void,
      argv: ["acp", "client", "--verbose"],
    });

    expect(runAcpClientInteractive).toHaveBeenCalledTimes(1);
    const clientOptions = requireFirstMockArg(runAcpClientInteractive) as AcpClientOptions;
    expect(clientOptions.verbose).toBe(true);
  });

  it("starts the self-contained ACP agent with local session options", async () => {
    await parseAcp([
      "--session",
      "agent:main:main",
      "--session-label",
      "buzz",
      "--require-existing",
      "--reset-session",
      "--no-prefix-cwd",
      "--provenance",
      "meta+receipt",
      "--verbose",
    ]);

    expect(serveAcp).toHaveBeenCalledWith(
      {
        defaultSessionKey: "agent:main:main",
        defaultSessionLabel: "buzz",
        requireExistingSession: true,
        resetSession: true,
        prefixCwd: false,
        provenanceMode: "meta+receipt",
        verbose: true,
      },
      { ownStateDatabase: true },
    );
  });

  it("defaults to prefixing the working directory", async () => {
    await parseAcp([]);

    expect(serveAcp).toHaveBeenCalledTimes(1);
    const serverOptions = requireFirstMockArg(serveAcp) as AcpServerOptions;
    expect(serverOptions.prefixCwd).toBe(true);
  });

  it("reports the self-contained runtime contract without starting the agent", async () => {
    await parseAcp(["info"]);

    expect(defaultRuntime.writeJson).toHaveBeenCalledWith(ACP_RUNTIME_INFO, 0);
    expect(serveAcp).not.toHaveBeenCalled();
  });

  it("runs the canonical model setup flow for terminal authentication", async () => {
    await parseAcp(["--configure-model"]);

    expect(configureCommandFromSectionsArg).toHaveBeenCalledWith(["model"], defaultRuntime);
    expect(serveAcp).not.toHaveBeenCalled();
  });

  it("rejects invalid provenance without starting the agent", async () => {
    await parseAcp(["--provenance", "gateway"]);

    expect(serveAcp).not.toHaveBeenCalled();
    expect(defaultRuntime.error).toHaveBeenCalledWith(
      expect.stringContaining('Invalid --provenance. Use "off", "meta", or "meta+receipt".'),
    );
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
  });

  it("formats client errors with formatErrorMessage instead of String(err) (#83904)", async () => {
    runAcpClientInteractive.mockImplementationOnce(async () => {
      throw { code: 42, why: "boom" } as unknown as Error;
    });
    const program = createAcpProgram();
    await program.parseAsync(["acp", "client"], { from: "user" });

    const errors = defaultRuntime.error.mock.calls.map(([message]) => String(message));
    expect(errors).toContain('{"code":42,"why":"boom"}');
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
  });
});

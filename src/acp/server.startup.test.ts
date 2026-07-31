/** Tests the process-local ACP stdio lifecycle. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => {
  let resolveClosed: (() => void) | undefined;
  let closeController: AbortController | undefined;
  let transportController: ReadableStreamDefaultController<unknown> | undefined;
  return {
    agentSideConnectionCtor: vi.fn(),
    closeConnection: () => {
      transportController?.close();
    },
    failConnection: (error: unknown) => {
      transportController?.error(error);
    },
    finishConnection: (error: unknown) => {
      closeController?.abort(error);
      resolveClosed?.();
    },
    createTransportReadable: () =>
      new ReadableStream({
        start(controller) {
          transportController = controller;
        },
      }),
    resetConnection: () => {
      closeController = new AbortController();
      const closed = new Promise<void>((resolve) => {
        resolveClosed = resolve;
      });
      return { closed, signal: closeController.signal };
    },
    routeLogsToStderr: vi.fn(),
    closeStateDatabase: vi.fn(),
  };
});

vi.mock("@agentclientprotocol/sdk", () => ({
  AGENT_METHODS: {
    initialize: "initialize",
  },
  AgentSideConnection: function AgentSideConnection(
    factory: (connection: unknown) => unknown,
    stream: unknown,
  ) {
    mockState.agentSideConnectionCtor(factory, stream);
    factory({});
    const lifecycle = mockState.resetConnection();
    void (stream as { readable: ReadableStream }).readable.pipeTo(new WritableStream()).then(
      () => mockState.finishConnection(new Error("ACP connection closed")),
      (error) => mockState.finishConnection(error),
    );
    return lifecycle;
  },
  PROTOCOL_VERSION: 1,
  ndJsonStream: vi.fn(() => ({
    writable: new WritableStream(),
    readable: mockState.createTransportReadable(),
  })),
}));

vi.mock("../infra/is-main.js", () => ({
  isMainModule: () => false,
}));

vi.mock("../logging/console.js", () => ({
  routeLogsToStderr: () => mockState.routeLogsToStderr(),
}));

vi.mock("../state/openclaw-state-db.js", () => ({
  closeOpenClawStateDatabase: () => mockState.closeStateDatabase(),
}));

describe("serveAcp", () => {
  beforeEach(() => {
    mockState.agentSideConnectionCtor.mockClear();
    mockState.closeStateDatabase.mockClear();
    mockState.routeLogsToStderr.mockClear();
  });

  it("leaves the process-global state database to an embedding host", async () => {
    const { serveAcp } = await import("./server.js");
    const serve = serveAcp(
      {},
      {
        input: new ReadableStream(),
        output: new WritableStream(),
        createAgent: () => ({ shutdown: vi.fn(async () => {}) }) as never,
        installSignalHandlers: false,
      },
    );

    mockState.closeConnection();
    await serve;

    expect(mockState.closeStateDatabase).not.toHaveBeenCalled();
  });

  it("constructs and starts the local agent without waiting for an external runtime", async () => {
    const { serveAcp } = await import("./server.js");
    const start = vi.fn();
    const shutdown = vi.fn(async () => {});
    const closeStateDatabase = vi.fn();
    const serve = serveAcp(
      {},
      {
        input: new ReadableStream(),
        output: new WritableStream(),
        createAgent: () => ({ start, shutdown }) as never,
        closeStateDatabase,
        installSignalHandlers: false,
      },
    );

    expect(mockState.agentSideConnectionCtor).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
    expect(shutdown).not.toHaveBeenCalled();

    mockState.closeConnection();
    await serve;

    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(closeStateDatabase).toHaveBeenCalledTimes(1);
  });

  it("shuts down a partially started agent and closes owned state on startup failure", async () => {
    const { serveAcp } = await import("./server.js");
    const error = new Error("local agent failed to start");
    const shutdown = vi.fn(async (_reason?: unknown) => {});
    const closeStateDatabase = vi.fn();

    await expect(
      serveAcp(
        {},
        {
          input: new ReadableStream(),
          output: new WritableStream(),
          createAgent: () =>
            ({
              start: () => {
                throw error;
              },
              shutdown,
            }) as never,
          closeStateDatabase,
          installSignalHandlers: false,
        },
      ),
    ).rejects.toBe(error);

    expect(shutdown).toHaveBeenCalledWith(error);
    expect(closeStateDatabase).toHaveBeenCalledTimes(1);
  });

  it("waits for local agent shutdown before closing the state database", async () => {
    const { serveAcp } = await import("./server.js");
    let resolveShutdown!: () => void;
    const shutdown = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveShutdown = resolve;
        }),
    );
    const closeStateDatabase = vi.fn();
    const serve = serveAcp(
      {},
      {
        input: new ReadableStream(),
        output: new WritableStream(),
        createAgent: () => ({ shutdown }) as never,
        closeStateDatabase,
        installSignalHandlers: false,
      },
    );

    mockState.closeConnection();
    await vi.waitFor(() => expect(shutdown).toHaveBeenCalledTimes(1));
    expect(closeStateDatabase).not.toHaveBeenCalled();

    resolveShutdown();
    await serve;
    expect(closeStateDatabase).toHaveBeenCalledTimes(1);
  });

  it("passes connection failures to local agent shutdown", async () => {
    const { serveAcp } = await import("./server.js");
    const shutdown = vi.fn(async (_reason?: unknown) => {});
    const serve = serveAcp(
      {},
      {
        input: new ReadableStream(),
        output: new WritableStream(),
        createAgent: () => ({ shutdown }) as never,
        closeStateDatabase: vi.fn(),
        installSignalHandlers: false,
      },
    );
    const error = new Error("stdio closed unexpectedly");

    mockState.failConnection(error);
    await expect(serve).rejects.toBe(error);

    expect(shutdown).toHaveBeenCalledWith(error);
  });

  it("propagates local agent shutdown failures after closing state", async () => {
    const { serveAcp } = await import("./server.js");
    const error = new Error("local shutdown failed");
    const closeStateDatabase = vi.fn();
    const serve = serveAcp(
      {},
      {
        input: new ReadableStream(),
        output: new WritableStream(),
        createAgent: () =>
          ({
            shutdown: vi.fn(async () => {
              throw error;
            }),
          }) as never,
        closeStateDatabase,
        installSignalHandlers: false,
      },
    );

    mockState.closeConnection();

    await expect(serve).rejects.toBe(error);
    expect(closeStateDatabase).toHaveBeenCalledTimes(1);
  });
});

describe("normalizeAcpInitializeProtocolVersion", () => {
  it("normalizes invalid initialize protocol versions only", async () => {
    const { normalizeAcpInitializeProtocolVersion } = await import("./server.js");
    expect(
      normalizeAcpInitializeProtocolVersion({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "latest", clientCapabilities: {} },
      } as never),
    ).toMatchObject({
      params: { protocolVersion: 1 },
    });
    expect(
      normalizeAcpInitializeProtocolVersion({
        jsonrpc: "2.0",
        id: 2,
        method: "session/new",
        params: { protocolVersion: "latest" },
      } as never),
    ).toMatchObject({
      params: { protocolVersion: "latest" },
    });
  });
});

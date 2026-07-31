import fs from "node:fs/promises";
import path from "node:path";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";

const QA_TEMP_ROOT_ENV = "OPENCLAW_QA_TEMP_ROOT";
const DESCRIPTOR_FILE = "discord-endpoint-runtime.json";
const originalTempRoot = process.env[QA_TEMP_ROOT_ENV];
const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

async function writeDescriptor(
  tempRoot: string,
  value: unknown = {
    apiRoot: "http://127.0.0.1:43123/api",
    gatewayBotUrl: "http://127.0.0.1:43123/api/v10/gateway/bot",
    version: 1,
  },
) {
  await fs.writeFile(path.join(tempRoot, DESCRIPTOR_FILE), `${JSON.stringify(value)}\n`, {
    mode: 0o600,
  });
}

afterEach(() => {
  if (originalTempRoot === undefined) {
    delete process.env[QA_TEMP_ROOT_ENV];
  } else {
    process.env[QA_TEMP_ROOT_ENV] = originalTempRoot;
  }
  fetchWithSsrFGuardMock.mockReset();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("Discord endpoint runtime", () => {
  it("preserves the live REST default when no private descriptor exists", async () => {
    await withTempDir("discord-endpoint-runtime-", async (tempRoot) => {
      process.env[QA_TEMP_ROOT_ENV] = tempRoot;
      const { RequestClient } = await import("./internal/rest.js");

      expect(new RequestClient("token").options.baseUrl).toBe("https://discord.com/api");
    });
  });

  it("routes REST through an owner-only loopback descriptor", async () => {
    await withTempDir("discord-endpoint-runtime-", async (tempRoot) => {
      await writeDescriptor(tempRoot);
      process.env[QA_TEMP_ROOT_ENV] = tempRoot;
      const { resolveDiscordEndpointRuntime } = await import("./endpoint-runtime.js");
      const { RequestClient } = await import("./internal/rest.js");

      expect(resolveDiscordEndpointRuntime()).toEqual({
        apiRoot: "http://127.0.0.1:43123/api",
        gatewayBotUrl: "http://127.0.0.1:43123/api/v10/gateway/bot",
      });
      expect(new RequestClient("token").options.baseUrl).toBe("http://127.0.0.1:43123/api");
      expect(
        new RequestClient("token", { baseUrl: "https://example.test/api" }).options.baseUrl,
      ).toBe("https://example.test/api");
    });
  });

  it("rejects descriptors that carry credentials or non-loopback endpoints", async () => {
    await withTempDir("discord-endpoint-runtime-", async (tempRoot) => {
      process.env[QA_TEMP_ROOT_ENV] = tempRoot;
      await writeDescriptor(tempRoot, {
        apiRoot: "https://discord.com/api",
        botToken: "must-not-be-staged",
        gatewayBotUrl: "https://discord.com/api/v10/gateway/bot",
        version: 1,
      });
      const { resolveDiscordEndpointRuntime } = await import("./endpoint-runtime.js");

      expect(() => resolveDiscordEndpointRuntime()).toThrow(
        "Discord endpoint runtime descriptor has an unsupported shape",
      );
    });
  });

  it.runIf(process.platform !== "win32")(
    "rejects descriptors readable by another local user",
    async () => {
      await withTempDir("discord-endpoint-runtime-", async (tempRoot) => {
        await writeDescriptor(tempRoot);
        await fs.chmod(path.join(tempRoot, DESCRIPTOR_FILE), 0o644);
        process.env[QA_TEMP_ROOT_ENV] = tempRoot;
        const { resolveDiscordEndpointRuntime } = await import("./endpoint-runtime.js");

        expect(() => resolveDiscordEndpointRuntime()).toThrow(
          "Discord endpoint runtime descriptor must be owner-only",
        );
      });
    },
  );

  it("allows only the provider API and its matching loopback Gateway", async () => {
    await withTempDir("discord-endpoint-runtime-", async (tempRoot) => {
      await writeDescriptor(tempRoot);
      process.env[QA_TEMP_ROOT_ENV] = tempRoot;
      const release = vi.fn(async () => {});
      fetchWithSsrFGuardMock.mockResolvedValue({
        response: new Response("{}"),
        release,
      });
      const {
        assertDiscordEndpointGatewayUrl,
        createDiscordEndpointFetch,
        resolveDiscordEndpointRuntime,
      } = await import("./endpoint-runtime.js");
      const endpoint = resolveDiscordEndpointRuntime();
      if (!endpoint) {
        throw new Error("expected injected Discord endpoint");
      }

      const response = await createDiscordEndpointFetch(endpoint)(
        "http://127.0.0.1:43123/api/v10/users/@me",
      );
      await response.text();
      expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith({
        url: "http://127.0.0.1:43123/api/v10/users/@me",
        init: undefined,
        maxRedirects: 0,
        policy: { allowedHostnames: ["127.0.0.1"], allowPrivateNetwork: true },
        auditContext: "discord.injected-endpoint",
      });
      expect(release).toHaveBeenCalledTimes(1);
      await expect(
        createDiscordEndpointFetch(endpoint)("https://discord.com/api/v10/users/@me"),
      ).rejects.toThrow("rejected a non-provider URL");
      expect(() =>
        assertDiscordEndpointGatewayUrl(endpoint, "ws://127.0.0.1:43123/gateway?v=10"),
      ).not.toThrow();
      expect(() =>
        assertDiscordEndpointGatewayUrl(endpoint, "wss://gateway.discord.gg/?v=10"),
      ).toThrow("invalid Gateway WebSocket URL");
    });
  });

  it("preserves Request method, headers, body, and signal", async () => {
    await withTempDir("discord-endpoint-runtime-", async (tempRoot) => {
      await writeDescriptor(tempRoot);
      process.env[QA_TEMP_ROOT_ENV] = tempRoot;
      const release = vi.fn(async () => {});
      let forwardedBody = "";
      fetchWithSsrFGuardMock.mockImplementation(async ({ init }: { init?: RequestInit }) => {
        forwardedBody = init?.body ? await new Response(init.body).text() : "";
        return { response: new Response("{}"), release };
      });
      const { createDiscordEndpointFetch, resolveDiscordEndpointRuntime } =
        await import("./endpoint-runtime.js");
      const endpoint = resolveDiscordEndpointRuntime();
      if (!endpoint) {
        throw new Error("expected injected Discord endpoint");
      }
      const controller = new AbortController();
      const request = new Request("http://127.0.0.1:43123/api/v10/channels/123/messages", {
        method: "POST",
        headers: {
          authorization: "Bot local-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ content: "hello" }),
        signal: controller.signal,
      });

      const response = await createDiscordEndpointFetch(endpoint)(request);
      await response.text();

      const guardedRequest = fetchWithSsrFGuardMock.mock.calls[0]?.[0] as
        | { init?: RequestInit & { duplex?: string }; url?: string }
        | undefined;
      expect(guardedRequest?.url).toBe(request.url);
      expect(guardedRequest?.init?.method).toBe("POST");
      expect(new Headers(guardedRequest?.init?.headers).get("authorization")).toBe(
        "Bot local-token",
      );
      controller.abort();
      expect(guardedRequest?.init?.signal?.aborted).toBe(true);
      expect(guardedRequest?.init?.duplex).toBe("half");
      expect(forwardedBody).toBe('{"content":"hello"}');
      expect(release).toHaveBeenCalledTimes(1);
    });
  });
});

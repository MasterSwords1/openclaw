// Discord plugin module owns the private QA endpoint injection boundary.
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";

const QA_TEMP_ROOT_ENV = "OPENCLAW_QA_TEMP_ROOT";
const DISCORD_ENDPOINT_RUNTIME_FILE = "discord-endpoint-runtime.json";
const DISCORD_ENDPOINT_RUNTIME_MAX_BYTES = 4 * 1024;

type DiscordEndpointRuntime = {
  apiRoot: string;
  gatewayBotUrl: string;
};

type RequestInitWithDuplex = RequestInit & { duplex?: "half" };

type DiscordEndpointRuntimeState =
  | { resolved: false }
  | { resolved: true; endpoint?: DiscordEndpointRuntime };

let endpointRuntimeState: DiscordEndpointRuntimeState = { resolved: false };

function isMissingPathError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function parseLoopbackHttpUrl(value: unknown, label: string): URL {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Discord endpoint runtime ${label} must be a non-empty URL.`);
  }
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    (url.hostname !== "127.0.0.1" && url.hostname !== "[::1]") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(`Discord endpoint runtime ${label} must be a plain loopback HTTP URL.`);
  }
  return url;
}

function parseDiscordEndpointRuntime(raw: string): DiscordEndpointRuntime {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error("Discord endpoint runtime descriptor contains invalid JSON.", { cause: error });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Discord endpoint runtime descriptor must be an object.");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).toSorted();
  if (record.version !== 1 || keys.join(",") !== "apiRoot,gatewayBotUrl,version") {
    throw new Error("Discord endpoint runtime descriptor has an unsupported shape.");
  }
  const apiRoot = parseLoopbackHttpUrl(record.apiRoot, "apiRoot");
  const gatewayBotUrl = parseLoopbackHttpUrl(record.gatewayBotUrl, "gatewayBotUrl");
  if (
    apiRoot.pathname !== "/api" ||
    gatewayBotUrl.origin !== apiRoot.origin ||
    gatewayBotUrl.pathname !== `${apiRoot.pathname}/v10/gateway/bot`
  ) {
    throw new Error("Discord endpoint runtime URLs do not match the local provider contract.");
  }
  return {
    apiRoot: apiRoot.toString().replace(/\/$/u, ""),
    gatewayBotUrl: gatewayBotUrl.toString(),
  };
}

function readDiscordEndpointRuntimeDescriptor(
  tempRoot: string,
): DiscordEndpointRuntime | undefined {
  const resolvedRoot = path.resolve(tempRoot);
  const descriptorPath = path.join(resolvedRoot, DISCORD_ENDPOINT_RUNTIME_FILE);
  let descriptorStat: ReturnType<typeof lstatSync>;
  try {
    descriptorStat = lstatSync(descriptorPath);
  } catch (error) {
    if (isMissingPathError(error)) {
      return undefined;
    }
    throw error;
  }
  if (!descriptorStat.isFile() || descriptorStat.isSymbolicLink()) {
    throw new Error("Discord endpoint runtime descriptor must be a regular file.");
  }
  if (process.platform !== "win32") {
    if ((descriptorStat.mode & 0o077) !== 0) {
      throw new Error("Discord endpoint runtime descriptor must be owner-only.");
    }
    if (typeof process.getuid === "function" && descriptorStat.uid !== process.getuid()) {
      throw new Error("Discord endpoint runtime descriptor must be owned by the current user.");
    }
  }
  if (descriptorStat.size > DISCORD_ENDPOINT_RUNTIME_MAX_BYTES) {
    throw new Error("Discord endpoint runtime descriptor is too large.");
  }

  const canonicalRoot = realpathSync(resolvedRoot);
  const canonicalDescriptor = realpathSync(descriptorPath);
  if (path.dirname(canonicalDescriptor) !== canonicalRoot) {
    throw new Error("Discord endpoint runtime descriptor escapes the QA runtime root.");
  }

  const descriptorFd = openSync(descriptorPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const openedStat = fstatSync(descriptorFd);
    if (
      !openedStat.isFile() ||
      openedStat.size > DISCORD_ENDPOINT_RUNTIME_MAX_BYTES ||
      openedStat.dev !== descriptorStat.dev ||
      openedStat.ino !== descriptorStat.ino ||
      (process.platform !== "win32" &&
        ((openedStat.mode & 0o077) !== 0 ||
          (typeof process.getuid === "function" && openedStat.uid !== process.getuid())))
    ) {
      throw new Error("Discord endpoint runtime descriptor changed while opening.");
    }
    return parseDiscordEndpointRuntime(readFileSync(descriptorFd, "utf8"));
  } finally {
    closeSync(descriptorFd);
  }
}

export function resolveDiscordEndpointRuntime(): DiscordEndpointRuntime | undefined {
  if (endpointRuntimeState.resolved) {
    return endpointRuntimeState.endpoint;
  }
  const tempRoot = process.env[QA_TEMP_ROOT_ENV]?.trim();
  const endpoint = tempRoot ? readDiscordEndpointRuntimeDescriptor(tempRoot) : undefined;
  endpointRuntimeState = { resolved: true, ...(endpoint ? { endpoint } : {}) };
  return endpoint;
}

function resolveEndpointFetchUrl(
  endpoint: DiscordEndpointRuntime,
  input: string | URL | Request,
): URL {
  const url = new URL(
    typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
  );
  const apiRoot = new URL(endpoint.apiRoot);
  if (
    url.protocol !== "http:" ||
    url.origin !== apiRoot.origin ||
    (url.pathname !== apiRoot.pathname && !url.pathname.startsWith(`${apiRoot.pathname}/`)) ||
    url.username ||
    url.password
  ) {
    throw new Error("Discord injected endpoint fetch rejected a non-provider URL.");
  }
  return url;
}

async function resolveEndpointFetchRequest(
  endpoint: DiscordEndpointRuntime,
  input: string | URL | Request,
  init?: RequestInit,
): Promise<{ url: URL; init?: RequestInitWithDuplex }> {
  if (!(input instanceof Request)) {
    return { url: resolveEndpointFetchUrl(endpoint, input), init };
  }
  const request = new Request(input, init);
  const streamBody = request.body ?? undefined;
  // Fetch rejects keepalive requests whose body is exposed as a stream. Buffer
  // that uncommon form while preserving ordinary streaming Request semantics.
  const body = request.keepalive && streamBody ? await request.arrayBuffer() : streamBody;
  return {
    url: resolveEndpointFetchUrl(endpoint, request),
    init: {
      method: request.method,
      headers: request.headers,
      body,
      cache: request.cache,
      credentials: request.credentials,
      integrity: request.integrity,
      keepalive: request.keepalive,
      mode: request.mode,
      redirect: request.redirect,
      referrer: request.referrer,
      referrerPolicy: request.referrerPolicy,
      signal: request.signal,
      ...(streamBody && !request.keepalive ? { duplex: "half" as const } : {}),
    },
  };
}

export function createDiscordEndpointFetch(endpoint: DiscordEndpointRuntime): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const request = await resolveEndpointFetchRequest(endpoint, input, init);
    const url = request.url;
    const guarded = await fetchWithSsrFGuard({
      url: url.toString(),
      init: request.init,
      maxRedirects: 0,
      policy: { allowedHostnames: [url.hostname], allowPrivateNetwork: true },
      auditContext: "discord.injected-endpoint",
    });
    let released = false;
    const releaseOnce = async () => {
      if (released) {
        return;
      }
      released = true;
      await guarded.release();
    };
    if (!guarded.response.body) {
      void releaseOnce();
      return guarded.response;
    }
    const reader = guarded.response.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await reader.read();
          if (next.done) {
            controller.close();
            await releaseOnce();
            return;
          }
          controller.enqueue(next.value);
        } catch (error) {
          await releaseOnce();
          throw error;
        }
      },
      async cancel(reason) {
        void reader.cancel(reason).catch(() => undefined);
        await releaseOnce();
      },
    });
    return new Response(body, {
      status: guarded.response.status,
      statusText: guarded.response.statusText,
      headers: guarded.response.headers,
    });
  }) as typeof fetch;
}

export function assertDiscordEndpointGatewayUrl(
  endpoint: DiscordEndpointRuntime,
  value: string,
): void {
  const gatewayUrl = new URL(value);
  const gatewayBotUrl = new URL(endpoint.gatewayBotUrl);
  if (
    gatewayUrl.protocol !== "ws:" ||
    gatewayUrl.host !== gatewayBotUrl.host ||
    gatewayUrl.pathname !== "/gateway" ||
    gatewayUrl.username ||
    gatewayUrl.password ||
    gatewayUrl.hash
  ) {
    throw new Error("Discord injected endpoint returned an invalid Gateway WebSocket URL.");
  }
}

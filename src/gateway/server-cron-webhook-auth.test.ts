// Cron webhook security tests cover bearer-token scope and sensitive payload redaction.
import { createServer } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliDeps } from "../cli/deps.types.js";
import type { CronJob } from "../cron/types.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { setActiveDegradedSecretOwners } from "../secrets/runtime-degraded-state.js";

const mocks = vi.hoisted(() => ({
  fetchWithSsrFGuard: vi.fn(async (_request: unknown) => ({
    response: new Response(null, { status: 204 }),
    finalUrl: "https://example.invalid/cron",
    release: vi.fn(async () => {}),
  })),
  sendFailureNotificationAnnounce: vi.fn(),
  sendCronAnnouncePayloadStrict: vi.fn(),
}));

vi.mock("../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: mocks.fetchWithSsrFGuard,
}));

vi.mock("../cron/delivery.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../cron/delivery.js")>();
  return {
    ...actual,
    sendFailureNotificationAnnounce: mocks.sendFailureNotificationAnnounce,
    sendCronAnnouncePayloadStrict: mocks.sendCronAnnouncePayloadStrict,
  };
});

import {
  dispatchGatewayCronFinishedNotifications,
  sendGatewayCronFailureAlert,
} from "./server-cron-notifications.js";

function waitForFast(assertion: () => void | Promise<void>) {
  return vi.waitFor(assertion, { interval: 1 });
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error(`expected ${label}`);
  }
  return value as Record<string, unknown>;
}

function webhookRequest(callIndex = 0) {
  const call = (mocks.fetchWithSsrFGuard.mock.calls as unknown[][])[callIndex];
  if (!call) {
    throw new Error("expected webhook request call");
  }
  const request = requireRecord(call[0], "webhook request");
  const init = requireRecord(request.init, "webhook request init");
  return { request, init };
}

function webhookRequestBody(callIndex = 0) {
  const { init } = webhookRequest(callIndex);
  if (typeof init.body !== "string") {
    throw new Error("expected webhook request body");
  }
  return JSON.parse(init.body);
}

function createWebhookJob(delivery: NonNullable<CronJob["delivery"]>): CronJob {
  return {
    id: "cron-webhook-security",
    name: "webhook security",
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 1,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "hello" },
    delivery,
    state: {},
  };
}

describe("cron webhook security", () => {
  beforeEach(() => {
    resetGatewayWorkAdmission();
    vi.clearAllMocks();
    mocks.fetchWithSsrFGuard.mockImplementation(async () => ({
      response: new Response(null, { status: 204 }),
      finalUrl: "https://example.invalid/cron",
      release: vi.fn(async () => {}),
    }));
    mocks.sendFailureNotificationAnnounce.mockResolvedValue(undefined);
    mocks.sendCronAnnouncePayloadStrict.mockResolvedValue(undefined);
  });

  afterEach(() => {
    resetGatewayWorkAdmission();
    setActiveDegradedSecretOwners([]);
  });

  it("attaches bearer auth only to an exact approved HTTPS destination", async () => {
    const job = createWebhookJob({
      mode: "webhook",
      to: "HTTPS://EXAMPLE.INVALID:443/cron",
    });

    dispatchGatewayCronFinishedNotifications({
      evt: { jobId: job.id, action: "finished", status: "ok", summary: "done" },
      job,
      deps: {} as CliDeps,
      logger: { warn: vi.fn() },
      resolveCronAgent: () => ({ agentId: "main", cfg: {} }),
      webhookToken: "fixture-token",
      webhookTokenDestinations: new Set(["https://example.invalid/cron"]),
    });

    await waitForFast(() => expect(mocks.fetchWithSsrFGuard).toHaveBeenCalledOnce());
    const { request, init } = webhookRequest();
    expect(init.headers).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer fixture-token",
    });
    expect(request).toMatchObject({
      requireHttps: true,
      maxRedirects: 0,
      auditContext: "cron-webhook",
    });
  });

  it.each([
    ["plaintext HTTP", "http://example.invalid/cron"],
    ["different path", "https://example.invalid/other"],
    ["path prefix", "https://example.invalid/cron/child"],
    ["different query", "https://example.invalid/cron?tenant=other"],
    ["different port", "https://example.invalid:8443/cron"],
    ["subdomain", "https://sub.example.invalid/cron"],
    ["hostname suffix", "https://example.invalid.attacker.test/cron"],
  ])("withholds bearer auth from %s", async (_description, destination) => {
    const job = createWebhookJob({ mode: "webhook", to: destination });
    const logger = { warn: vi.fn() };

    dispatchGatewayCronFinishedNotifications({
      evt: { jobId: job.id, action: "finished", status: "ok", summary: "done" },
      job,
      deps: {} as CliDeps,
      logger,
      resolveCronAgent: () => ({ agentId: "main", cfg: {} }),
      webhookToken: "fixture-token",
      webhookTokenDestinations: new Set(["https://example.invalid/cron?tenant=approved"]),
    });

    await waitForFast(() => expect(mocks.fetchWithSsrFGuard).toHaveBeenCalledOnce());
    const { request, init } = webhookRequest();
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    expect(request).not.toHaveProperty("requireHttps");
    expect(request).not.toHaveProperty("maxRedirects");
    expect(logger.warn).toHaveBeenCalledWith(
      {
        jobId: job.id,
        source: "delivery",
        webhookUrl: expect.any(String),
      },
      "cron: webhook bearer token withheld for unapproved destination",
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("fixture-token");
  });

  it("withholds bearer auth from completion, failure, and immediate alert routes", async () => {
    const completionJob = createWebhookJob({
      mode: "announce",
      completionDestination: {
        mode: "webhook",
        to: "https://untrusted.example/complete",
      },
    });
    dispatchGatewayCronFinishedNotifications({
      evt: {
        jobId: completionJob.id,
        action: "finished",
        status: "ok",
        summary: "done",
      },
      job: completionJob,
      deps: {} as CliDeps,
      logger: { warn: vi.fn() },
      resolveCronAgent: () => ({ agentId: "main", cfg: {} }),
      webhookToken: "fixture-token",
      webhookTokenDestinations: new Set(["https://trusted.example/complete"]),
    });
    await waitForFast(() => expect(mocks.fetchWithSsrFGuard).toHaveBeenCalledTimes(1));

    const failureJob = createWebhookJob({
      mode: "announce",
      failureDestination: {
        mode: "webhook",
        to: "https://untrusted.example/failure",
      },
    });
    dispatchGatewayCronFinishedNotifications({
      evt: { jobId: failureJob.id, action: "finished", status: "error", error: "boom" },
      job: failureJob,
      deps: {} as CliDeps,
      logger: { warn: vi.fn() },
      resolveCronAgent: () => ({ agentId: "main", cfg: {} }),
      webhookToken: "fixture-token",
      webhookTokenDestinations: new Set(["https://trusted.example/failure"]),
    });
    await waitForFast(() => expect(mocks.fetchWithSsrFGuard).toHaveBeenCalledTimes(2));

    await sendGatewayCronFailureAlert({
      deps: {} as CliDeps,
      logger: { warn: vi.fn() },
      resolveCronAgent: () => ({ agentId: "main", cfg: {} }),
      webhookToken: "fixture-token",
      webhookTokenDestinations: new Set(["https://trusted.example/failure"]),
      job: createWebhookJob({ mode: "none" }),
      text: "cron failed",
      channel: "last",
      mode: "webhook",
      to: "https://untrusted.example/failure",
    });

    expect(mocks.fetchWithSsrFGuard).toHaveBeenCalledTimes(3);
    for (let index = 0; index < 3; index += 1) {
      expect(webhookRequest(index).init.headers).toEqual({ "Content-Type": "application/json" });
    }
  });

  it("delivers to a real unapproved HTTP receiver without bearer auth", async () => {
    let resolveHeaders: (headers: Record<string, string | string[] | undefined>) => void = () => {};
    const receivedHeaders = new Promise<Record<string, string | string[] | undefined>>(
      (resolve) => {
        resolveHeaders = resolve;
      },
    );
    const server = createServer((request, response) => {
      resolveHeaders(request.headers);
      response.writeHead(204).end();
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("expected receiver TCP address");
      }
      const destination = `http://127.0.0.1:${address.port}/cron`;
      mocks.fetchWithSsrFGuard.mockImplementationOnce(
        async (request: { url: string; init?: RequestInit }) => ({
          response: await fetch(request.url, request.init),
          finalUrl: request.url,
          release: vi.fn(async () => {}),
        }),
      );
      const job = createWebhookJob({ mode: "webhook", to: destination });

      dispatchGatewayCronFinishedNotifications({
        evt: { jobId: job.id, action: "finished", status: "ok", summary: "done" },
        job,
        deps: {} as CliDeps,
        logger: { warn: vi.fn() },
        resolveCronAgent: () => ({ agentId: "main", cfg: {} }),
        webhookToken: "fixture-token",
        webhookTokenDestinations: new Set(["https://trusted.example/cron"]),
      });

      const headers = await receivedHeaders;
      expect(headers.authorization).toBeUndefined();
      expect(headers["content-type"]).toBe("application/json");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    }
  });

  it("redacts command action-required summaries before webhook completion delivery", async () => {
    const sensitiveSummary =
      "action-required output preserved:\nVisit www.example.com/device and enter code 123456\nLog in with token=opaque-secret-value";
    const job = {
      ...createWebhookJob({ mode: "webhook", to: "https://example.invalid/cron" }),
      payload: { kind: "command", argv: ["echo", "ok"] },
      state: {
        lastDiagnosticSummary: sensitiveSummary,
        lastDiagnostics: {
          summary: sensitiveSummary,
          entries: [{ ts: 1, source: "exec", severity: "warn", message: sensitiveSummary }],
        },
      },
    } satisfies CronJob;

    dispatchGatewayCronFinishedNotifications({
      evt: {
        jobId: job.id,
        action: "finished",
        status: "ok",
        summary: sensitiveSummary,
        diagnostics: {
          summary: sensitiveSummary,
          entries: [
            {
              ts: 1,
              source: "exec",
              severity: "warn",
              message:
                "argv: node -e Visit www.example.com/device and enter code 123456; Log in with token=opaque-secret-value",
            },
          ],
        },
        job,
      },
      job,
      deps: {} as CliDeps,
      logger: { warn: vi.fn() },
      resolveCronAgent: () => ({ agentId: "main", cfg: {} }),
    });

    await waitForFast(() => expect(mocks.fetchWithSsrFGuard).toHaveBeenCalledOnce());
    const body = webhookRequestBody();
    expect(body.summary).toContain("[redacted-url]");
    expect(body.summary).toContain("[redacted-code]");
    expect(body.summary).toContain("token=***");
    expect(JSON.stringify(body)).not.toContain("www.example.com/device");
    expect(JSON.stringify(body)).not.toContain("123456");
    expect(JSON.stringify(body)).not.toContain("opaque-secret-value");
    expect(body.job.state).not.toHaveProperty("lastDiagnosticSummary");
    expect(body.job.state).not.toHaveProperty("lastDiagnostics");
  });

  it("omits failed command summaries and diagnostics from completion webhook delivery", async () => {
    const sensitiveSummary =
      "action-required output preserved:\nVisit www.example.com/device and enter code 123456\nLog in with token=opaque-secret-value";
    const job = {
      ...createWebhookJob({
        mode: "announce",
        completionDestination: {
          mode: "webhook",
          to: "https://example.invalid/cron",
        },
      }),
      payload: { kind: "command", argv: ["node", "-e", "process.exit(7)"] },
      state: {
        lastDiagnosticSummary: sensitiveSummary,
        lastDiagnostics: {
          summary: sensitiveSummary,
          entries: [{ ts: 1, source: "exec", severity: "error", message: sensitiveSummary }],
        },
      },
    } satisfies CronJob;

    dispatchGatewayCronFinishedNotifications({
      evt: {
        jobId: job.id,
        action: "finished",
        status: "error",
        error: "command exited with code 7",
        summary: sensitiveSummary,
        diagnostics: {
          summary: sensitiveSummary,
          entries: [{ ts: 1, source: "exec", severity: "error", message: sensitiveSummary }],
        },
        job,
      },
      job,
      deps: {} as CliDeps,
      logger: { warn: vi.fn() },
      resolveCronAgent: () => ({ agentId: "main", cfg: {} }),
    });

    await waitForFast(() => expect(mocks.fetchWithSsrFGuard).toHaveBeenCalledOnce());
    const body = webhookRequestBody();
    expect(body).toMatchObject({
      action: "finished",
      jobId: job.id,
      status: "error",
      error: "command exited with code 7",
    });
    expect(body).not.toHaveProperty("summary");
    expect(body).not.toHaveProperty("diagnostics");
    expect(body.job.state).not.toHaveProperty("lastDiagnosticSummary");
    expect(body.job.state).not.toHaveProperty("lastDiagnostics");
    expect(JSON.stringify(body)).not.toContain("opaque-secret-value");
  });
});

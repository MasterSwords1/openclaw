// Wizard server-method tests cover stable lifecycle errors for process-local sessions.
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { WizardSession } from "../../wizard/session.js";
import type { GatewayRequestHandlerOptions } from "./types.js";
import { wizardHandlers } from "./wizard.js";

describe("wizard session lookup", () => {
  it.each([
    { method: "wizard.next", params: { sessionId: "expired" } },
    { method: "wizard.cancel", params: { sessionId: "expired" } },
    { method: "wizard.status", params: { sessionId: "expired" } },
  ] as const)("returns structured details from $method", async ({ method, params }) => {
    const respond = vi.fn();
    const handler = expectDefined(
      wizardHandlers[method],
      `wizardHandlers[${method}] test invariant`,
    );

    await handler({
      req: { type: "req", id: "wizard-missing", method, params },
      params,
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: { wizardSessions: new Map() } as never,
    } as GatewayRequestHandlerOptions);

    expect(respond).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith(false, undefined, {
      code: "INVALID_REQUEST",
      message: "wizard not found",
      details: { code: "WIZARD_NOT_FOUND" },
    });
  });
});

describe("channel wizard lifecycle", () => {
  it("aborts reversible work and rejects a later durable lock", async () => {
    let lifecycle:
      | {
          abortSignal?: AbortSignal;
          beforePersistentEffect?: () => Promise<void>;
        }
      | undefined;
    const wizardSessions = new Map<string, WizardSession>();
    const respond = vi.fn();
    const start = expectDefined(
      wizardHandlers["wizard.start"],
      "wizardHandlers[wizard.start] test invariant",
    );
    const context = {
      wizardSessions,
      findRunningWizard: () => null,
      purgeWizardSession: (id: string) => wizardSessions.delete(id),
      channelWizardRunner: async (
        options: {
          abortSignal?: AbortSignal;
          beforePersistentEffect?: () => Promise<void>;
        },
        _runtime: unknown,
        prompter: { note: (message: string) => Promise<void> },
      ) => {
        lifecycle = options;
        await prompter.note("Ready");
      },
    };

    await start({
      req: {
        type: "req",
        id: "wizard-lock-race",
        method: "wizard.start",
        params: { flow: "channels", channel: "matrix" },
      },
      params: { flow: "channels", channel: "matrix" },
      client: {
        connId: "shared-auth-old-connection",
        usesSharedGatewayAuth: true,
        sharedGatewaySessionGeneration: "shared-auth-generation",
        connect: { client: { id: "openclaw-control-ui", mode: "webchat" } },
      },
      isWebchatConnect: () => false,
      respond,
      context,
    } as never);

    const session = expectDefined(
      wizardSessions.values().next().value,
      "running channel wizard session",
    );
    expect(lifecycle?.abortSignal).toBe(session.signal);
    expect(session.cancel()).toBe(true);
    expect(lifecycle?.abortSignal?.aborted).toBe(true);
    await expect(
      expectDefined(lifecycle?.beforePersistentEffect, "persistent effect hook")(),
    ).rejects.toThrow("cancelled before its persistent change started");
  });

  it("resumes locked work for its owner after Browse all selects a channel", async () => {
    const wizardSessions = new Map<string, WizardSession>();
    const runCount = vi.fn();
    const context = {
      wizardSessions,
      findRunningWizard: () =>
        [...wizardSessions].find(([, session]) => session.getStatus() === "running")?.[0] ?? null,
      purgeWizardSession: (id: string) => wizardSessions.delete(id),
      channelWizardRunner: async (
        options: { beforePersistentEffect?: () => Promise<void> },
        _runtime: unknown,
        prompter: { confirm: (params: { message: string }) => Promise<boolean> },
      ) => {
        runCount();
        await options.beforePersistentEffect?.();
        await prompter.confirm({ message: "Retry validation?" });
      },
    };
    const owner = {
      connId: "owner-old-connection",
      authenticatedUserId: "owner@example.com",
      connect: { client: { id: "openclaw-control-ui", mode: "webchat" } },
    };
    const reconnectedOwner = { ...owner, connId: "owner-new-connection" };
    const other = {
      ...owner,
      connId: "other-connection",
      authenticatedUserId: "other@example.com",
    };
    const start = expectDefined(
      wizardHandlers["wizard.start"],
      "wizardHandlers[wizard.start] test invariant",
    );
    const next = expectDefined(
      wizardHandlers["wizard.next"],
      "wizardHandlers[wizard.next] test invariant",
    );
    const cancel = expectDefined(
      wizardHandlers["wizard.cancel"],
      "wizardHandlers[wizard.cancel] test invariant",
    );
    const firstRespond = vi.fn();

    await start({
      params: { flow: "channels" },
      client: owner,
      respond: firstRespond,
      context,
    } as never);

    const firstResult = firstRespond.mock.calls[0]?.[1] as
      | { sessionId?: string; step?: { id?: string } }
      | undefined;
    const sessionId = expectDefined(firstResult?.sessionId, "channel wizard session id");
    const stepId = expectDefined(firstResult?.step?.id, "channel wizard step id");

    const lockedCancel = vi.fn();
    await cancel({
      params: { sessionId },
      client: reconnectedOwner,
      respond: lockedCancel,
      context,
    } as never);
    expect(lockedCancel).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ status: "running" }),
      undefined,
    );
    expect(wizardSessions.has(sessionId)).toBe(true);

    const deniedCancel = vi.fn();
    await cancel({
      params: { sessionId },
      client: other,
      respond: deniedCancel,
      context,
    } as never);
    expect(deniedCancel).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
    expect(wizardSessions.has(sessionId)).toBe(true);

    const deniedNext = vi.fn();
    await next({
      params: { sessionId },
      client: other,
      respond: deniedNext,
      context,
    } as never);
    expect(deniedNext).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );

    const resumedRespond = vi.fn();
    await start({
      params: { flow: "channels", channel: "matrix" },
      client: reconnectedOwner,
      respond: resumedRespond,
      context,
    } as never);
    expect(resumedRespond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        sessionId,
        step: expect.objectContaining({ id: stepId }),
      }),
      undefined,
    );
    expect(runCount).toHaveBeenCalledOnce();

    const completedRespond = vi.fn();
    await next({
      params: { sessionId, answer: { stepId, value: true } },
      client: reconnectedOwner,
      respond: completedRespond,
      context,
    } as never);
    expect(completedRespond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ done: true, status: "done" }),
      undefined,
    );
    expect(runCount).toHaveBeenCalledOnce();
  });

  it("resumes locked shared-auth work after credential rotation", async () => {
    const wizardSessions = new Map<string, WizardSession>();
    const runCount = vi.fn();
    const context = {
      wizardSessions,
      findRunningWizard: () =>
        [...wizardSessions].find(([, session]) => session.getStatus() === "running")?.[0] ?? null,
      purgeWizardSession: (id: string) => wizardSessions.delete(id),
      channelWizardRunner: async (
        options: { beforePersistentEffect?: () => Promise<void> },
        _runtime: unknown,
        prompter: { confirm: (params: { message: string }) => Promise<boolean> },
      ) => {
        runCount();
        await options.beforePersistentEffect?.();
        await prompter.confirm({ message: "Retry validation?" });
      },
    };
    const sharedClient = (generation: string, connId: string) => ({
      connId,
      usesSharedGatewayAuth: true,
      sharedGatewaySessionGeneration: generation,
      connect: { client: { id: "openclaw-control-ui", mode: "webchat" } },
    });
    const start = expectDefined(
      wizardHandlers["wizard.start"],
      "wizardHandlers[wizard.start] test invariant",
    );
    const next = expectDefined(
      wizardHandlers["wizard.next"],
      "wizardHandlers[wizard.next] test invariant",
    );
    const firstRespond = vi.fn();

    await start({
      params: { flow: "channels", channel: "matrix" },
      client: sharedClient("generation-old", "connection-old"),
      respond: firstRespond,
      context,
    } as never);

    const firstResult = firstRespond.mock.calls[0]?.[1] as
      | { sessionId?: string; step?: { id?: string } }
      | undefined;
    const sessionId = expectDefined(firstResult?.sessionId, "shared-auth wizard session id");
    const stepId = expectDefined(firstResult?.step?.id, "shared-auth wizard step id");
    const resumedRespond = vi.fn();

    await start({
      params: { flow: "channels", channel: "matrix" },
      client: sharedClient("generation-new", "connection-new"),
      respond: resumedRespond,
      context,
    } as never);

    expect(resumedRespond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        sessionId,
        step: expect.objectContaining({ id: stepId }),
      }),
      undefined,
    );
    const completedRespond = vi.fn();
    await next({
      params: { sessionId, answer: { stepId, value: true } },
      client: sharedClient("generation-new", "connection-new"),
      respond: completedRespond,
      context,
    } as never);
    expect(completedRespond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ done: true, status: "done" }),
      undefined,
    );
    expect(runCount).toHaveBeenCalledOnce();
  });

  it("returns an owner's retained terminal result without rerunning setup", async () => {
    const wizardSessions = new Map<string, WizardSession>();
    const runCount = vi.fn();
    const context = {
      wizardSessions,
      findRunningWizard: () =>
        [...wizardSessions].find(([, session]) => session.getStatus() === "running")?.[0] ?? null,
      purgeWizardSession: (id: string) => wizardSessions.delete(id),
      channelWizardRunner: async (
        options: {
          beforePersistentEffect?: () => Promise<void>;
          onConfigured?: (accounts: Array<{ channel: string; accountId: string }>) => void;
          onResolvedChannel?: (channel: string) => void;
        },
        _runtime: unknown,
      ) => {
        runCount();
        options.onResolvedChannel?.("matrix");
        await options.beforePersistentEffect?.();
        options.onConfigured?.([{ channel: "matrix", accountId: "default" }]);
      },
    };
    const owner = {
      connId: "owner-old-connection",
      authenticatedUserId: "owner@example.com",
      connect: { client: { id: "openclaw-control-ui", mode: "webchat" } },
    };
    const start = expectDefined(
      wizardHandlers["wizard.start"],
      "wizardHandlers[wizard.start] test invariant",
    );
    const firstRespond = vi.fn();

    await start({
      params: { flow: "channels", channel: "matrix" },
      client: owner,
      respond: firstRespond,
      context,
    } as never);

    const firstResult = firstRespond.mock.calls[0]?.[1] as { sessionId?: string } | undefined;
    const sessionId = expectDefined(firstResult?.sessionId, "retained channel wizard session id");
    expect(firstRespond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ sessionId, done: true, status: "done" }),
      undefined,
    );

    for (const connId of [
      "owner-old-connection",
      "owner-new-connection",
      "owner-retry-connection",
    ]) {
      const recoveredRespond = vi.fn();
      await start({
        params: { flow: "channels", channel: "matrix" },
        client: { ...owner, connId },
        respond: recoveredRespond,
        context,
      } as never);

      expect(recoveredRespond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          sessionId,
          done: true,
          status: "done",
          accounts: [{ channel: "matrix", accountId: "default" }],
        }),
        undefined,
      );
    }
    expect(runCount).toHaveBeenCalledOnce();
    expect(wizardSessions.has(sessionId)).toBe(true);

    const freshRespond = vi.fn();
    await start({
      params: { flow: "channels", channel: "discord" },
      client: { ...owner, connId: "owner-retry-connection" },
      respond: freshRespond,
      context,
    } as never);

    const freshResult = freshRespond.mock.calls[0]?.[1] as { sessionId?: string } | undefined;
    expect(freshResult?.sessionId).not.toBe(sessionId);
    expect(runCount).toHaveBeenCalledTimes(2);
  });

  it("recovers an accountless terminal result by canonical channel identity", async () => {
    const wizardSessions = new Map<string, WizardSession>();
    const runCount = vi.fn();
    const context = {
      wizardSessions,
      findRunningWizard: () =>
        [...wizardSessions].find(([, session]) => session.getStatus() === "running")?.[0] ?? null,
      purgeWizardSession: (id: string) => wizardSessions.delete(id),
      channelWizardRunner: async (
        options: {
          beforePersistentEffect?: () => Promise<void>;
          onResolvedChannel?: (channel: string) => void;
        },
        _runtime: unknown,
      ) => {
        runCount();
        options.onResolvedChannel?.(runCount.mock.calls.length === 1 ? "twitch" : "discord");
        await options.beforePersistentEffect?.();
      },
    };
    const owner = {
      connId: "owner-old-connection",
      authenticatedUserId: "owner@example.com",
      connect: { client: { id: "openclaw-control-ui", mode: "webchat" } },
    };
    const start = expectDefined(
      wizardHandlers["wizard.start"],
      "wizardHandlers[wizard.start] test invariant",
    );
    const firstRespond = vi.fn();

    await start({
      params: { flow: "channels", channel: "Twitch-Chat" },
      client: owner,
      respond: firstRespond,
      context,
    } as never);

    const firstResult = firstRespond.mock.calls[0]?.[1] as { sessionId?: string } | undefined;
    const sessionId = expectDefined(firstResult?.sessionId, "retained alias wizard session id");
    const recoveredRespond = vi.fn();
    await start({
      params: { flow: "channels", channel: "twitch-chat" },
      client: { ...owner, connId: "owner-new-connection" },
      respond: recoveredRespond,
      context,
    } as never);

    expect(recoveredRespond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ sessionId, done: true, status: "done" }),
      undefined,
    );
    expect(runCount).toHaveBeenCalledOnce();

    const freshRespond = vi.fn();
    await start({
      params: { flow: "channels", channel: "discord" },
      client: { ...owner, connId: "owner-new-connection" },
      respond: freshRespond,
      context,
    } as never);

    expect(freshRespond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ done: true, status: "done" }),
      undefined,
    );
    expect(runCount).toHaveBeenCalledTimes(2);
  });

  it("rejects hosted channel setup without a reconnect-safe owner", async () => {
    const respond = vi.fn();
    const start = expectDefined(
      wizardHandlers["wizard.start"],
      "wizardHandlers[wizard.start] test invariant",
    );

    await start({
      params: { flow: "channels", channel: "matrix" },
      client: {
        connId: "connection-only",
        connect: { client: { id: "test-client", mode: "cli" } },
      },
      respond,
      context: {
        wizardSessions: new Map(),
        findRunningWizard: () => null,
      },
    } as never);

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: expect.stringContaining("survive reconnects"),
      }),
    );
  });
});

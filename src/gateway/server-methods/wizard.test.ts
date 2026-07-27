// Wizard server-method tests cover stable lifecycle errors for process-local sessions.
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { WizardSession } from "../../wizard/session.js";
import { createWizardSessionTracker } from "../server-wizard-sessions.js";
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
      getRuntimeConfig: () => ({}),
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

  it("resumes locked work through the first channel selected by Browse all", async () => {
    const wizardSessions = new Map<string, WizardSession>();
    const runCount = vi.fn();
    const context = {
      wizardSessions,
      getRuntimeConfig: () => ({}),
      findRunningWizard: () =>
        [...wizardSessions].find(([, session]) => session.getStatus() === "running")?.[0] ?? null,
      purgeWizardSession: (id: string) => wizardSessions.delete(id),
      channelWizardRunner: async (
        options: {
          beforePersistentEffect?: () => Promise<void>;
          onResolvedChannel?: (channel: string) => void;
        },
        _runtime: unknown,
        prompter: { confirm: (params: { message: string }) => Promise<boolean> },
      ) => {
        runCount();
        options.onResolvedChannel?.("matrix");
        options.onResolvedChannel?.("twitch");
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

    const mismatchedRespond = vi.fn();
    await start({
      params: { flow: "channels", channel: "discord" },
      client: reconnectedOwner,
      respond: mismatchedRespond,
      context,
    } as never);
    expect(mismatchedRespond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "UNAVAILABLE" }),
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

  it("reaps an expired retained result before same-owner recovery", async () => {
    let now = 1_000;
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => now);
    const tracker = createWizardSessionTracker({ now: () => now });
    const runCount = vi.fn();
    const context = {
      ...tracker,
      getRuntimeConfig: () => ({}),
      channelWizardRunner: async (options: {
        beforePersistentEffect?: () => Promise<void>;
        onResolvedChannel?: (channel: string) => void;
      }) => {
        runCount();
        options.onResolvedChannel?.("matrix");
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
      params: { flow: "channels", channel: "matrix" },
      client: owner,
      respond: firstRespond,
      context,
    } as never);

    const firstResult = firstRespond.mock.calls[0]?.[1] as { sessionId?: string } | undefined;
    const firstSessionId = expectDefined(firstResult?.sessionId, "retained wizard session id");
    expect(tracker.wizardSessions.has(firstSessionId)).toBe(true);

    now += 5 * 60 * 1000;
    const freshRespond = vi.fn();
    await start({
      params: { flow: "channels", channel: "matrix" },
      client: { ...owner, connId: "owner-new-connection" },
      respond: freshRespond,
      context,
    } as never);

    const freshResult = freshRespond.mock.calls[0]?.[1] as { sessionId?: string } | undefined;
    expect(freshResult?.sessionId).not.toBe(firstSessionId);
    expect(runCount).toHaveBeenCalledTimes(2);
    dateNow.mockRestore();
  });

  it("resumes locked shared-auth work after credential rotation", async () => {
    const wizardSessions = new Map<string, WizardSession>();
    const runCount = vi.fn();
    const context = {
      wizardSessions,
      getRuntimeConfig: () => ({}),
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

  it("restarts reversible shared-auth work after credential rotation", async () => {
    const wizardSessions = new Map<string, WizardSession>();
    const runCount = vi.fn();
    const context = {
      wizardSessions,
      getRuntimeConfig: () => ({}),
      findRunningWizard: () =>
        [...wizardSessions].find(([, session]) => session.getStatus() === "running")?.[0] ?? null,
      purgeWizardSession: (id: string) => wizardSessions.delete(id),
      channelWizardRunner: async (
        _options: unknown,
        _runtime: unknown,
        prompter: { confirm: (params: { message: string }) => Promise<boolean> },
      ) => {
        runCount();
        await prompter.confirm({ message: "Apply setup?" });
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
    const firstRespond = vi.fn();

    await start({
      params: { flow: "channels", channel: "matrix" },
      client: sharedClient("generation-old", "connection-old"),
      respond: firstRespond,
      context,
    } as never);

    const firstResult = firstRespond.mock.calls[0]?.[1] as { sessionId?: string } | undefined;
    const firstSessionId = expectDefined(
      firstResult?.sessionId,
      "reversible shared-auth wizard session id",
    );
    const firstSession = expectDefined(
      wizardSessions.get(firstSessionId),
      "reversible shared-auth wizard session",
    );
    const rotatedRespond = vi.fn();

    await start({
      params: { flow: "channels", channel: "matrix" },
      client: sharedClient("generation-new", "connection-new"),
      respond: rotatedRespond,
      context,
    } as never);

    const rotatedResult = rotatedRespond.mock.calls[0]?.[1] as { sessionId?: string } | undefined;
    expect(rotatedResult?.sessionId).not.toBe(firstSessionId);
    expect(firstSession.signal.aborted).toBe(true);
    expect(wizardSessions.has(firstSessionId)).toBe(false);
    expect(runCount).toHaveBeenCalledTimes(2);
  });

  it("retains a terminal result until recovery collects it, then allows a fresh start", async () => {
    const wizardSessions = new Map<string, WizardSession>();
    const runCount = vi.fn();
    const context = {
      wizardSessions,
      getRuntimeConfig: () => ({}),
      findRunningWizard: () =>
        [...wizardSessions].find(([, session]) => session.getStatus() === "running")?.[0] ?? null,
      purgeWizardSession: (id: string) => wizardSessions.delete(id),
      channelWizardRunner: async (
        options: {
          beforePersistentEffect?: () => Promise<void>;
          onConfigured?: (accounts: Array<{ channel: string; accountId: string }>) => void;
          onResolvedChannel?: (channel: string, aliases?: readonly string[]) => void;
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
    expect(wizardSessions.has(sessionId)).toBe(true);

    const recoveredRespond = vi.fn();
    await start({
      params: { flow: "channels", channel: "matrix" },
      client: { ...owner, connId: "owner-new-connection" },
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
    expect(runCount).toHaveBeenCalledOnce();
    expect(wizardSessions.has(sessionId)).toBe(false);

    const freshRespond = vi.fn();
    await start({
      params: { flow: "channels", channel: "matrix" },
      client: { ...owner, connId: "owner-retry-connection" },
      respond: freshRespond,
      context,
    } as never);

    const freshResult = freshRespond.mock.calls[0]?.[1] as { sessionId?: string } | undefined;
    expect(freshResult?.sessionId).not.toBe(sessionId);
    expect(runCount).toHaveBeenCalledTimes(2);
  });

  it("starts fresh after returning a terminal result on the same connection", async () => {
    const wizardSessions = new Map<string, WizardSession>();
    const runCount = vi.fn();
    const context = {
      wizardSessions,
      getRuntimeConfig: () => ({}),
      findRunningWizard: () =>
        [...wizardSessions].find(([, session]) => session.getStatus() === "running")?.[0] ?? null,
      purgeWizardSession: (id: string) => wizardSessions.delete(id),
      channelWizardRunner: async (options: {
        beforePersistentEffect?: () => Promise<void>;
        onResolvedChannel?: (channel: string) => void;
      }) => {
        runCount();
        options.onResolvedChannel?.("matrix");
        await options.beforePersistentEffect?.();
      },
    };
    const client = {
      connId: "owner-connection",
      authenticatedUserId: "owner@example.com",
      connect: { client: { id: "openclaw-control-ui", mode: "webchat" } },
    };
    const start = expectDefined(
      wizardHandlers["wizard.start"],
      "wizardHandlers[wizard.start] test invariant",
    );

    await start({
      params: { flow: "channels", channel: "matrix" },
      client,
      respond: vi.fn(),
      context,
    } as never);
    await start({
      params: { flow: "channels", channel: "matrix" },
      client,
      respond: vi.fn(),
      context,
    } as never);

    expect(runCount).toHaveBeenCalledTimes(2);
  });

  it("starts a fresh browse-all wizard after retained work is terminal", async () => {
    const wizardSessions = new Map<string, WizardSession>();
    const runCount = vi.fn();
    const context = {
      wizardSessions,
      getRuntimeConfig: () => ({}),
      findRunningWizard: () =>
        [...wizardSessions].find(([, session]) => session.getStatus() === "running")?.[0] ?? null,
      purgeWizardSession: (id: string) => wizardSessions.delete(id),
      channelWizardRunner: async (options: { beforePersistentEffect?: () => Promise<void> }) => {
        runCount();
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
      params: { flow: "channels" },
      client: owner,
      respond: firstRespond,
      context,
    } as never);

    const firstResult = firstRespond.mock.calls[0]?.[1] as { sessionId?: string } | undefined;
    const firstSessionId = expectDefined(
      firstResult?.sessionId,
      "retained browse-all wizard session id",
    );
    expect(firstRespond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ sessionId: firstSessionId, done: true, status: "done" }),
      undefined,
    );

    const freshRespond = vi.fn();
    await start({
      params: { flow: "channels" },
      client: { ...owner, connId: "owner-new-connection" },
      respond: freshRespond,
      context,
    } as never);

    const freshResult = freshRespond.mock.calls[0]?.[1] as { sessionId?: string } | undefined;
    expect(freshResult?.sessionId).not.toBe(firstSessionId);
    expect(runCount).toHaveBeenCalledTimes(2);
  });

  it("keeps a retained result when another owner's running wizard blocks a fresh start", async () => {
    const wizardSessions = new Map<string, WizardSession>();
    const context = {
      wizardSessions,
      getRuntimeConfig: () => ({}),
      findRunningWizard: () =>
        [...wizardSessions].find(([, session]) => session.getStatus() === "running")?.[0] ?? null,
      purgeWizardSession: (id: string) => wizardSessions.delete(id),
      channelWizardRunner: async (options: {
        beforePersistentEffect?: () => Promise<void>;
        onResolvedChannel?: (channel: string) => void;
      }) => {
        options.onResolvedChannel?.("matrix");
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
      params: { flow: "channels", channel: "matrix" },
      client: owner,
      respond: firstRespond,
      context,
    } as never);

    const firstResult = firstRespond.mock.calls[0]?.[1] as { sessionId?: string } | undefined;
    const retainedSessionId = expectDefined(firstResult?.sessionId, "retained wizard session id");
    const blocker = new WizardSession(async (prompter) => {
      await prompter.note("Other owner is still configuring.");
    });
    wizardSessions.set("other-owner-running", blocker);
    const freshRespond = vi.fn();

    await start({
      params: { flow: "channels", channel: "discord" },
      client: { ...owner, connId: "owner-new-connection" },
      respond: freshRespond,
      context,
    } as never);

    expect(freshRespond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "UNAVAILABLE", message: "wizard already running" }),
    );
    expect(wizardSessions.has(retainedSessionId)).toBe(true);
    blocker.cancel();
  });

  it("recovers an accountless terminal result by canonical channel identity", async () => {
    const wizardSessions = new Map<string, WizardSession>();
    const runCount = vi.fn();
    const context = {
      wizardSessions,
      getRuntimeConfig: () => ({}),
      findRunningWizard: () =>
        [...wizardSessions].find(([, session]) => session.getStatus() === "running")?.[0] ?? null,
      purgeWizardSession: (id: string) => wizardSessions.delete(id),
      channelWizardRunner: async (
        options: {
          beforePersistentEffect?: () => Promise<void>;
          onResolvedChannel?: (channel: string, aliases?: readonly string[]) => void;
        },
        _runtime: unknown,
      ) => {
        runCount();
        if (runCount.mock.calls.length === 1) {
          options.onResolvedChannel?.("twitch", ["twitch-chat"]);
        } else {
          options.onResolvedChannel?.("discord");
        }
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
      params: { flow: "channels", channel: "twitch" },
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

  it("starts an exact canonical channel instead of replaying another channel's alias", async () => {
    const channelWizardModule = await import("../../commands/channels/add-wizard.js");
    const resolveChannel = vi
      .spyOn(channelWizardModule, "resolveInitialWizardChannel")
      .mockImplementation(
        async (raw) =>
          raw as Awaited<ReturnType<typeof channelWizardModule.resolveInitialWizardChannel>>,
      );
    try {
      const wizardSessions = new Map<string, WizardSession>();
      const runCount = vi.fn();
      const context = {
        wizardSessions,
        getRuntimeConfig: () => ({}),
        findRunningWizard: () =>
          [...wizardSessions].find(([, session]) => session.getStatus() === "running")?.[0] ?? null,
        purgeWizardSession: (id: string) => wizardSessions.delete(id),
        channelWizardRunner: async (
          options: {
            channel?: string;
            beforePersistentEffect?: () => Promise<void>;
            onResolvedChannel?: (channel: string, aliases?: readonly string[]) => void;
          },
          _runtime: unknown,
        ) => {
          runCount();
          if (options.channel === "alias-owner") {
            options.onResolvedChannel?.("alias-owner", ["exact-id"]);
          } else {
            options.onResolvedChannel?.("exact-id");
          }
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
        params: { flow: "channels", channel: "alias-owner" },
        client: owner,
        respond: firstRespond,
        context,
      } as never);

      const firstResult = firstRespond.mock.calls[0]?.[1] as { sessionId?: string } | undefined;
      const firstSessionId = expectDefined(firstResult?.sessionId, "alias owner session id");
      const exactRespond = vi.fn();
      await start({
        params: { flow: "channels", channel: "exact-id" },
        client: { ...owner, connId: "owner-new-connection" },
        respond: exactRespond,
        context,
      } as never);

      const exactResult = exactRespond.mock.calls[0]?.[1] as { sessionId?: string } | undefined;
      expect(exactResult?.sessionId).not.toBe(firstSessionId);
      expect(runCount).toHaveBeenCalledTimes(2);
    } finally {
      resolveChannel.mockRestore();
    }
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

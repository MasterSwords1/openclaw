import { describe, expect, it } from "vitest";
import { prepareSessionStoreOwnershipForWrite } from "./io.session-store-owner.js";
import type { OpenClawConfig } from "./types.js";

describe("prepareSessionStoreOwnershipForWrite", () => {
  it("preserves sessionStore.agentId on unrelated config writes when session.store is unset", () => {
    const currentConfig: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        defaults: {
          sessionStore: { agentId: "discord-main" },
          systemAgent: { agentId: "discord-main" },
        },
        entries: {
          "discord-main": { name: "Discord Agent" },
          "anthropic-main": { name: "Anthropic Agent" },
        },
      },
    };
    const targetConfig: OpenClawConfig = {
      ...currentConfig,
      agents: {
        ...currentConfig.agents,
        defaults: {
          ...currentConfig.agents?.defaults,
          bootstrapMaxChars: 30001,
        },
      },
    };

    const result = prepareSessionStoreOwnershipForWrite({
      currentConfig,
      currentStore: undefined,
      targetConfig,
      env: process.env,
      explicitSetPaths: [["agents", "defaults", "bootstrapMaxChars"]],
    });

    expect(result.config.agents?.defaults?.sessionStore?.agentId).toBe("discord-main");
    expect(result.ownershipPaths).toEqual([]);
  });

  it("preserves sessionStore.agentId on unrelated config writes when session.store is a templated per-agent store", () => {
    const currentConfig: OpenClawConfig = {
      session: { store: "stores/{agentId}/sessions.json" },
      agents: {
        defaults: {
          sessionStore: { agentId: "worker-1" },
        },
      },
    };
    const targetConfig: OpenClawConfig = {
      ...currentConfig,
      agents: {
        defaults: {
          ...currentConfig.agents?.defaults,
          bootstrapMaxChars: 12000,
        },
      },
    };

    const result = prepareSessionStoreOwnershipForWrite({
      currentConfig,
      currentStore: currentConfig.session?.store,
      targetConfig,
      env: process.env,
      explicitSetPaths: [["agents", "defaults", "bootstrapMaxChars"]],
    });

    expect(result.config.agents?.defaults?.sessionStore?.agentId).toBe("worker-1");
    expect(result.ownershipPaths).toEqual([]);
  });

  it("clears sessionStore.agentId when transitioning from unset per-agent store to a fixed store without explicit owner", () => {
    const currentConfig: OpenClawConfig = {
      agents: {
        defaults: {
          sessionStore: { agentId: "discord-main" },
        },
      },
    };
    const targetConfig: OpenClawConfig = {
      ...currentConfig,
      session: { store: "/var/openclaw/sessions.sqlite" },
    };

    const result = prepareSessionStoreOwnershipForWrite({
      currentConfig,
      currentStore: undefined,
      targetConfig,
      env: process.env,
      explicitSetPaths: [["session", "store"]],
    });

    expect(result.config.agents?.defaults?.sessionStore?.agentId).toBeUndefined();
    expect(result.ownershipPaths).toEqual([["agents", "defaults", "sessionStore", "agentId"]]);
  });

  it("clears sessionStore.agentId when transitioning from a fixed store to an unset per-agent store without explicit owner", () => {
    const currentConfig: OpenClawConfig = {
      session: { store: "/var/openclaw/sessions.sqlite" },
      agents: {
        defaults: {
          sessionStore: { agentId: "discord-main" },
        },
      },
    };
    const targetConfig: OpenClawConfig = {
      agents: {
        defaults: {
          sessionStore: { agentId: "discord-main" },
        },
      },
    };

    const result = prepareSessionStoreOwnershipForWrite({
      currentConfig,
      currentStore: currentConfig.session?.store,
      targetConfig,
      env: process.env,
      explicitSetPaths: [["session", "store"]],
    });

    expect(result.config.agents?.defaults?.sessionStore?.agentId).toBeUndefined();
    expect(result.ownershipPaths).toEqual([["agents", "defaults", "sessionStore", "agentId"]]);
  });

  it("clears sessionStore.agentId when changing between distinct fixed stores without explicit owner", () => {
    const currentConfig: OpenClawConfig = {
      session: { store: "/var/openclaw/store-a.sqlite" },
      agents: {
        defaults: {
          sessionStore: { agentId: "discord-main" },
        },
      },
    };
    const targetConfig: OpenClawConfig = {
      ...currentConfig,
      session: { store: "/var/openclaw/store-b.sqlite" },
    };

    const result = prepareSessionStoreOwnershipForWrite({
      currentConfig,
      currentStore: currentConfig.session?.store,
      targetConfig,
      env: process.env,
      explicitSetPaths: [["session", "store"]],
    });

    expect(result.config.agents?.defaults?.sessionStore?.agentId).toBeUndefined();
    expect(result.ownershipPaths).toEqual([["agents", "defaults", "sessionStore", "agentId"]]);
  });

  it("retains explicitly supplied destination owner when store changes", () => {
    const currentConfig: OpenClawConfig = {
      session: { store: "/var/openclaw/store-a.sqlite" },
      agents: {
        defaults: {
          sessionStore: { agentId: "discord-main" },
        },
      },
    };
    const targetConfig: OpenClawConfig = {
      session: { store: "/var/openclaw/store-b.sqlite" },
      agents: {
        defaults: {
          sessionStore: { agentId: "new-owner" },
        },
      },
    };

    const result = prepareSessionStoreOwnershipForWrite({
      currentConfig,
      currentStore: currentConfig.session?.store,
      targetConfig,
      env: process.env,
      explicitSetPaths: [
        ["session", "store"],
        ["agents", "defaults", "sessionStore", "agentId"],
      ],
    });

    expect(result.config.agents?.defaults?.sessionStore?.agentId).toBe("new-owner");
    expect(result.ownershipPaths).toEqual([]);
  });
});

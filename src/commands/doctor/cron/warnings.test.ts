// Doctor cron delivery-target advisory tests cover concrete-vs-pseudo channel detection.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectLegacyWhatsAppCrontabHealthWarning,
  noteCronDeliveryTargetAdvisory,
  noteCronModelOverrides,
  noteCronWebhookTokenDestinationsAdvisory,
} from "./warnings.js";

const mocks = vi.hoisted(() => ({
  listReadOnlyChannelPluginsForConfig: vi.fn(),
  note: vi.fn(),
  runExec: vi.fn(),
}));

vi.mock("../../../channels/plugins/read-only.js", () => ({
  listReadOnlyChannelPluginsForConfig: mocks.listReadOnlyChannelPluginsForConfig,
}));
vi.mock("../../../../packages/terminal-core/src/note.js", () => ({ note: mocks.note }));
vi.mock("../../../process/exec.js", () => ({ runExec: mocks.runExec }));

afterEach(() => {
  vi.clearAllMocks();
});

function job(overrides: Record<string, unknown>): Record<string, unknown> {
  return { id: "job", schedule: "0 * * * *", ...overrides };
}

/** Resolver thunk returning a fixed channel set; tracks whether it was invoked. */
function availableChannels(...ids: string[]) {
  return vi.fn(() => ids);
}

function collectCronDeliveryTargetAdvisory(params: {
  jobs: Array<Record<string, unknown>>;
  resolveAvailableChannelIds: () => string[];
}): string | null {
  mocks.note.mockClear();
  mocks.listReadOnlyChannelPluginsForConfig.mockImplementation(() =>
    params.resolveAvailableChannelIds().map((id) => ({ id })),
  );
  noteCronDeliveryTargetAdvisory({
    cfg: {},
    jobs: params.jobs,
  });
  const body = mocks.note.mock.calls.at(-1)?.[0];
  return typeof body === "string" ? body : null;
}

describe("noteCronModelOverrides", () => {
  it("describes enabled overrides without claiming a specific backing store", () => {
    noteCronModelOverrides({
      cfg: {},
      jobs: [job({ enabled: true, payload: { kind: "agentTurn", model: "ollama/qwen3" } })],
    });

    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringMatching(/^Automation model overrides detected\.\n/u),
      "Cron",
    );
  });

  it("does not warn for disabled model-pinned jobs", () => {
    noteCronModelOverrides({
      cfg: {},
      jobs: [job({ enabled: false, payload: { kind: "agentTurn", model: "ollama/qwen3" } })],
    });

    expect(mocks.note).not.toHaveBeenCalled();
  });
});

describe("collectCronDeliveryTargetAdvisory", () => {
  it("advises when a concrete delivery channel has no active plugin", () => {
    const advisory = collectCronDeliveryTargetAdvisory({
      jobs: [job({ id: "report", delivery: { mode: "announce", channel: "missing-channel" } })],
      resolveAvailableChannelIds: availableChannels("slack", "telegram"),
    });
    expect(advisory).not.toBeNull();
    expect(advisory).toContain("Automation delivery targets unavailable channels");
    expect(advisory).toContain("1 job announces");
    expect(advisory).toContain("Channels: missing-channel=1");
    expect(advisory).toContain("Examples: report -> missing-channel");
  });

  it("returns null when the concrete channel resolves to an active plugin", () => {
    // Omitting `mode` defaults to announce, so a bare channel still counts as a concrete target.
    const advisory = collectCronDeliveryTargetAdvisory({
      jobs: [job({ delivery: { channel: "slack" } })],
      resolveAvailableChannelIds: availableChannels("slack", "telegram"),
    });
    expect(advisory).toBeNull();
  });

  it("treats a channel alias as active when its canonical id is available", () => {
    // "gchat" canonicalizes to "googlechat"; an alias target must not look unavailable.
    const advisory = collectCronDeliveryTargetAdvisory({
      jobs: [job({ delivery: { mode: "announce", channel: "gchat" } })],
      resolveAvailableChannelIds: availableChannels("googlechat"),
    });
    expect(advisory).toBeNull();
  });

  it.each([
    ["announce-to-last", { mode: "announce", channel: "last" }],
    ["webhook", { mode: "webhook", to: "https://example.invalid/hook" }],
    ["none with a channel", { mode: "none", channel: "missing-channel" }],
  ])("skips pseudo/relative target: %s", (_label, delivery) => {
    const resolve = availableChannels("slack");
    const advisory = collectCronDeliveryTargetAdvisory({
      jobs: [job({ delivery })],
      resolveAvailableChannelIds: resolve,
    });
    expect(advisory).toBeNull();
  });

  it("does not resolve channels when no job pins a concrete target", () => {
    // Resolution is lazy: a job without an explicit delivery object never triggers the snapshot.
    const resolve = vi.fn(() => {
      throw new Error("channel resolution should not run");
    });
    const advisory = collectCronDeliveryTargetAdvisory({
      jobs: [job({ id: "implicit" }), job({ id: "weblike", delivery: { mode: "webhook" } })],
      resolveAvailableChannelIds: resolve,
    });
    expect(advisory).toBeNull();
    expect(resolve).not.toHaveBeenCalled();
  });

  it("skips disabled jobs because they have no next scheduled delivery", () => {
    const resolve = availableChannels("slack");
    const advisory = collectCronDeliveryTargetAdvisory({
      jobs: [
        job({
          enabled: false,
          delivery: { mode: "announce", channel: "missing-channel" },
        }),
      ],
      resolveAvailableChannelIds: resolve,
    });
    expect(advisory).toBeNull();
    expect(resolve).not.toHaveBeenCalled();
  });

  it("flags a concrete target even when no channels are active (only channel removed)", () => {
    const advisory = collectCronDeliveryTargetAdvisory({
      jobs: [job({ id: "report", delivery: { mode: "announce", channel: "slack" } })],
      resolveAvailableChannelIds: availableChannels(),
    });
    expect(advisory).toContain("Channels: slack=1");
  });

  it("aggregates counts and caps examples at three", () => {
    const advisory = collectCronDeliveryTargetAdvisory({
      jobs: [
        job({ id: "ok", delivery: { mode: "announce", channel: "slack" } }),
        job({ id: "g1", delivery: { mode: "announce", channel: "ghost-a" } }),
        job({ id: "g2", delivery: { mode: "announce", channel: "ghost-a" } }),
        job({ id: "g3", delivery: { mode: "announce", channel: "ghost-b" } }),
        job({ id: "g4", delivery: { mode: "announce", channel: "ghost-b" } }),
      ],
      resolveAvailableChannelIds: availableChannels("slack"),
    });
    expect(advisory).toContain("4 jobs announce");
    // Channels render sorted by id.
    expect(advisory).toContain("Channels: ghost-a=2, ghost-b=2");
    const exampleLine = advisory?.split("\n").find((line) => line.startsWith("- Examples:"));
    expect(exampleLine).toBeDefined();
    expect(exampleLine?.split(" -> ").length).toBe(4); // three "<id> -> <channel>" pairs
    expect(advisory).not.toContain("g4 -> ghost-b");
  });

  it("falls back to job name then <unnamed> in examples", () => {
    const advisory = collectCronDeliveryTargetAdvisory({
      jobs: [
        job({
          id: undefined,
          name: "Nightly digest",
          delivery: { mode: "announce", channel: "ghost" },
        }),
        job({ id: undefined, name: undefined, delivery: { mode: "announce", channel: "ghost" } }),
      ],
      resolveAvailableChannelIds: availableChannels("slack"),
    });
    expect(advisory).toContain("Nightly digest -> ghost");
    expect(advisory).toContain("<unnamed> -> ghost");
  });
});

describe("noteCronWebhookTokenDestinationsAdvisory", () => {
  it("warns when a token has no approved HTTPS destination", () => {
    noteCronWebhookTokenDestinationsAdvisory({
      cfg: { cron: { webhookToken: "fixture-token" } },
      jobs: [
        job({
          delivery: {
            mode: "webhook",
            to: "https://hooks.example.com/cron?token=redacted",
          },
        }),
      ],
    });

    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining("1 webhook route will continue without Authorization"),
      "Cron",
    );
    expect(mocks.note.mock.calls[0]?.[0]).toContain("https://hooks.example.com/cron");
    expect(mocks.note.mock.calls[0]?.[0]).not.toContain("token=redacted");
    expect(JSON.stringify(mocks.note.mock.calls)).not.toContain("fixture-token");
  });

  it("accepts an explicit approved destination", () => {
    noteCronWebhookTokenDestinationsAdvisory({
      cfg: {
        cron: {
          webhookToken: "fixture-token",
          webhookTokenDestinations: ["https://hooks.example.com/cron"],
        },
      },
      jobs: [
        job({
          delivery: { mode: "webhook", to: "https://hooks.example.com/cron" },
        }),
      ],
    });

    expect(mocks.note).not.toHaveBeenCalled();
  });

  it("accepts the exact global failure webhook destination", () => {
    noteCronWebhookTokenDestinationsAdvisory({
      cfg: {
        cron: {
          webhookToken: "fixture-token",
          failureAlert: {
            mode: "webhook",
            to: "https://hooks.example.com/failure",
          },
        },
      },
      jobs: [
        job({
          failureAlert: {
            mode: "webhook",
            to: "https://hooks.example.com/failure",
          },
        }),
      ],
    });

    expect(mocks.note).not.toHaveBeenCalled();
  });

  it("covers direct, completion, failure-destination, and threshold-alert routes", () => {
    noteCronWebhookTokenDestinationsAdvisory({
      cfg: { cron: { webhookToken: "fixture-token" } },
      jobs: [
        job({
          id: "direct",
          delivery: { mode: "webhook", to: "https://hooks.example.com/direct" },
        }),
        job({
          id: "completion",
          delivery: {
            mode: "announce",
            completionDestination: {
              mode: "webhook",
              to: "https://hooks.example.com/completion",
            },
          },
        }),
        job({
          id: "failure-destination",
          delivery: {
            mode: "none",
            failureDestination: {
              mode: "webhook",
              to: "https://hooks.example.com/failure-destination",
            },
          },
        }),
        job({
          id: "threshold-alert",
          failureAlert: {
            mode: "webhook",
            to: "https://hooks.example.com/threshold-alert",
          },
        }),
      ],
    });

    expect(mocks.note.mock.calls[0]?.[0]).toContain(
      "4 webhook routes will continue without Authorization",
    );
    expect(mocks.note.mock.calls[0]?.[0]).not.toContain("threshold-alert ->");
  });
});

describe("collectLegacyWhatsAppCrontabHealthWarning", () => {
  it("bounds the best-effort crontab read", async () => {
    mocks.runExec.mockRejectedValueOnce(new Error("crontab timed out"));

    await expect(
      collectLegacyWhatsAppCrontabHealthWarning({ platform: "linux" }),
    ).resolves.toBeNull();
    expect(mocks.runExec).toHaveBeenCalledWith("crontab", ["-l"], {
      logOutput: false,
      timeoutMs: 5_000,
    });
  });
});

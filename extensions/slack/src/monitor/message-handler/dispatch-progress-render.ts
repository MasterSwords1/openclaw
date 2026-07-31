import type {
  AgentPlanStep,
  ChannelProgressDraftCompositorLine,
  ChannelProgressDraftCompositorSnapshot,
  ChannelProgressDraftLine,
} from "openclaw/plugin-sdk/channel-outbound";
import {
  buildSlackProgressStreamStartChunks,
  buildSlackProgressStreamUpdateChunks,
} from "../../progress-blocks.js";

export function resolveStructuredProgressLines(
  lines: readonly ChannelProgressDraftCompositorLine[],
): ChannelProgressDraftLine[] {
  return lines.map((line) => {
    if (typeof line !== "string") {
      return line;
    }
    const reasoning = line.startsWith("🧠 ");
    const text = line
      .replace(/^(?:🧠|💬)\s+/u, "")
      .replace(/^_(.*)_$/su, "$1")
      .trim();
    return {
      // Reasoning snapshots replace one rolling row; text-based ids would orphan it each delta.
      ...(reasoning ? { id: "reasoning" } : {}),
      kind: "item",
      text,
      label: reasoning ? "Reasoning" : "Update",
      prefix: false,
    };
  });
}

// Native cards derive only from structured update_plan steps. Tool and status
// lines remain portable progress data and never become Slack checklist rows.
export function resolveNativeProgressPlan(
  snapshot: ChannelProgressDraftCompositorSnapshot,
): readonly AgentPlanStep[] | undefined {
  return snapshot.plan?.length ? snapshot.plan : undefined;
}

export function combineProgressHeadlineAndExplanation(
  headline: string | undefined,
  explanation: string | undefined,
): string | undefined {
  return headline && explanation && headline !== explanation
    ? `${headline} — ${explanation}`
    : (headline ?? explanation);
}

export function buildNativeProgressChunks(params: {
  snapshot: ChannelProgressDraftCompositorSnapshot;
  streamStarted: boolean;
  title?: string;
}) {
  const input = {
    title: params.title,
    plan: resolveNativeProgressPlan(params.snapshot),
  };
  return params.streamStarted
    ? buildSlackProgressStreamUpdateChunks(input)
    : buildSlackProgressStreamStartChunks(input);
}

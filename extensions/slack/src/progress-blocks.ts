// Slack plugin module implements progress blocks behavior.
import type { AnyChunk } from "@slack/types";
import type { Block, KnownBlock } from "@slack/web-api";
import {
  type AgentPlanStep,
  type ChannelProgressDraftLine,
  formatPlanChecklistLines,
} from "openclaw/plugin-sdk/channel-outbound";
import { SLACK_MAX_BLOCKS } from "./blocks-input.js";
import { escapeSlackMrkdwn } from "./monitor/mrkdwn.js";
import { truncateSlackText } from "./truncate.js";

const SLACK_PROGRESS_FIELD_MAX = 1800;
const DEFAULT_SLACK_PROGRESS_DETAIL_MAX_CHARS = 120;
const SLACK_PROGRESS_CHUNK_TEXT_MAX = 256;
const SLACK_PROGRESS_TASK_TITLE_MAX = 120;
const SLACK_PROGRESS_PLAN_FALLBACK_TITLE = "Task progress";

type SlackPlanTaskStatus = "pending" | "in_progress" | "complete" | "error";

type SlackPlanTask = {
  id: string;
  title: string;
  status: SlackPlanTaskStatus;
};

function field(text: string) {
  return {
    type: "mrkdwn" as const,
    text: truncateSlackText(text, SLACK_PROGRESS_FIELD_MAX),
  };
}

function resolveMaxLineChars(value: number | undefined, fallback: number): number {
  return value && value > 0 ? Math.floor(value) : fallback;
}

function compactDetail(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  const chars = Array.from(normalized);
  if (chars.length <= maxChars) {
    return normalized;
  }
  if (maxChars <= 1) {
    return "…";
  }
  const keepStart = Math.max(1, Math.ceil((maxChars - 1) * 0.45));
  const keepEnd = Math.max(1, maxChars - keepStart - 1);
  return `${chars.slice(0, keepStart).join("").trimEnd()}…${chars
    .slice(-keepEnd)
    .join("")
    .trimStart()}`;
}

function compactTitle(value: string): string {
  return truncateSlackText(value.replace(/\s+/g, " ").trim(), SLACK_PROGRESS_TASK_TITLE_MAX);
}

function compactChunkText(value: string): string {
  return truncateSlackText(value.replace(/\s+/g, " ").trim(), SLACK_PROGRESS_CHUNK_TEXT_MAX);
}

function lineDetailParts(line: ChannelProgressDraftLine): string[] {
  return [
    line.detail,
    line.status && line.status !== "completed" && !line.detail?.includes(line.status)
      ? line.status
      : undefined,
  ]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part));
}

function legacyLineTitle(line: ChannelProgressDraftLine): string {
  return `${line.icon ?? "•"} *${escapeSlackMrkdwn(line.label)}*`;
}

function legacyLineDetail(line: ChannelProgressDraftLine, maxChars: number): string {
  const detail = lineDetailParts(line).join(" · ");
  return detail ? escapeSlackMrkdwn(compactDetail(detail, maxChars)) : "—";
}

function buildPlanTasks(plan: readonly AgentPlanStep[]): SlackPlanTask[] {
  // Codex and the portable plan event expose ordered full snapshots but no
  // item id. These ordered ids seed the first snapshot; reconciliation below
  // preserves them by semantic title across later inserts and reorders.
  return plan.slice(-SLACK_MAX_BLOCKS).map((entry, index) => ({
    id: `plan_step_${index + 1}`,
    title: compactTitle(entry.step),
    status: entry.status === "completed" ? ("complete" as const) : entry.status,
  }));
}

function resolvePlanTitle(params: {
  label?: string;
  title?: string;
  tasks: readonly SlackPlanTask[];
}): string {
  return compactChunkText(
    params.title?.trim() || params.label?.trim() || SLACK_PROGRESS_PLAN_FALLBACK_TITLE,
  );
}

function buildSlackProgressStreamChunks(params: {
  label?: string;
  title?: string;
  plan?: readonly AgentPlanStep[];
  completeInProgress?: boolean;
  finalInProgressStatus?: SlackPlanTaskStatus;
}): AnyChunk[] | undefined {
  if (!params.plan?.length) {
    return undefined;
  }
  const tasks = buildPlanTasks(params.plan);
  if (tasks.length === 0) {
    return undefined;
  }
  const title = resolvePlanTitle({ label: params.label, title: params.title, tasks });
  const chunks: AnyChunk[] = [
    {
      type: "plan_update",
      title,
    },
    ...tasks.map((task) => ({
      type: "task_update" as const,
      id: task.id,
      title: task.title,
      status:
        task.status === "in_progress"
          ? (params.finalInProgressStatus ?? (params.completeInProgress ? "complete" : task.status))
          : task.status,
    })),
  ];
  return chunks;
}

export function buildSlackProgressDraftBlocks(params: {
  label?: string;
  title?: string;
  lines: readonly ChannelProgressDraftLine[];
  plan?: readonly AgentPlanStep[];
  narration?: string;
  maxLineChars?: number;
}): (Block | KnownBlock)[] | undefined {
  const label = params.label?.trim() || params.title?.trim();
  const maxLineChars = resolveMaxLineChars(
    params.maxLineChars,
    DEFAULT_SLACK_PROGRESS_DETAIL_MAX_CHARS,
  );
  const planLines = formatPlanChecklistLines(params.plan ?? [], {
    maxLines: SLACK_MAX_BLOCKS,
    maxLineChars,
  });
  const narration = params.narration?.replace(/\s+/g, " ").trim();
  // Status blocks (label, narration, checklist) take priority over rolling
  // tool lines inside Slack's 50-block budget; the tail slice would otherwise
  // silently drop the checklist first.
  const headBlocks: (Block | KnownBlock)[] = [
    ...(label
      ? [
          {
            type: "section" as const,
            text: field(`*${escapeSlackMrkdwn(label)}*`),
          },
        ]
      : []),
    ...(narration
      ? [
          {
            type: "section" as const,
            text: field(`_${escapeSlackMrkdwn(narration)}_`),
          },
        ]
      : []),
    ...(planLines.length > 0
      ? [
          {
            type: "section" as const,
            text: field(planLines.map((line) => escapeSlackMrkdwn(line)).join("\n")),
          },
        ]
      : []),
  ].slice(0, SLACK_MAX_BLOCKS);
  const lineBudget = Math.max(0, SLACK_MAX_BLOCKS - headBlocks.length);
  const renderedBlocks: (Block | KnownBlock)[] = [
    ...headBlocks,
    ...params.lines.slice(-lineBudget).map((line) => ({
      type: "section" as const,
      fields: [field(legacyLineTitle(line)), field(legacyLineDetail(line, maxLineChars))],
    })),
  ];
  return renderedBlocks.length ? renderedBlocks : undefined;
}

export type SlackNativeTaskSnapshot = ReadonlyMap<
  string,
  { active: boolean; title: string; status: SlackPlanTaskStatus }
>;

/**
 * Slack native streams key task rows by persistent id with no removal chunk.
 * When a structured plan snapshot drops ids, previously emitted non-terminal
 * rows must receive a final update or they linger in_progress forever.
 */
export function reconcileSlackNativeTaskChunks(params: {
  previousTasks: SlackNativeTaskSnapshot;
  chunks: AnyChunk[] | undefined;
}): { chunks: AnyChunk[] | undefined; tasks: SlackNativeTaskSnapshot } {
  type TaskChunk = Extract<AnyChunk, { type: "task_update" }>;
  const taskChunks = (params.chunks ?? []).filter(
    (chunk): chunk is TaskChunk => chunk.type === "task_update",
  );
  const previousActive = [...params.previousTasks].filter(([, task]) => task.active !== false);
  const assignedIds = new Map<TaskChunk, string>();
  const usedPreviousIds = new Set<string>();

  // Exact semantic titles survive inserts, removals, and reorderings. Match
  // duplicate titles in their existing order so each row remains addressable.
  for (const chunk of taskChunks) {
    const match = previousActive.find(
      ([id, task]) => !usedPreviousIds.has(id) && task.title === chunk.title,
    );
    if (match) {
      assignedIds.set(chunk, match[0]);
      usedPreviousIds.add(match[0]);
    }
  }

  // A same-size snapshot with at least one unchanged title is a title
  // refinement, not a structural replacement. Preserve remaining positions;
  // a single-step plan has the same unambiguous refinement behavior.
  if (
    taskChunks.length === previousActive.length &&
    (usedPreviousIds.size > 0 || taskChunks.length === 1)
  ) {
    taskChunks.forEach((chunk, index) => {
      const previous = previousActive[index];
      if (!assignedIds.has(chunk) && previous && !usedPreviousIds.has(previous[0])) {
        assignedIds.set(chunk, previous[0]);
        usedPreviousIds.add(previous[0]);
      }
    });
  }

  const reservedIds = new Set(params.previousTasks.keys());
  let nextOrdinal =
    Math.max(
      0,
      ...[...reservedIds].map((id) => {
        const match = /^plan_step_(\d+)$/u.exec(id);
        return match ? Number.parseInt(match[1] ?? "0", 10) : 0;
      }),
    ) + 1;
  for (const chunk of taskChunks) {
    if (assignedIds.has(chunk)) {
      continue;
    }
    let id = `plan_step_${nextOrdinal}`;
    while (reservedIds.has(id) || usedPreviousIds.has(id)) {
      nextOrdinal += 1;
      id = `plan_step_${nextOrdinal}`;
    }
    assignedIds.set(chunk, id);
    usedPreviousIds.add(id);
    nextOrdinal += 1;
  }

  const remappedChunks = params.chunks?.map((chunk) =>
    chunk.type === "task_update" ? { ...chunk, id: assignedIds.get(chunk) ?? chunk.id } : chunk,
  );
  const nextTasks = new Map<
    string,
    { active: boolean; title: string; status: SlackPlanTaskStatus }
  >();
  for (const chunk of taskChunks) {
    const id = assignedIds.get(chunk) ?? chunk.id;
    nextTasks.set(id, {
      active: true,
      title: chunk.title,
      status: chunk.status as SlackPlanTaskStatus,
    });
  }
  const orphaned = previousActive.filter(
    ([id, task]) => !nextTasks.has(id) && task.status !== "complete" && task.status !== "error",
  );
  const terminalized = orphaned.map(([id, task]) => {
    const entry = { active: false, title: task.title, status: "complete" as const };
    nextTasks.set(id, entry);
    return {
      type: "task_update" as const,
      id,
      title: task.title,
      status: "complete" as const,
    };
  });
  // Carry retired rows only to reserve their ids; they are not candidates for
  // later positional reconciliation with a different semantic task.
  for (const [id, task] of params.previousTasks) {
    if (!nextTasks.has(id)) {
      nextTasks.set(id, { ...task, active: false });
    }
  }
  // An explicitly cleared source still needs its previous rows retired even
  // when the current build produced no chunks of its own.
  const chunks = remappedChunks?.length
    ? [...remappedChunks, ...terminalized]
    : terminalized.length
      ? terminalized
      : params.chunks;
  return { chunks, tasks: nextTasks };
}

export function buildSlackProgressStreamStartChunks(params: {
  label?: string;
  title?: string;
  plan?: readonly AgentPlanStep[];
}): AnyChunk[] | undefined {
  return buildSlackProgressStreamChunks(params);
}

export function buildSlackProgressStreamUpdateChunks(params: {
  label?: string;
  title?: string;
  plan?: readonly AgentPlanStep[];
}): AnyChunk[] | undefined {
  return buildSlackProgressStreamChunks(params);
}

export function buildSlackProgressStreamCompletionChunks(params: {
  label?: string;
  title?: string;
  plan?: readonly AgentPlanStep[];
  finalInProgressStatus?: SlackPlanTaskStatus;
}): AnyChunk[] | undefined {
  return buildSlackProgressStreamChunks({ ...params, completeInProgress: true });
}

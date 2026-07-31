import { formatChannelProgressDraftText } from "openclaw/plugin-sdk/channel-outbound";
// Slack tests cover progress blocks plugin behavior.
import { describe, expect, it } from "vitest";
import {
  buildSlackProgressDraftBlocks,
  buildSlackProgressStreamCompletionChunks,
  buildSlackProgressStreamStartChunks,
  buildSlackProgressStreamUpdateChunks,
  reconcileSlackNativeTaskChunks,
} from "./progress-blocks.js";

function toolLine(detail: string, label = "Exec") {
  return {
    kind: "tool" as const,
    icon: "🛠️",
    label,
    detail,
    text: `🛠️ ${label}: ${detail}`,
    toolName: label.toLowerCase(),
  };
}

function planUpdate(title: string) {
  return { type: "plan_update", title };
}

function taskUpdate(
  id: unknown,
  title: string,
  status: "pending" | "in_progress" | "complete" | "error",
) {
  return { type: "task_update", id, title, status };
}

describe("buildSlackProgressDraftBlocks", () => {
  it("keeps the portable checklist aligned with shared plan semantics", () => {
    expect(
      formatChannelProgressDraftText({
        entry: { streaming: { mode: "progress", progress: { label: "Working" } } },
        lines: [toolLine("read the config")],
        narration: "Implementing the change.",
        plan: [
          { step: "Inspect", status: "completed" },
          { step: "Patch", status: "in_progress" },
          { step: "Test", status: "pending" },
        ],
      }),
    ).toBe(
      "Working\n\nImplementing the change.\n\n🛠️ read the config\n✅ Inspect\n▸ Patch\n▢ Test",
    );
  });

  it("renders a rich portable fallback with narration, plan, and configured tool rows", () => {
    const blocks = buildSlackProgressDraftBlocks({
      title: "Implementation",
      narration: "Applying the accepted design.",
      lines: [toolLine("run tests")],
      plan: [
        { step: "Inspect code", status: "completed" },
        { step: "Run tests", status: "in_progress" },
      ],
    });

    expect(JSON.stringify(blocks)).toContain("Implementation");
    expect(JSON.stringify(blocks)).toContain("Applying the accepted design.");
    expect(JSON.stringify(blocks)).toContain("✅ Inspect code");
    expect(JSON.stringify(blocks)).toContain("▸ Run tests");
    expect(JSON.stringify(blocks)).toContain("run tests");
  });

  it("does not emit rich fallback blocks without content", () => {
    expect(buildSlackProgressDraftBlocks({ lines: [] })).toBeUndefined();
  });
});

describe("native Slack semantic task chunks", () => {
  it("maps only structured plan steps to native tasks", () => {
    const chunks = buildSlackProgressStreamStartChunks({
      title: "Implement Slack progress cards",
      plan: [
        { step: "Inspect the existing lifecycle", status: "completed" },
        { step: "Implement semantic cards", status: "in_progress" },
        { step: "Validate Slack delivery", status: "pending" },
      ],
    });

    expect(chunks).toEqual([
      planUpdate("Implement Slack progress cards"),
      taskUpdate("plan_step_1", "Inspect the existing lifecycle", "complete"),
      taskUpdate("plan_step_2", "Implement semantic cards", "in_progress"),
      taskUpdate("plan_step_3", "Validate Slack delivery", "pending"),
    ]);
  });

  it("does not synthesize native tasks from raw tool activity or status text", () => {
    expect(buildSlackProgressStreamStartChunks({ title: "Running tests" })).toBeUndefined();
    expect(buildSlackProgressStreamStartChunks({})).toBeUndefined();
  });

  it("uses a neutral plan title when structured steps have no explanation", () => {
    expect(
      buildSlackProgressStreamStartChunks({
        plan: [{ step: "Inspect code", status: "in_progress" }],
      }),
    ).toEqual([
      planUpdate("Task progress"),
      taskUpdate("plan_step_1", "Inspect code", "in_progress"),
    ]);
  });

  it("keeps task identity stable when a step title is refined", () => {
    const initial = buildSlackProgressStreamStartChunks({
      title: "Implementation",
      plan: [
        { step: "Inspect code", status: "in_progress" },
        { step: "Run tests", status: "pending" },
      ],
    });
    const revised = buildSlackProgressStreamUpdateChunks({
      title: "Implementation",
      plan: [
        { step: "Inspect the Slack lifecycle", status: "completed" },
        { step: "Run tests", status: "pending" },
      ],
    });

    expect(initial?.filter((chunk) => chunk.type === "task_update")).toEqual([
      taskUpdate("plan_step_1", "Inspect code", "in_progress"),
      taskUpdate("plan_step_2", "Run tests", "pending"),
    ]);
    expect(revised?.filter((chunk) => chunk.type === "task_update")).toEqual([
      taskUpdate("plan_step_1", "Inspect the Slack lifecycle", "complete"),
      taskUpdate("plan_step_2", "Run tests", "pending"),
    ]);
  });

  it("keeps task identities stable when every title is refined", () => {
    const first = reconcileSlackNativeTaskChunks({
      previousTasks: new Map(),
      chunks: buildSlackProgressStreamStartChunks({
        plan: [
          { step: "Inspect code", status: "in_progress" },
          { step: "Run tests", status: "pending" },
        ],
      }),
    });
    const refined = reconcileSlackNativeTaskChunks({
      previousTasks: first.tasks,
      chunks: buildSlackProgressStreamUpdateChunks({
        plan: [
          { step: "Inspect the Slack lifecycle", status: "completed" },
          { step: "Run focused Slack tests", status: "in_progress" },
        ],
      }),
    });

    expect(refined.chunks?.filter((chunk) => chunk.type === "task_update")).toEqual([
      taskUpdate("plan_step_1", "Inspect the Slack lifecycle", "complete"),
      taskUpdate("plan_step_2", "Run focused Slack tests", "in_progress"),
    ]);
  });

  it("keeps duplicate semantic titles independently addressable", () => {
    const chunks = buildSlackProgressStreamStartChunks({
      plan: [
        { step: "Validate", status: "in_progress" },
        { step: "Validate", status: "pending" },
      ],
    });
    const tasks = (chunks ?? []).filter((chunk) => chunk.type === "task_update");

    expect(tasks[0]?.id).toBe("plan_step_1");
    expect(tasks[1]?.id).toBe("plan_step_2");
  });

  it("reconciles removed plan steps without leaving active native rows", () => {
    const first = reconcileSlackNativeTaskChunks({
      previousTasks: new Map(),
      chunks: buildSlackProgressStreamStartChunks({
        title: "Implementation",
        plan: [
          { step: "Inspect code", status: "completed" },
          { step: "Patch code", status: "in_progress" },
        ],
      }),
    });
    const patchId = [...first.tasks].find(([, task]) => task.title === "Patch code")?.[0];
    const shrunk = reconcileSlackNativeTaskChunks({
      previousTasks: first.tasks,
      chunks: buildSlackProgressStreamUpdateChunks({
        title: "Implementation",
        plan: [{ step: "Inspect code", status: "completed" }],
      }),
    });

    expect(shrunk.chunks).toContainEqual(taskUpdate(patchId, "Patch code", "complete"));
  });

  it("preserves semantic task identities when a plan inserts a new first step", () => {
    const first = reconcileSlackNativeTaskChunks({
      previousTasks: new Map(),
      chunks: buildSlackProgressStreamStartChunks({
        plan: [
          { step: "Inspect code", status: "in_progress" },
          { step: "Run tests", status: "pending" },
        ],
      }),
    });
    const inserted = reconcileSlackNativeTaskChunks({
      previousTasks: first.tasks,
      chunks: buildSlackProgressStreamUpdateChunks({
        plan: [
          { step: "Prepare workspace", status: "completed" },
          { step: "Inspect code", status: "completed" },
          { step: "Run tests", status: "in_progress" },
        ],
      }),
    });

    expect(inserted.chunks?.filter((chunk) => chunk.type === "task_update")).toEqual([
      taskUpdate("plan_step_3", "Prepare workspace", "complete"),
      taskUpdate("plan_step_1", "Inspect code", "complete"),
      taskUpdate("plan_step_2", "Run tests", "in_progress"),
    ]);
  });

  it("maps active completion and error terminal states accurately", () => {
    const plan = [
      { step: "Inspect", status: "completed" as const },
      { step: "Patch", status: "in_progress" as const },
      { step: "Test", status: "pending" as const },
    ];
    const complete = buildSlackProgressStreamCompletionChunks({ plan });
    const error = buildSlackProgressStreamCompletionChunks({
      plan,
      finalInProgressStatus: "error",
    });

    expect(complete?.filter((chunk) => chunk.type === "task_update")).toEqual([
      taskUpdate("plan_step_1", "Inspect", "complete"),
      taskUpdate("plan_step_2", "Patch", "complete"),
      taskUpdate("plan_step_3", "Test", "pending"),
    ]);
    expect(error?.filter((chunk) => chunk.type === "task_update")).toEqual([
      taskUpdate("plan_step_1", "Inspect", "complete"),
      taskUpdate("plan_step_2", "Patch", "error"),
      taskUpdate("plan_step_3", "Test", "pending"),
    ]);
  });

  it("caps native titles to Slack chunk limits", () => {
    const chunks = buildSlackProgressStreamStartChunks({
      title: `Implementation ${"x".repeat(300)}`,
      plan: [{ step: "Inspect", status: "in_progress" }],
    });
    const title = chunks?.[0]?.type === "plan_update" ? chunks[0].title : undefined;

    expect(title).toHaveLength(256);
    expect(title?.endsWith("…")).toBe(true);
  });
});

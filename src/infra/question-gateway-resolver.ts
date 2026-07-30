// Resolves runtime-authored question choices through the Gateway.
import { createHash } from "node:crypto";
import type {
  QuestionGetResult,
  QuestionResolveResult,
} from "../../packages/gateway-protocol/src/schema/questions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { callGateway } from "../gateway/call.js";

const QUESTION_RECORD_ID_PATTERN = /^ask_[a-f0-9]{32}$/u;
// A 128-bit digest keeps identity compact while making collisions negligible;
// reject ambiguous matches below rather than choosing an arbitrary option.
const QUESTION_OPTION_TOKEN_BYTES = 16;
const QUESTION_OPTION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{22}$/u;

/** Compact, order-independent identity for one canonical question option label. */
export function buildQuestionOptionToken(optionValue: string): string {
  return createHash("sha256")
    .update(optionValue, "utf8")
    .digest()
    .subarray(0, QUESTION_OPTION_TOKEN_BYTES)
    .toString("base64url");
}

export type ResolveQuestionOverGatewayResult =
  | { status: "answered"; questionId: string; optionValue: string }
  | { status: "already-terminal"; reason: "already-terminal" | "not-found" };

export type ResolveQuestionOverGatewayParams = {
  cfg: OpenClawConfig;
  questionId: string;
  senderId?: string | null;
  gatewayUrl?: string;
  clientDisplayName?: string;
} & (
  | {
      /** Rendered option value carried by the pressed control (reactions). */
      optionValue: string;
      optionIndex?: never;
      optionToken?: never;
    }
  | {
      /** Compact callback index; mapped to the canonical label via question.get. */
      optionIndex: number;
      optionValue?: never;
      optionToken?: never;
    }
  | {
      /** Compact callback identity; mapped to the canonical label via question.get. */
      optionToken: string;
      optionValue?: never;
      optionIndex?: never;
    }
);

function readTerminalReason(error: unknown): "already-terminal" | "not-found" | undefined {
  if (!(error instanceof Error) || error.name !== "GatewayClientRequestError") {
    return undefined;
  }
  const details = (error as Error & { details?: unknown }).details;
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return undefined;
  }
  const reason = (details as { reason?: unknown }).reason;
  if (reason === "QUESTION_ALREADY_TERMINAL") {
    return "already-terminal";
  }
  return reason === "QUESTION_NOT_FOUND" ? "not-found" : undefined;
}

/** Resolves one rendered option choice against the gateway-owned question. */
export async function resolveQuestionOverGateway(
  params: ResolveQuestionOverGatewayParams,
): Promise<ResolveQuestionOverGatewayResult> {
  if (!QUESTION_RECORD_ID_PATTERN.test(params.questionId)) {
    throw new Error("question resolution requires a valid question record id");
  }
  if (
    params.optionValue === undefined &&
    params.optionToken === undefined &&
    !Number.isInteger(params.optionIndex)
  ) {
    throw new Error("question resolution requires an option value, token, or index");
  }
  if (params.optionValue !== undefined && !params.optionValue) {
    throw new Error("question resolution requires a non-empty option value");
  }
  if (params.optionToken !== undefined && !QUESTION_OPTION_TOKEN_PATTERN.test(params.optionToken)) {
    throw new Error("question resolution requires a valid option token");
  }
  const gatewayOptions = {
    config: params.cfg,
    url: params.gatewayUrl,
    scopes: ["operator.questions" as const],
    clientDisplayName:
      params.clientDisplayName ?? `Question (${params.senderId?.trim() || "unknown"})`,
  };
  let getResult: QuestionGetResult;
  try {
    getResult = await callGateway<QuestionGetResult>({
      ...gatewayOptions,
      method: "question.get",
      params: { id: params.questionId },
    });
  } catch (error) {
    const reason = readTerminalReason(error);
    if (reason) {
      return { status: "already-terminal", reason };
    }
    throw error;
  }

  const record = getResult.question;
  if (record.status !== "pending") {
    return { status: "already-terminal", reason: "already-terminal" };
  }
  const question = record.questions.length === 1 ? record.questions[0] : undefined;
  if (!question || question.multiSelect || question.isSecret) {
    throw new Error("question button resolution requires one tappable question");
  }
  const tokenMatches =
    params.optionToken === undefined
      ? []
      : question.options.filter(
          (option) => buildQuestionOptionToken(option.label) === params.optionToken,
        );
  if (tokenMatches.length > 1) {
    throw new Error("question resolution token matches multiple declared options");
  }
  const optionValue =
    params.optionValue ??
    tokenMatches[0]?.label ??
    question.options[params.optionIndex as number]?.label;
  if (!optionValue) {
    throw new Error("question resolution choice does not match a declared option");
  }
  try {
    await callGateway<QuestionResolveResult>({
      ...gatewayOptions,
      method: "question.resolve",
      params: {
        id: params.questionId,
        answers: { answers: { [question.questionId]: [optionValue] } },
        resolvedBy: params.senderId?.trim() || undefined,
      },
    });
  } catch (error) {
    const reason = readTerminalReason(error);
    if (reason) {
      return { status: "already-terminal", reason };
    }
    throw error;
  }
  return { status: "answered", questionId: question.questionId, optionValue };
}

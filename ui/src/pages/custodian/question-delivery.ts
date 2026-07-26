import type { CustodianSendDelivery, CustodianSendOutcome } from "./event-nudge.ts";
import { questionUncertainty } from "./event-nudge.ts";
import { restoreCustodianQrCodes, type CustodianMessage } from "./transcript.ts";

export type CustodianQuestionDeliverySnapshot = {
  previousAnsweredQuestions: ReadonlySet<string>;
  previousQuestionReplyUncertain: boolean;
  qrQuestionReply: boolean;
  restorableMessages: readonly CustodianMessage[] | null;
};

export function captureCustodianQuestionDelivery(params: {
  messages: readonly CustodianMessage[];
  answeredQuestions: ReadonlySet<string>;
  questionReplyUncertain: boolean;
  questionReply: boolean;
}): CustodianQuestionDeliverySnapshot {
  return {
    previousAnsweredQuestions: params.answeredQuestions,
    previousQuestionReplyUncertain: params.questionReplyUncertain,
    qrQuestionReply:
      params.questionReply && params.messages.some((entry) => entry.qrCodePngBase64 !== undefined),
    restorableMessages: params.questionReply ? params.messages : null,
  };
}

export function releaseCustodianQuestionRestoration(
  snapshot: CustodianQuestionDeliverySnapshot,
): void {
  snapshot.restorableMessages = null;
}

export function reconcileCustodianQuestionDelivery(params: {
  snapshot: CustodianQuestionDeliverySnapshot;
  messages: readonly CustodianMessage[];
  answeredQuestions: ReadonlySet<string>;
  outcome: CustodianSendOutcome;
  delivery: CustodianSendDelivery;
}): {
  messages: CustodianMessage[];
  answeredQuestions: ReadonlySet<string>;
  questionReplyUncertain: boolean;
} {
  let messages = [...params.messages];
  let answeredQuestions = params.answeredQuestions;
  if (
    params.outcome === "rejected" &&
    (!params.snapshot.qrQuestionReply || params.delivery === "unsent")
  ) {
    answeredQuestions = params.snapshot.previousAnsweredQuestions;
    if (params.delivery === "unsent" && params.snapshot.restorableMessages) {
      messages = restoreCustodianQrCodes(messages, params.snapshot.restorableMessages);
    }
  }
  return {
    messages,
    answeredQuestions,
    questionReplyUncertain: questionUncertainty(
      params.snapshot.previousQuestionReplyUncertain,
      params.outcome,
    ),
  };
}

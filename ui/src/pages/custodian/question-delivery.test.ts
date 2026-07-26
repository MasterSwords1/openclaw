// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  captureCustodianQuestionDelivery,
  reconcileCustodianQuestionDelivery,
  releaseCustodianQuestionRestoration,
} from "./question-delivery.ts";
import type { CustodianMessage } from "./transcript.ts";

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function questionMessage(qrCodePngBase64?: string): CustodianMessage {
  return {
    id: 7,
    role: "assistant",
    text: "Continue setup.",
    at: 1,
    question: {
      id: "next",
      header: "Next",
      question: "Continue?",
      presentation: qrCodePngBase64 ? "action" : "choices",
      options: qrCodePngBase64
        ? [{ label: "Continue" }]
        : [{ label: "Telegram" }, { label: "Discord" }],
      isOther: false,
      allowSkip: !qrCodePngBase64,
    },
    ...(qrCodePngBase64 ? { qrCodePngBase64 } : {}),
  };
}

describe("custodian question delivery", () => {
  it("restores a regular question after a definitive sent rejection", () => {
    const messages = [questionMessage()];
    const previousAnsweredQuestions = new Set<string>();
    const snapshot = captureCustodianQuestionDelivery({
      messages,
      answeredQuestions: previousAnsweredQuestions,
      questionReplyUncertain: false,
      questionReply: true,
    });
    releaseCustodianQuestionRestoration(snapshot);

    const result = reconcileCustodianQuestionDelivery({
      snapshot,
      messages,
      answeredQuestions: new Set(["7:next"]),
      outcome: "rejected",
      delivery: "sent",
    });

    expect(result.answeredQuestions).toBe(previousAnsweredQuestions);
    expect(result.questionReplyUncertain).toBe(false);
  });

  it("restores QR bytes only when acknowledgement delivery is unsent", () => {
    const messages = [questionMessage(PNG_BASE64)];
    const snapshot = captureCustodianQuestionDelivery({
      messages,
      answeredQuestions: new Set(),
      questionReplyUncertain: false,
      questionReply: true,
    });
    const scrubbed = messages.map(({ qrCodePngBase64: _qrCodePngBase64, ...message }) => message);

    const unsent = reconcileCustodianQuestionDelivery({
      snapshot,
      messages: scrubbed,
      answeredQuestions: new Set(["7:next"]),
      outcome: "rejected",
      delivery: "unsent",
    });
    expect(unsent.messages[0]?.qrCodePngBase64).toBe(PNG_BASE64);

    releaseCustodianQuestionRestoration(snapshot);
    const sent = reconcileCustodianQuestionDelivery({
      snapshot,
      messages: scrubbed,
      answeredQuestions: new Set(["7:next"]),
      outcome: "rejected",
      delivery: "sent",
    });
    expect(sent.messages[0]?.qrCodePngBase64).toBeUndefined();
    expect(sent.answeredQuestions).toEqual(new Set(["7:next"]));
  });
});

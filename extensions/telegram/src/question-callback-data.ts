// Telegram-private ask_user callback envelope.
const TELEGRAM_QUESTION_INDEX_CALLBACK_PREFIX = "tgq1:";
const TELEGRAM_QUESTION_TOKEN_CALLBACK_PREFIX = "tgq2:";
const TELEGRAM_CALLBACK_DATA_MAX_BYTES = 64;
const QUESTION_RECORD_ID_PATTERN = /^ask_[a-f0-9]{32}$/u;
// A 22-character option token leaves the tgq2 envelope exactly at Telegram's limit.
const QUESTION_OPTION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{22}$/u;

export type TelegramQuestionCallback =
  | { questionId: string; optionIndex: number; optionToken?: never }
  | { questionId: string; optionToken: string; optionIndex?: never };

export function hasTelegramQuestionCallbackPrefix(data?: string | null): boolean {
  return (
    data?.startsWith(TELEGRAM_QUESTION_INDEX_CALLBACK_PREFIX) === true ||
    data?.startsWith(TELEGRAM_QUESTION_TOKEN_CALLBACK_PREFIX) === true
  );
}

export function buildTelegramQuestionCallbackData(
  callback: TelegramQuestionCallback,
): string | undefined {
  if (!QUESTION_RECORD_ID_PATTERN.test(callback.questionId)) {
    return undefined;
  }
  const data =
    callback.optionToken !== undefined
      ? QUESTION_OPTION_TOKEN_PATTERN.test(callback.optionToken)
        ? `${TELEGRAM_QUESTION_TOKEN_CALLBACK_PREFIX}${callback.questionId}:${callback.optionToken}`
        : undefined
      : Number.isInteger(callback.optionIndex) &&
          callback.optionIndex >= 0 &&
          callback.optionIndex <= 3
        ? `${TELEGRAM_QUESTION_INDEX_CALLBACK_PREFIX}${callback.questionId}:${callback.optionIndex}`
        : undefined;
  if (!data) {
    return undefined;
  }
  return Buffer.byteLength(data, "utf8") <= TELEGRAM_CALLBACK_DATA_MAX_BYTES ? data : undefined;
}

export function parseTelegramQuestionCallbackData(
  data?: string | null,
): TelegramQuestionCallback | null {
  if (
    !hasTelegramQuestionCallbackPrefix(data) ||
    !data ||
    Buffer.byteLength(data, "utf8") > TELEGRAM_CALLBACK_DATA_MAX_BYTES
  ) {
    return null;
  }
  const indexMatch = /^tgq1:(ask_[a-f0-9]{32}):([0-3])$/u.exec(data);
  if (indexMatch?.[1] && indexMatch[2]) {
    return { questionId: indexMatch[1], optionIndex: Number(indexMatch[2]) };
  }
  const tokenMatch = /^tgq2:(ask_[a-f0-9]{32}):([A-Za-z0-9_-]{22})$/u.exec(data);
  return tokenMatch?.[1] && tokenMatch[2]
    ? { questionId: tokenMatch[1], optionToken: tokenMatch[2] }
    : null;
}

import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";

const TELEGRAM_PHOTO_LIMIT_ERROR_RE = /\b(?:PHOTO_INVALID_DIMENSIONS|PHOTO_TOO_BIG)\b/i;
const TELEGRAM_VOICE_MESSAGES_FORBIDDEN_MARKER = "VOICE_MESSAGES_FORBIDDEN";

function resolveTelegramErrorDescription(error: unknown): string {
  const description =
    error && typeof error === "object" && "description" in error
      ? (error as { description?: unknown }).description
      : undefined;
  return typeof description === "string" ? description : formatErrorMessage(error);
}

export function isTelegramPhotoLimitError(error: unknown): boolean {
  return TELEGRAM_PHOTO_LIMIT_ERROR_RE.test(resolveTelegramErrorDescription(error));
}

export function isTelegramVoiceMessagesForbiddenError(error: unknown): boolean {
  return resolveTelegramErrorDescription(error).includes(TELEGRAM_VOICE_MESSAGES_FORBIDDEN_MARKER);
}

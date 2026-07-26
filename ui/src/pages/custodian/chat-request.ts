import {
  canDecodeSystemAgentQrCodePngBase64,
  isDecodableSystemAgentQrCodePngBase64,
  type SystemAgentChatParams,
  type SystemAgentChatResult,
} from "@openclaw/gateway-protocol";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import { t } from "../../i18n/index.ts";

const SYSTEM_AGENT_CHAT_TIMEOUT_MS = 190_000;
const INVALID_CHAT_PARAMS_MESSAGE = "invalid openclaw.chat params";
const legacyChatClientGenerations = new WeakMap<GatewayBrowserClient, number>();
const qrCapableClientGenerations = new WeakMap<GatewayBrowserClient, number>();

type UnknownRecord = Record<string, unknown>;

function asClosedRecord(value: unknown, allowedKeys: ReadonlySet<string>): UnknownRecord | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as UnknownRecord;
  return Object.keys(record).every((key) => allowedKeys.has(key)) ? record : null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

const QR_RESULT_KEYS = new Set([
  "sessionId",
  "reply",
  "wizardInputPending",
  "action",
  "qrCodePngBase64",
  "question",
]);
// The QR subtype is a closed single-action contract. General-question fields
// such as isOther and skipAction are deliberately invalid here.
const QR_QUESTION_KEYS = new Set(["id", "header", "question", "options", "allowSkip"]);
const QR_OPTION_KEYS = new Set(["label", "description", "recommended", "reply"]);

function hasValidQrResultShape(value: unknown): value is SystemAgentChatResult {
  const result = asClosedRecord(value, QR_RESULT_KEYS);
  const question = asClosedRecord(result?.question, QR_QUESTION_KEYS);
  if (
    !result ||
    !question ||
    !isNonEmptyString(result.sessionId) ||
    !isNonEmptyString(result.reply) ||
    result.wizardInputPending !== true ||
    result.action !== "none" ||
    !isNonEmptyString(result.qrCodePngBase64) ||
    !isNonEmptyString(question.id) ||
    !isNonEmptyString(question.header) ||
    !isNonEmptyString(question.question) ||
    question.allowSkip !== false ||
    !Array.isArray(question.options) ||
    question.options.length !== 1
  ) {
    return false;
  }
  const option = asClosedRecord(question.options[0], QR_OPTION_KEYS);
  return Boolean(
    option &&
    isNonEmptyString(option.label) &&
    (option.description === undefined || typeof option.description === "string") &&
    (option.recommended === undefined || typeof option.recommended === "boolean") &&
    (option.reply === undefined || isNonEmptyString(option.reply)),
  );
}

function shouldRetryWithoutCapabilities(error: unknown, params: SystemAgentChatParams): boolean {
  return (
    params.capabilities?.qrCodePng === true &&
    error instanceof GatewayRequestError &&
    error.code === "INVALID_REQUEST" &&
    error.message.toLowerCase().includes(INVALID_CHAT_PARAMS_MESSAGE)
  );
}

function validateChatResult(
  result: unknown,
): SystemAgentChatResult | Promise<SystemAgentChatResult> {
  const record =
    result !== null && typeof result === "object" && !Array.isArray(result)
      ? (result as UnknownRecord)
      : null;
  if (!record || !Object.hasOwn(record, "qrCodePngBase64")) {
    return result as SystemAgentChatResult;
  }
  if (!hasValidQrResultShape(record)) {
    throw new Error(t("custodian.invalidSetupQrCode"));
  }
  return isDecodableSystemAgentQrCodePngBase64(record.qrCodePngBase64).then((valid) => {
    if (!valid) {
      throw new Error(t("custodian.invalidSetupQrCode"));
    }
    return record;
  });
}

export async function requestCustodianChat(params: {
  client: GatewayBrowserClient;
  request: SystemAgentChatParams;
  onSent: () => void;
  onCompatibilityRetry: () => void;
  qrCodeDecoderAvailable?: boolean;
}): Promise<SystemAgentChatResult> {
  const options = {
    timeoutMs: SYSTEM_AGENT_CHAT_TIMEOUT_MS,
    onSent: params.onSent,
  };
  if (legacyChatClientGenerations.get(params.client) === params.client.connectionGeneration) {
    return validateChatResult(
      await params.client.request<SystemAgentChatResult>("openclaw.chat", params.request, options),
    );
  }
  if (!(params.qrCodeDecoderAvailable ?? canDecodeSystemAgentQrCodePngBase64())) {
    return validateChatResult(
      await params.client.request<SystemAgentChatResult>("openclaw.chat", params.request, options),
    );
  }
  const request: SystemAgentChatParams = {
    ...params.request,
    capabilities: { qrCodePng: true },
  };
  if (qrCapableClientGenerations.get(params.client) === params.client.connectionGeneration) {
    return validateChatResult(
      await params.client.request<SystemAgentChatResult>("openclaw.chat", request, options),
    );
  }
  let tentativeSent = false;
  let result: SystemAgentChatResult;
  try {
    result = await params.client.request<SystemAgentChatResult>("openclaw.chat", request, {
      ...options,
      onSent: () => {
        tentativeSent = true;
      },
    });
  } catch (error) {
    if (!shouldRetryWithoutCapabilities(error, request)) {
      if (tentativeSent) {
        params.onSent();
      }
      throw error;
    }
    legacyChatClientGenerations.set(params.client, params.client.connectionGeneration);
    params.onCompatibilityRetry();
    const legacyRequest = { ...request };
    delete legacyRequest.capabilities;
    return validateChatResult(
      await params.client.request<SystemAgentChatResult>("openclaw.chat", legacyRequest, options),
    );
  }
  qrCapableClientGenerations.set(params.client, params.client.connectionGeneration);
  if (tentativeSent) {
    params.onSent();
  }
  return validateChatResult(result);
}

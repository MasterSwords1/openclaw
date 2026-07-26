import {
  isSystemAgentQrCodePngBase64,
  type SystemAgentChatParams,
  type SystemAgentChatResult,
} from "@openclaw/gateway-protocol";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import { t } from "../../i18n/index.ts";

const SYSTEM_AGENT_CHAT_TIMEOUT_MS = 190_000;
const INVALID_CHAT_PARAMS_MESSAGE = "invalid openclaw.chat params";
const legacyChatClientGenerations = new WeakMap<GatewayBrowserClient, number>();

function shouldRetryWithoutCapabilities(error: unknown, params: SystemAgentChatParams): boolean {
  return (
    params.capabilities?.qrCodePng === true &&
    error instanceof GatewayRequestError &&
    error.code === "INVALID_REQUEST" &&
    error.message.toLowerCase().includes(INVALID_CHAT_PARAMS_MESSAGE)
  );
}

function validateChatResult(result: SystemAgentChatResult): SystemAgentChatResult {
  if (
    result.qrCodePngBase64 !== undefined &&
    !isSystemAgentQrCodePngBase64(result.qrCodePngBase64)
  ) {
    throw new Error(t("custodian.invalidSetupQrCode"));
  }
  return result;
}

export async function requestCustodianChat(params: {
  client: GatewayBrowserClient;
  request: SystemAgentChatParams;
  onSent: () => void;
  onCompatibilityRetry: () => void;
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
  const request: SystemAgentChatParams = {
    ...params.request,
    capabilities: { qrCodePng: true },
  };
  try {
    return validateChatResult(
      await params.client.request<SystemAgentChatResult>("openclaw.chat", request, options),
    );
  } catch (error) {
    if (!shouldRetryWithoutCapabilities(error, request)) {
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
}

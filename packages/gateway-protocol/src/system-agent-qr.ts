export const SYSTEM_AGENT_QR_CODE_PNG_BASE64_MAX_LENGTH = 1_000_000;

export const SYSTEM_AGENT_QR_CODE_PNG_BASE64_PATTERN =
  "^(?=iVBORw0KGgo)(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$";

const SYSTEM_AGENT_QR_CODE_PNG_BASE64_REGEX = new RegExp(
  SYSTEM_AGENT_QR_CODE_PNG_BASE64_PATTERN,
  "u",
);

export function isSystemAgentQrCodePngBase64(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= SYSTEM_AGENT_QR_CODE_PNG_BASE64_MAX_LENGTH &&
    SYSTEM_AGENT_QR_CODE_PNG_BASE64_REGEX.test(value)
  );
}

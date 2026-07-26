export const SYSTEM_AGENT_QR_CODE_PNG_BASE64_MAX_LENGTH = 1_000_000;

export const SYSTEM_AGENT_QR_CODE_PNG_BASE64_PATTERN =
  "^(?=iVBORw0KGgo)(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$";

const SYSTEM_AGENT_QR_CODE_PNG_BASE64_REGEX = new RegExp(
  SYSTEM_AGENT_QR_CODE_PNG_BASE64_PATTERN,
  "u",
);

const PNG_SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
const PNG_IHDR_LENGTH = 13;

function decodeBase64(value: string): Uint8Array | null {
  try {
    const binary = globalThis.atob(value);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset);
}

function readChunkType(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + 4));
}

function isCompletePng(bytes: Uint8Array): boolean {
  if (
    bytes.length < PNG_SIGNATURE.length ||
    PNG_SIGNATURE.some((byte, index) => bytes[index] !== byte)
  ) {
    return false;
  }
  let offset = PNG_SIGNATURE.length;
  let chunkIndex = 0;
  let sawImageData = false;
  while (offset + 12 <= bytes.length) {
    const dataLength = readUint32(bytes, offset);
    const typeOffset = offset + 4;
    const dataOffset = typeOffset + 4;
    const crcOffset = dataOffset + dataLength;
    const nextOffset = crcOffset + 4;
    if (nextOffset > bytes.length) {
      return false;
    }
    const type = readChunkType(bytes, typeOffset);
    if (chunkIndex === 0 && (type !== "IHDR" || dataLength !== PNG_IHDR_LENGTH)) {
      return false;
    }
    if (type === "IHDR") {
      if (
        chunkIndex !== 0 ||
        readUint32(bytes, dataOffset) === 0 ||
        readUint32(bytes, dataOffset + 4) === 0
      ) {
        return false;
      }
    } else if (type === "IDAT") {
      sawImageData = true;
    } else if (type === "IEND") {
      return dataLength === 0 && sawImageData && nextOffset === bytes.length;
    }
    offset = nextOffset;
    chunkIndex += 1;
  }
  return false;
}

export function isSystemAgentQrCodePngBase64(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length > SYSTEM_AGENT_QR_CODE_PNG_BASE64_MAX_LENGTH ||
    !SYSTEM_AGENT_QR_CODE_PNG_BASE64_REGEX.test(value)
  ) {
    return false;
  }
  const bytes = decodeBase64(value);
  return bytes !== null && isCompletePng(bytes);
}

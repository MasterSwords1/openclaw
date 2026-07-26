export const SYSTEM_AGENT_QR_CODE_PNG_BASE64_MAX_LENGTH = 1_000_000;

export const SYSTEM_AGENT_QR_CODE_PNG_BASE64_PATTERN =
  "^(?=iVBORw0KGgo)(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/][AQgw]==|[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=)?$";

const SYSTEM_AGENT_QR_CODE_PNG_BASE64_REGEX = new RegExp(
  SYSTEM_AGENT_QR_CODE_PNG_BASE64_PATTERN,
  "u",
);

const PNG_SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
const PNG_IHDR_LENGTH = 13;
const PNG_MAX_QR_DIMENSION = 4096;
const PNG_MAX_DECODED_BYTES = 16 * 1024 * 1024;
const PNG_ANIMATION_CHUNKS = new Set(["acTL", "fcTL", "fdAT"]);
const PNG_COMPRESSED_METADATA_CHUNKS = new Set(["iCCP", "iTXt", "zTXt"]);

type PngScanlineLayout = {
  rowBytes: number;
  rows: number;
};

type ParsedPng = {
  compressedData: Uint8Array;
  decodedLength: number;
  scanlines: PngScanlineLayout[];
};

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

function pngChunkCrc32(bytes: Uint8Array, start: number, end: number): number {
  let crc = 0xffffffff;
  for (let index = start; index < end; index += 1) {
    crc ^= bytes[index] as number;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function resolvePngBitsPerPixel(bitDepth: number, colorType: number): number | null {
  const channelsByColorType: Readonly<Record<number, number>> = {
    0: 1,
    2: 3,
    3: 1,
    4: 2,
    6: 4,
  };
  const allowedBitDepths: Readonly<Record<number, readonly number[]>> = {
    0: [1, 2, 4, 8, 16],
    2: [8, 16],
    3: [1, 2, 4, 8],
    4: [8, 16],
    6: [8, 16],
  };
  const channels = channelsByColorType[colorType];
  if (channels === undefined || !allowedBitDepths[colorType]?.includes(bitDepth)) {
    return null;
  }
  return channels * bitDepth;
}

function passSize(size: number, start: number, step: number): number {
  return size <= start ? 0 : Math.ceil((size - start) / step);
}

function buildScanlineLayout(params: {
  width: number;
  height: number;
  bitsPerPixel: number;
  interlace: number;
}): { decodedLength: number; scanlines: PngScanlineLayout[] } | null {
  const passes =
    params.interlace === 0
      ? [[0, 0, 1, 1] as const]
      : ([
          [0, 0, 8, 8],
          [4, 0, 8, 8],
          [0, 4, 4, 8],
          [2, 0, 4, 4],
          [0, 2, 2, 4],
          [1, 0, 2, 2],
          [0, 1, 1, 2],
        ] as const);
  const scanlines: PngScanlineLayout[] = [];
  let decodedLength = 0;
  for (const [startX, startY, stepX, stepY] of passes) {
    const width = passSize(params.width, startX, stepX);
    const rows = passSize(params.height, startY, stepY);
    if (width === 0 || rows === 0) {
      continue;
    }
    const rowBytes = Math.ceil((width * params.bitsPerPixel) / 8);
    decodedLength += rows * (rowBytes + 1);
    if (!Number.isSafeInteger(decodedLength) || decodedLength > PNG_MAX_DECODED_BYTES) {
      return null;
    }
    scanlines.push({ rowBytes, rows });
  }
  return decodedLength > 0 ? { decodedLength, scanlines } : null;
}

function joinByteArrays(parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function parsePng(value: unknown): ParsedPng | null {
  if (
    typeof value !== "string" ||
    value.length > SYSTEM_AGENT_QR_CODE_PNG_BASE64_MAX_LENGTH ||
    !SYSTEM_AGENT_QR_CODE_PNG_BASE64_REGEX.test(value)
  ) {
    return null;
  }
  const bytes = decodeBase64(value);
  if (
    bytes === null ||
    bytes.length < PNG_SIGNATURE.length ||
    PNG_SIGNATURE.some((byte, index) => bytes[index] !== byte)
  ) {
    return null;
  }

  let offset = PNG_SIGNATURE.length;
  let chunkIndex = 0;
  let image: {
    width: number;
    height: number;
    bitDepth: number;
    colorType: number;
    bitsPerPixel: number;
    interlace: number;
  } | null = null;
  let sawPalette = false;
  let sawImageData = false;
  let imageDataEnded = false;
  const imageDataParts: Uint8Array[] = [];
  while (offset + 12 <= bytes.length) {
    const dataLength = readUint32(bytes, offset);
    const typeOffset = offset + 4;
    const dataOffset = typeOffset + 4;
    const crcOffset = dataOffset + dataLength;
    const nextOffset = crcOffset + 4;
    if (
      nextOffset > bytes.length ||
      readUint32(bytes, crcOffset) !== pngChunkCrc32(bytes, typeOffset, crcOffset)
    ) {
      return null;
    }
    const type = readChunkType(bytes, typeOffset);
    if (
      !/^[A-Za-z]{4}$/u.test(type) ||
      (chunkIndex === 0 && (type !== "IHDR" || dataLength !== PNG_IHDR_LENGTH))
    ) {
      return null;
    }
    if (type === "IHDR") {
      const width = readUint32(bytes, dataOffset);
      const height = readUint32(bytes, dataOffset + 4);
      const bitDepth = bytes[dataOffset + 8] ?? -1;
      const colorType = bytes[dataOffset + 9] ?? -1;
      const bitsPerPixel = resolvePngBitsPerPixel(bitDepth, colorType);
      const interlace = bytes[dataOffset + 12] ?? -1;
      if (
        chunkIndex !== 0 ||
        width === 0 ||
        height === 0 ||
        width !== height ||
        width > PNG_MAX_QR_DIMENSION ||
        bitsPerPixel === null ||
        bytes[dataOffset + 10] !== 0 ||
        bytes[dataOffset + 11] !== 0 ||
        (interlace !== 0 && interlace !== 1)
      ) {
        return null;
      }
      image = { width, height, bitDepth, colorType, bitsPerPixel, interlace };
    } else if (type === "PLTE") {
      if (
        image === null ||
        sawPalette ||
        sawImageData ||
        dataLength < 3 ||
        dataLength > 768 ||
        dataLength % 3 !== 0 ||
        image.colorType === 0 ||
        image.colorType === 4 ||
        (image.colorType === 3 && dataLength / 3 > 2 ** image.bitDepth)
      ) {
        return null;
      }
      sawPalette = true;
    } else if (type === "IDAT") {
      if (image === null || imageDataEnded) {
        return null;
      }
      sawImageData = true;
      imageDataParts.push(bytes.slice(dataOffset, crcOffset));
    } else if (type === "IEND") {
      if (
        dataLength !== 0 ||
        nextOffset !== bytes.length ||
        image === null ||
        imageDataParts.length === 0 ||
        (image.colorType === 3 && !sawPalette)
      ) {
        return null;
      }
      const layout = buildScanlineLayout(image);
      return layout
        ? {
            compressedData: joinByteArrays(imageDataParts),
            decodedLength: layout.decodedLength,
            scanlines: layout.scanlines,
          }
        : null;
    } else {
      imageDataEnded = sawImageData;
      if (
        /^[A-Z]/u.test(type) ||
        PNG_ANIMATION_CHUNKS.has(type) ||
        PNG_COMPRESSED_METADATA_CHUNKS.has(type)
      ) {
        return null;
      }
    }
    offset = nextOffset;
    chunkIndex += 1;
  }
  return null;
}

export function isSystemAgentQrCodePngBase64(value: unknown): value is string {
  return parsePng(value) !== null;
}

export function canDecodeSystemAgentQrCodePngBase64(): boolean {
  return typeof globalThis.DecompressionStream === "function";
}

export async function isDecodableSystemAgentQrCodePngBase64(value: unknown): Promise<boolean> {
  const png = parsePng(value);
  if (!png || !canDecodeSystemAgentQrCodePngBase64()) {
    return false;
  }
  try {
    const decompressor = new globalThis.DecompressionStream("deflate");
    const compressedData = new Uint8Array(png.compressedData.byteLength);
    compressedData.set(png.compressedData);
    const writePromise = (async () => {
      const writer = decompressor.writable.getWriter();
      await writer.write(compressedData);
      await writer.close();
      return true;
    })().catch(() => false);
    const reader = decompressor.readable.getReader();
    const decoded = new Uint8Array(png.decodedLength);
    let offset = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      if (offset + chunk.value.byteLength > decoded.byteLength) {
        await reader.cancel();
        return false;
      }
      decoded.set(chunk.value, offset);
      offset += chunk.value.byteLength;
    }
    if (offset !== decoded.byteLength) {
      return false;
    }
    if (!(await writePromise)) {
      return false;
    }
    let scanlineOffset = 0;
    for (const layout of png.scanlines) {
      for (let row = 0; row < layout.rows; row += 1) {
        const filter = decoded[scanlineOffset];
        if (filter === undefined || filter > 4) {
          return false;
        }
        scanlineOffset += layout.rowBytes + 1;
      }
    }
    return scanlineOffset === decoded.byteLength;
  } catch {
    return false;
  }
}

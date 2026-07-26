import { deflateSync } from "node:zlib";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  isDecodableSystemAgentQrCodePngBase64,
  isSystemAgentQrCodePngBase64,
  SYSTEM_AGENT_QR_CODE_PNG_BASE64_MAX_LENGTH,
  validateSystemAgentChatHistoryParams,
  validateSystemAgentSetupVerifyParams,
} from "../index.js";
import {
  SystemAgentChatParamsSchema,
  SystemAgentChatResultSchema,
  SystemAgentChatQuestionSchema,
  SystemAgentChatHistoryResultSchema,
  SystemAgentSetupDetectResultSchema,
  SystemAgentSetupVerifyResultSchema,
} from "./openclaw.js";

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const ANIMATED_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAABUAAAAVCAIAAAAmdTLBAAAACXBIWXMAAAAAAAAAAQCEeRdzAAAACGFjVEwAAAACAAAAAPONk3AAAAAaZmNUTAAAAAAAAAAVAAAAFQAAAAAAAAAAAAEAAgAAYFitrAAAAB5JREFUeJxj/P//PwMFgIUSzaP6R/WP6h/VP4T1AwCHtgNPl4qCogAAABpmY1RMAAAAAQAAABUAAAAVAAAAAAAAAAAAAQACAAD7K0d4AAAALmZkQVQAAAACeJxjZGRkZCAF/P//H5nLQpJmTDCqf1T/qP4B1I+Wn+lu/xDXDwC+cwZPQOmjYAAAAABJRU5ErkJggg==";

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

function withPngDimensions(value: string, width: number, height: number): string {
  const bytes = Uint8Array.from(globalThis.atob(value), (character) => character.charCodeAt(0));
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  view.setUint32(29, pngChunkCrc32(bytes, 12, 29));
  return globalThis.btoa(String.fromCharCode(...bytes));
}

function withPngChunk(value: string, type: string, data: Uint8Array): string {
  const source = Buffer.from(value, "base64");
  const typeBytes = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.byteLength);
  chunk.writeUInt32BE(data.byteLength, 0);
  typeBytes.copy(chunk, 4);
  chunk.set(data, 8);
  chunk.writeUInt32BE(pngChunkCrc32(chunk, 4, 8 + data.byteLength), 8 + data.byteLength);
  return Buffer.concat([source.subarray(0, 33), chunk, source.subarray(33)]).toString("base64");
}

function buildCompressedProfilePng(): string {
  const compressedProfile = deflateSync(new Uint8Array(17 * 1024 * 1024), { level: 9 });
  return withPngChunk(
    PNG_BASE64,
    "iCCP",
    Buffer.concat([Buffer.from("qr-profile\0", "binary"), Buffer.from([0]), compressedProfile]),
  );
}

describe("OpenClaw chat params protocol", () => {
  it("accepts an additive QR rendering capability", () => {
    expect(
      Value.Check(SystemAgentChatParamsSchema, {
        sessionId: "setup-session",
        capabilities: { qrCodePng: true },
      }),
    ).toBe(true);
    expect(
      Value.Check(SystemAgentChatParamsSchema, {
        sessionId: "setup-session",
        capabilities: { qrCodePng: "yes" },
      }),
    ).toBe(false);
  });
});

describe("OpenClaw chat question protocol", () => {
  const question = {
    id: "onboarding-next-step",
    header: "Next step",
    question: "What would you like to do first?",
    options: [{ label: "Talk to my agent" }, { label: "Connect a channel" }],
  };

  it("accepts the additive exit skip action and rejects unknown actions", () => {
    expect(Value.Check(SystemAgentChatQuestionSchema, question)).toBe(true);
    expect(Value.Check(SystemAgentChatQuestionSchema, { ...question, skipAction: "exit" })).toBe(
      true,
    );
    expect(Value.Check(SystemAgentChatQuestionSchema, { ...question, skipAction: "dismiss" })).toBe(
      false,
    );
  });

  it("reserves single acknowledgement actions for QR results", () => {
    expect(
      Value.Check(SystemAgentChatQuestionSchema, {
        ...question,
        options: [{ label: "Continue" }],
        allowSkip: false,
      }),
    ).toBe(false);
  });
});

describe("OpenClaw chat result protocol", () => {
  it("accepts an additive PNG QR image", async () => {
    expect(
      Value.Check(SystemAgentChatResultSchema, {
        sessionId: "setup-session",
        reply: "Scan this QR code, then continue.",
        action: "none",
        wizardInputPending: true,
        qrCodePngBase64: PNG_BASE64,
        question: {
          id: "setup-qr",
          header: "Scan QR code",
          question: "Scan the code, then continue.",
          options: [{ label: "Continue" }],
          allowSkip: false,
        },
      }),
    ).toBe(true);
    expect(isSystemAgentQrCodePngBase64(PNG_BASE64)).toBe(true);
    await expect(isDecodableSystemAgentQrCodePngBase64(PNG_BASE64)).resolves.toBe(true);
    const noncanonicalPadding = `${PNG_BASE64.slice(0, -2)}J=`;
    expect(Buffer.from(noncanonicalPadding, "base64")).toEqual(Buffer.from(PNG_BASE64, "base64"));
    expect(isSystemAgentQrCodePngBase64(noncanonicalPadding)).toBe(false);
    await expect(isDecodableSystemAgentQrCodePngBase64(noncanonicalPadding)).resolves.toBe(false);
    expect(isSystemAgentQrCodePngBase64("cG5n")).toBe(false);
    expect(isSystemAgentQrCodePngBase64("iVBORw0KGgo=")).toBe(false);
    expect(isSystemAgentQrCodePngBase64(PNG_BASE64.slice(0, -4))).toBe(false);
    expect(isSystemAgentQrCodePngBase64(ANIMATED_PNG_BASE64)).toBe(false);
    await expect(isDecodableSystemAgentQrCodePngBase64(ANIMATED_PNG_BASE64)).resolves.toBe(false);
    const compressedProfilePng = buildCompressedProfilePng();
    expect(compressedProfilePng.length).toBeLessThan(SYSTEM_AGENT_QR_CODE_PNG_BASE64_MAX_LENGTH);
    expect(isSystemAgentQrCodePngBase64(compressedProfilePng)).toBe(false);
    await expect(isDecodableSystemAgentQrCodePngBase64(compressedProfilePng)).resolves.toBe(false);
    expect(isSystemAgentQrCodePngBase64(withPngDimensions(PNG_BASE64, 2, 1))).toBe(false);
    expect(isSystemAgentQrCodePngBase64(withPngDimensions(PNG_BASE64, 4097, 4097))).toBe(false);
    expect(
      isSystemAgentQrCodePngBase64(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB/wAAAADAahcYAAAAB0lEQVRnYXJiYWdliKMwNwAAAABJRU5ErkJggg==",
      ),
    ).toBe(false);
    await expect(
      isDecodableSystemAgentQrCodePngBase64(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAB0lEQVRnYXJiYWdliKMwNwAAAABJRU5ErkJggg==",
      ),
    ).resolves.toBe(false);
    expect(
      isSystemAgentQrCodePngBase64(
        `iVBORw0KGgo${"A".repeat(SYSTEM_AGENT_QR_CODE_PNG_BASE64_MAX_LENGTH)}`,
      ),
    ).toBe(false);
    expect(
      Value.Check(SystemAgentChatResultSchema, {
        sessionId: "setup-session",
        reply: "Scan this QR code, then continue.",
        action: "none",
        wizardInputPending: true,
        qrCodePngBase64: "cG5n",
      }),
    ).toBe(false);
    expect(
      Value.Check(SystemAgentChatResultSchema, {
        sessionId: "setup-session",
        reply: "Scan this QR code, then continue.",
        action: "none",
        wizardInputPending: true,
        qrCodePngBase64: PNG_BASE64,
      }),
    ).toBe(false);
    for (const question of [
      {
        id: "setup-qr",
        header: "Scan QR code",
        question: "Scan the code, then continue.",
        options: [{ label: "Continue" }],
      },
      {
        id: "setup-qr",
        header: "Scan QR code",
        question: "Scan the code, then continue.",
        options: [{ label: "Continue" }, { label: "Cancel" }],
        allowSkip: false,
      },
      {
        id: "setup-qr",
        header: "Scan QR code",
        question: "Scan the code, then continue.",
        options: [{ label: "Continue" }],
        allowSkip: false,
        skipAction: "exit",
      },
    ]) {
      expect(
        Value.Check(SystemAgentChatResultSchema, {
          sessionId: "setup-session",
          reply: "Scan this QR code, then continue.",
          action: "none",
          wizardInputPending: true,
          qrCodePngBase64: PNG_BASE64,
          question,
        }),
      ).toBe(false);
    }
  });

  it("requires QR results to remain in a pending wizard acknowledgement", () => {
    const question = {
      id: "setup-qr",
      header: "Scan QR code",
      question: "Scan the code, then continue.",
      options: [{ label: "Continue" }],
      allowSkip: false,
    };
    for (const incompatible of [
      { action: "none" },
      { action: "none", wizardInputPending: false },
      { action: "exit", wizardInputPending: true },
      { action: "open-agent", wizardInputPending: true },
      { action: "none", wizardInputPending: true, sensitive: true },
      { action: "none", wizardInputPending: true, agentDraft: "hatch" },
      { action: "none", wizardInputPending: true, agentId: "main" },
      { action: "none", wizardInputPending: true, needsApproval: true },
      { action: "none", wizardInputPending: true, proposalId: "proposal-1" },
    ]) {
      expect(
        Value.Check(SystemAgentChatResultSchema, {
          sessionId: "setup-session",
          reply: "Scan this QR code, then continue.",
          qrCodePngBase64: PNG_BASE64,
          question,
          ...incompatible,
        }),
      ).toBe(false);
    }
  });
});

describe("OpenClaw chat history protocol", () => {
  it("accepts the default request and bounds explicit limits", () => {
    expect(validateSystemAgentChatHistoryParams({})).toBe(true);
    expect(validateSystemAgentChatHistoryParams({ limit: 1 })).toBe(true);
    expect(validateSystemAgentChatHistoryParams({ limit: 500 })).toBe(true);
    expect(validateSystemAgentChatHistoryParams({ limit: 0 })).toBe(false);
    expect(validateSystemAgentChatHistoryParams({ limit: 501 })).toBe(false);
  });

  it("accepts ordered role, text, and timestamp turns only", () => {
    expect(
      Value.Check(SystemAgentChatHistoryResultSchema, {
        turns: [
          { role: "user", text: "status", at: 1 },
          { role: "assistant", text: "healthy", at: 2 },
        ],
      }),
    ).toBe(true);
    expect(
      Value.Check(SystemAgentChatHistoryResultSchema, {
        turns: [{ role: "tool", text: "hidden", at: 1 }],
      }),
    ).toBe(false);
  });
});

describe("OpenClaw setup detection protocol", () => {
  it("accepts additive presentation metadata and older results without installs", () => {
    const result = {
      candidates: [
        {
          kind: "provider-auto:ollama",
          brandId: "ollama",
          label: "Ollama",
          detail: "available locally",
          modelRef: "ollama/qwen3",
          recommended: false,
          icon: "https://cdn.simpleicons.org/ollama",
          website: "https://ollama.com/download",
        },
      ],
      manualProviders: [
        {
          id: "ollama",
          brandId: "ollama",
          label: "Ollama",
          icon: "https://cdn.simpleicons.org/ollama",
          website: "https://ollama.com/download",
        },
      ],
      authOptions: [],
      recommendedInstalls: [
        {
          id: "ollama",
          brandId: "ollama",
          label: "Ollama",
          hint: "Run open models locally",
          website: "https://ollama.com/download",
          icon: "https://cdn.simpleicons.org/ollama",
        },
      ],
      workspace: "/tmp/work",
      setupComplete: false,
    };

    expect(Value.Check(SystemAgentSetupDetectResultSchema, result)).toBe(true);
    expect(
      Value.Check(SystemAgentSetupDetectResultSchema, {
        ...result,
        candidates: result.candidates.map(({ brandId: _brandId, ...candidate }) => candidate),
        manualProviders: result.manualProviders.map(
          ({ brandId: _brandId, ...provider }) => provider,
        ),
        recommendedInstalls: result.recommendedInstalls.map(
          ({ brandId: _brandId, ...install }) => install,
        ),
      }),
    ).toBe(true);
    expect(
      Value.Check(SystemAgentSetupDetectResultSchema, {
        ...result,
        recommendedInstalls: undefined,
      }),
    ).toBe(true);
    expect(
      Value.Check(SystemAgentSetupDetectResultSchema, {
        ...result,
        recommendedInstalls: [{ ...result.recommendedInstalls[0], website: "http://example.test" }],
      }),
    ).toBe(false);
  });
});

describe("OpenClaw setup verification protocol", () => {
  it("accepts only an empty request", () => {
    expect(validateSystemAgentSetupVerifyParams({})).toBe(true);
    expect(validateSystemAgentSetupVerifyParams({ modelRef: "openai/gpt-5.5" })).toBe(false);
  });

  it("accepts the structured success and failure results", () => {
    expect(
      Value.Check(SystemAgentSetupVerifyResultSchema, {
        ok: true,
        modelRef: "openai/gpt-5.5",
        latencyMs: 25,
      }),
    ).toBe(true);
    expect(
      Value.Check(SystemAgentSetupVerifyResultSchema, {
        ok: false,
        status: "unavailable",
        error: "no configured model",
      }),
    ).toBe(true);
  });

  it("rejects mixed or incomplete results", () => {
    expect(
      Value.Check(SystemAgentSetupVerifyResultSchema, {
        ok: true,
        modelRef: "openai/gpt-5.5",
        latencyMs: 25,
        error: "stale failure",
      }),
    ).toBe(false);
    expect(
      Value.Check(SystemAgentSetupVerifyResultSchema, {
        ok: false,
        status: "ok",
        error: "contradictory result",
      }),
    ).toBe(false);
    expect(
      Value.Check(SystemAgentSetupVerifyResultSchema, {
        ok: false,
        status: "unavailable",
      }),
    ).toBe(false);
  });
});

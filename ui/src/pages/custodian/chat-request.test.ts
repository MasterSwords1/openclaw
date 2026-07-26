import { describe, expect, it, vi } from "vitest";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import { requestCustodianChat } from "./chat-request.ts";

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function qrResult(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "setup-session",
    reply: "Scan this code, then continue.",
    wizardInputPending: true,
    action: "none",
    qrCodePngBase64: PNG_BASE64,
    question: {
      id: "link-device",
      header: "Link a device",
      question: "Scan the QR code, then continue.",
      options: [{ label: "Continue" }],
      allowSkip: false,
    },
    ...overrides,
  };
}

describe("requestCustodianChat", () => {
  it("does not advertise QR support without a browser decoder", async () => {
    const request = vi.fn().mockResolvedValue({
      sessionId: "setup-session",
      reply: "Continue setup.",
      action: "none",
    });
    const client = { request, connectionGeneration: 1 } as unknown as GatewayBrowserClient;

    await requestCustodianChat({
      client,
      request: { sessionId: "setup-session" },
      onSent: vi.fn(),
      onCompatibilityRetry: vi.fn(),
      qrCodeDecoderAvailable: false,
    });

    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[1]).not.toHaveProperty("capabilities");
  });

  it("keeps a rejected capability probe tentative before the legacy retry", async () => {
    const deliveryStates: string[] = [];
    const request = vi
      .fn()
      .mockImplementationOnce(
        (_method: string, _params: unknown, options: { onSent?: () => void } | undefined) => {
          options?.onSent?.();
          throw new GatewayRequestError({
            code: "INVALID_REQUEST",
            message: "invalid openclaw.chat params",
          });
        },
      )
      .mockRejectedValueOnce(new Error("connection closed before retry"));
    const client = { request, connectionGeneration: 1 } as unknown as GatewayBrowserClient;

    await expect(
      requestCustodianChat({
        client,
        request: { sessionId: "setup-session" },
        onSent: () => deliveryStates.push("sent"),
        onCompatibilityRetry: () => deliveryStates.push("unsent"),
      }),
    ).rejects.toThrow("connection closed before retry");

    expect(deliveryStates).toEqual(["unsent"]);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]?.[1]).not.toHaveProperty("capabilities");
  });

  it("rejects QR bytes unless the complete closed QR result branch is valid", async () => {
    const malformedResults = [
      qrResult({ question: undefined }),
      qrResult({ wizardInputPending: false }),
      qrResult({ action: "exit" }),
      qrResult({ sensitive: true }),
      qrResult({
        question: {
          id: "link-device",
          header: "Link a device",
          question: "Scan the QR code, then continue.",
          options: [{ label: "Continue" }],
          allowSkip: true,
        },
      }),
    ];

    for (const [index, result] of malformedResults.entries()) {
      const client = {
        request: vi.fn().mockResolvedValue(result),
        connectionGeneration: index + 1,
      } as unknown as GatewayBrowserClient;

      await expect(
        requestCustodianChat({
          client,
          request: { sessionId: "setup-session" },
          onSent: vi.fn(),
          onCompatibilityRetry: vi.fn(),
        }),
      ).rejects.toThrow("invalid setup QR code");
    }
  });

  it("rejects a schema-shaped QR result when its PNG bytes are corrupt", async () => {
    const client = {
      request: vi.fn().mockResolvedValue(qrResult({ qrCodePngBase64: "iVBORw0KGgo=" })),
      connectionGeneration: 1,
    } as unknown as GatewayBrowserClient;

    await expect(
      requestCustodianChat({
        client,
        request: { sessionId: "setup-session" },
        onSent: vi.fn(),
        onCompatibilityRetry: vi.fn(),
      }),
    ).rejects.toThrow("invalid setup QR code");
  });
});

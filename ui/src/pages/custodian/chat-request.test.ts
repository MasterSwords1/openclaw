import { describe, expect, it, vi } from "vitest";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import { requestCustodianChat } from "./chat-request.ts";

describe("requestCustodianChat", () => {
  it("resets delivery state before retrying an old gateway request shape", async () => {
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

    expect(deliveryStates).toEqual(["sent", "unsent"]);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]?.[1]).not.toHaveProperty("capabilities");
  });
});

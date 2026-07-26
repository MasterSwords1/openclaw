// @vitest-environment node
import { describe, expect, it } from "vitest";
import { GatewayRequestError } from "../../api/gateway.ts";
import {
  classifyCustodianSendFailure,
  shouldConsumeNudge,
  type CustodianEventNudge,
} from "./event-nudge.ts";

const nudge: CustodianEventNudge = {
  severity: 2,
  kind: "channel-auth",
  channelLabel: "Telegram",
  message: "what happened with telegram authentication?",
};

describe("custodian event nudge delivery", () => {
  it("keeps a retry after a sent request receives a definitive Gateway rejection", () => {
    const outcome = classifyCustodianSendFailure(
      new GatewayRequestError({ code: "INVALID_REQUEST", message: "Request failed" }),
      "sent",
    );

    expect(outcome).toBe("rejected");
    expect(shouldConsumeNudge(nudge, nudge, outcome)).toBe(false);
  });

  it("consumes a transmitted nudge when only transport delivery is uncertain", () => {
    const outcome = classifyCustodianSendFailure(new Error("gateway closed"), "sent");

    expect(outcome).toBe("unknown");
    expect(shouldConsumeNudge(nudge, nudge, outcome)).toBe(true);
  });
});

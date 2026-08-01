import { describe, expect, it } from "vitest";
import {
  isCronWebhookTokenDestinationAllowed,
  normalizeCronWebhookTokenDestination,
  normalizeHttpWebhookUrl,
  resolveCronWebhookTokenDestinations,
} from "./webhook-url.js";

function credentialWebhookUrl(username = "user", password = "password"): string {
  const url = new URL("https://example.invalid/hook");
  url.username = username;
  url.password = password;
  return url.href;
}

describe("normalizeHttpWebhookUrl", () => {
  it.each([
    ["https://example.invalid/hook", "https://example.invalid/hook"],
    ["  http://example.invalid/hook  ", "http://example.invalid/hook"],
    ["ftp://example.invalid/hook", null],
    ["not-a-url", null],
    ["", null],
  ])("normalizes %j", (value, expected) => {
    expect(normalizeHttpWebhookUrl(value)).toBe(expected);
  });

  it.each([
    credentialWebhookUrl("user", ""),
    credentialWebhookUrl(),
    credentialWebhookUrl("user@name"),
  ])("rejects URL-embedded credentials in %s", (value) => {
    expect(normalizeHttpWebhookUrl(value)).toBeNull();
  });
});

describe("cron webhook token destinations", () => {
  it.each([
    ["case and default port", " HTTPS://EXAMPLE.COM:443/a ", "https://example.com/a"],
    ["trailing DNS dot", "https://example.com./a", "https://example.com/a"],
    ["IDNA hostname", "https://bücher.example/a", "https://xn--bcher-kva.example/a"],
    ["dot segments", "https://example.com/a/../b", "https://example.com/b"],
    ["IPv6 literal", "https://[2001:db8::1]/a", "https://[2001:db8::1]/a"],
  ])("canonicalizes %s", (_description, input, expected) => {
    expect(normalizeCronWebhookTokenDestination(input)).toBe(expected);
  });

  it.each([
    "http://example.com/a",
    credentialWebhookUrl(),
    "https://*.example.com/a",
    "https://example.com/a#fragment",
    "https://example.com/a#",
    "not a URL",
    "",
  ])("rejects unsafe destination %s", (input) => {
    expect(normalizeCronWebhookTokenDestination(input)).toBeNull();
  });

  it("requires an exact canonical URL match", () => {
    const destinations = new Set(["https://example.com/hooks/cron?tenant=main"]);

    expect(
      isCronWebhookTokenDestinationAllowed(
        "HTTPS://EXAMPLE.COM:443/hooks/cron?tenant=main",
        destinations,
      ),
    ).toBe(true);
    expect(
      isCronWebhookTokenDestinationAllowed(
        "https://example.com/hooks/cron?tenant=other",
        destinations,
      ),
    ).toBe(false);
    expect(
      isCronWebhookTokenDestinationAllowed(
        "https://example.com/hooks/cron/child?tenant=main",
        destinations,
      ),
    ).toBe(false);
    expect(
      isCronWebhookTokenDestinationAllowed(
        "https://example.com:8443/hooks/cron?tenant=main",
        destinations,
      ),
    ).toBe(false);
  });

  it("includes only the exact configured global failure webhook destination", () => {
    const destinations = resolveCronWebhookTokenDestinations({
      webhookTokenDestinations: ["https://hooks.example.com/completion"],
      failureAlert: {
        mode: "webhook",
        to: "https://alerts.example.com/failure",
      },
    });

    expect([...destinations]).toEqual([
      "https://hooks.example.com/completion",
      "https://alerts.example.com/failure",
    ]);
  });

  it("does not trust a non-webhook global failure target", () => {
    expect([
      ...resolveCronWebhookTokenDestinations({
        failureAlert: { mode: "announce", to: "https://alerts.example.com/failure" },
      }),
    ]).toEqual([]);
  });
});

import { isHttpUrl } from "@openclaw/net-policy/url-protocol";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import type { CronConfig } from "../config/types.cron.js";

type CronWebhookTarget = {
  url: string;
  source: "delivery" | "completionDestination";
};

/** Normalizes cron webhook URLs while rejecting empty, malformed, and non-HTTP(S) values. */
export function normalizeHttpWebhookUrl(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    // Fetch rejects URL userinfo before dispatch. Fail at the shared boundary so
    // validation and doctor migration do not preserve a target that cannot deliver.
    if (!isHttpUrl(parsed) || parsed.username || parsed.password) {
      return null;
    }
  } catch {
    return null;
  }
  return trimmed;
}

/** Resolves direct webhook delivery and completion-destination webhooks. */
export function resolveCronWebhookTargets(params: {
  delivery?: {
    mode?: string;
    to?: string;
    completionDestination?: { mode?: string; to?: string };
  };
}): CronWebhookTarget[] {
  const targets: CronWebhookTarget[] = [];
  const mode = normalizeOptionalLowercaseString(params.delivery?.mode);
  if (mode === "webhook") {
    const url = normalizeHttpWebhookUrl(params.delivery?.to);
    if (url) {
      targets.push({ url, source: "delivery" });
    }
  }

  const completionMode = normalizeOptionalLowercaseString(
    params.delivery?.completionDestination?.mode,
  );
  if (mode === "announce" && completionMode === "webhook") {
    const url = normalizeHttpWebhookUrl(params.delivery?.completionDestination?.to);
    if (url && targets.every((target) => target.url !== url)) {
      targets.push({ url, source: "completionDestination" });
    }
  }

  return targets;
}

/**
 * Canonicalizes an operator-approved destination for bearer-authenticated cron webhooks.
 * Exact HTTPS URLs keep token scope narrower than host, origin, or path-prefix rules.
 */
export function normalizeCronWebhookTokenDestination(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes("#")) {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.hostname.includes("*")
    ) {
      return null;
    }
    if (!parsed.hostname.startsWith("[") && parsed.hostname.endsWith(".")) {
      parsed.hostname = parsed.hostname.replace(/\.+$/, "");
    }
    return parsed.href;
  } catch {
    return null;
  }
}

export function resolveCronWebhookTokenDestinations(
  cron: CronConfig | undefined,
): ReadonlySet<string> {
  const destinations = new Set<string>();
  for (const value of cron?.webhookTokenDestinations ?? []) {
    const normalized = normalizeCronWebhookTokenDestination(value);
    if (normalized) {
      destinations.add(normalized);
    }
  }
  if (cron?.failureAlert?.mode === "webhook") {
    const normalized = normalizeCronWebhookTokenDestination(cron.failureAlert.to);
    if (normalized) {
      destinations.add(normalized);
    }
  }
  return destinations;
}

export function isCronWebhookTokenDestinationAllowed(
  value: string,
  destinations: ReadonlySet<string>,
): boolean {
  const normalized = normalizeCronWebhookTokenDestination(value);
  return normalized !== null && destinations.has(normalized);
}

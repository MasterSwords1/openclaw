import type { GatewayClient } from "./types.js";

export type HostedSessionOwner =
  | { kind: "stable"; key: string; continuityKey: string }
  | { kind: "connection"; key: string }
  | { kind: "none" };

/** Resolve the strongest server-authenticated identity available to a hosted session. */
export function resolveGatewayHostedSessionOwner(client: GatewayClient | null): HostedSessionOwner {
  const userId = client?.authenticatedUserId?.trim();
  if (userId) {
    const key = `user:${userId}`;
    return { kind: "stable", key, continuityKey: key };
  }
  const deviceId = client?.connect.device?.id.trim();
  if (deviceId) {
    const key = `device:${deviceId}`;
    return { kind: "stable", key, continuityKey: key };
  }
  const sharedAuthGeneration = client?.sharedGatewaySessionGeneration?.trim();
  if (client?.usesSharedGatewayAuth && sharedAuthGeneration) {
    return {
      kind: "stable",
      key: `shared-auth:${sharedAuthGeneration}`,
      continuityKey: "shared-auth",
    };
  }
  const connId = client?.connId?.trim();
  return connId ? { kind: "connection", key: `connection:${connId}` } : { kind: "none" };
}

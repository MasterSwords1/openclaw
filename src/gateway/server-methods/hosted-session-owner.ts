import type { GatewayClient } from "./types.js";

export type HostedSessionOwner =
  | { kind: "stable"; key: string }
  | { kind: "connection"; key: string }
  | { kind: "none" };

/** Resolve the strongest server-authenticated identity available to a hosted session. */
export function resolveGatewayHostedSessionOwner(client: GatewayClient | null): HostedSessionOwner {
  const userId = client?.authenticatedUserId?.trim();
  if (userId) {
    return { kind: "stable", key: `user:${userId}` };
  }
  const deviceId = client?.connect.device?.id.trim();
  if (deviceId) {
    return { kind: "stable", key: `device:${deviceId}` };
  }
  const sharedAuthGeneration = client?.sharedGatewaySessionGeneration?.trim();
  if (client?.usesSharedGatewayAuth && sharedAuthGeneration) {
    return { kind: "stable", key: `shared-auth:${sharedAuthGeneration}` };
  }
  const connId = client?.connId?.trim();
  return connId ? { kind: "connection", key: `connection:${connId}` } : { kind: "none" };
}

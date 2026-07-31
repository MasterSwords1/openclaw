import { findDeliveryIntentOwner } from "./delivery-queue-storage.js";

/** Read only queue ownership state; plugins use this to garbage-collect provider artifacts. */
export async function getOutboundDeliveryQueueStatus(
  id: string,
  stateDir?: string,
): Promise<"pending" | "terminal" | "absent"> {
  const owner = findDeliveryIntentOwner(id, stateDir);
  if (!owner) {
    return "absent";
  }
  return owner.status === "pending" ? "pending" : "terminal";
}

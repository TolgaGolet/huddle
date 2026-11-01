import { createHash } from "node:crypto";

/**
 * A user's public, room-scoped id, stable across reconnects. It is broadcast
 * (senderId, voterIds, reactions), so it is a one-way hash: the clientKey behind
 * it is the proof of identity, and must never be stored, broadcast or logged.
 */
export function deriveUserId(roomId: string, clientKey: string): string {
  return createHash("sha256").update(`${roomId}:${clientKey}`).digest("base64url").slice(0, 22);
}

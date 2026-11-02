import { MAX_ROOM_LIFETIME_MS, ROOM_INACTIVE_MS, type RoomClosedReason, type RoomClosing, type RoomClosingReason } from "../types";

const INACTIVE_MINUTES = ROOM_INACTIVE_MS / 60_000;
const LIFETIME_HOURS = MAX_ROOM_LIFETIME_MS / 3_600_000;

export interface RoomClosingDeadline {
  reason: RoomClosingReason;
  /** By this client's clock. */
  closesAt: number;
}

export function closingDeadline(closing: RoomClosing | null, now = Date.now()): RoomClosingDeadline | null {
  return closing && { reason: closing.reason, closesAt: now + closing.remainingMs };
}

export function roomClosingMessage(reason: RoomClosingReason): string {
  return reason === "inactive"
    ? "This room will close soon because nobody has talked or chatted. Speak or send a message to keep it open."
    : `This room is reaching its ${LIFETIME_HOURS}-hour limit and will close soon. Create a new room to continue.`;
}

export const KICKED_NOTICE = "An owner removed you from that room.";

export function roomClosedMessage(reason: RoomClosedReason): string {
  if (reason === "empty") return "That room closed because everyone left before you were accepted.";
  return reason === "inactive"
    ? `That room closed because nobody talked or chatted for ${INACTIVE_MINUTES} minutes. Its messages and images are gone.`
    : `That room closed because it reached its ${LIFETIME_HOURS}-hour limit. Its messages and images are gone.`;
}

/** M:SS, never negative. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

import { INACTIVE_WARNING_MS, LIFETIME_WARNING_MS, MAX_ROOM_LIFETIME_MS, ROOM_INACTIVE_MS } from "./limits.js";
import type { RoomClosedReason, RoomClosing, RoomClosingReason } from "./protocol.js";
import { allRooms, closeRoom, ROOM_GRACE_MS, touchRoom, type Room } from "./roomManager.js";
import { promoteAfterGrace } from "./roomModeration.js";
import { countSecurityEvent } from "./securityLog.js";
import type { AppServer } from "./socketRoute.js";

const SWEEP_INTERVAL_MS = 10_000;

/** Why and when a room will close, once that is inside its warning period. */
export function closingStatus(room: Room, now: number): { reason: RoomClosingReason; closesAt: number } | null {
  const inactiveAt = room.lastActivityAt + ROOM_INACTIVE_MS;
  const lifetimeAt = room.createdAt + MAX_ROOM_LIFETIME_MS;
  const warnInactive = now >= inactiveAt - INACTIVE_WARNING_MS;
  const warnLifetime = now >= lifetimeAt - LIFETIME_WARNING_MS;
  if (warnLifetime && (!warnInactive || lifetimeAt <= inactiveAt)) return { reason: "lifetime", closesAt: lifetimeAt };
  return warnInactive ? { reason: "inactive", closesAt: inactiveAt } : null;
}

/** As sent to clients: a duration, so a wrong clock on their side doesn't matter. */
export function roomClosingNotice(room: Room, now = Date.now()): RoomClosing | null {
  const status = closingStatus(room, now);
  return status && { reason: status.reason, remainingMs: Math.max(0, status.closesAt - now) };
}

/** Ends a room for everyone in it and everyone waiting to get in. */
function closeWithReason(io: AppServer, room: Room, reason: RoomClosedReason): void {
  const everyone = [room.id, ...room.waiting.keys()];
  io.to(everyone).emit("room-closed", { reason });
  // Cleared first, so the disconnects below don't announce each member leaving.
  closeRoom(room.id);
  // Server-side, so that clients don't reconnect to a room that is gone.
  io.in(everyone).disconnectSockets(true);
}

const announced = new WeakMap<Room, RoomClosingReason>();

export function sweepRoomLifetimes(io: AppServer, now = Date.now()): void {
  for (const room of allRooms()) {
    // An empty room has its own, much shorter, grace period. Normally the purge
    // takes it, but that holds off for people waiting, who need telling.
    if (room.participants.size === 0) {
      if (room.waiting.size > 0 && room.emptySince !== null && now - room.emptySince > ROOM_GRACE_MS) closeWithReason(io, room, "empty");
      continue;
    }
    promoteAfterGrace(io, room, now);
    // The server can't see media, but it does know a screen share is running.
    if (room.screenSharerId) touchRoom(room, now);
    // Nor a video, but it does know a watch party is playing for someone.
    for (const party of room.watchParties.values()) {
      if (party.playback.state === "playing" && party.members.size > 0) touchRoom(room, now);
    }

    const status = closingStatus(room, now);
    if (status && now >= status.closesAt) {
      countSecurityEvent(`room_closed_${status.reason}`);
      closeWithReason(io, room, status.reason);
      continue;
    }
    if (status?.reason !== announced.get(room)) {
      if (status) announced.set(room, status.reason);
      else announced.delete(room);
      io.to(room.id).emit("room-closing", roomClosingNotice(room, now));
    }
  }
}

export function setupRoomLifetime(io: AppServer): void {
  setInterval(() => sweepRoomLifetimes(io), SWEEP_INTERVAL_MS);
}

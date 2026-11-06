import { errorSummary } from "./errorLog.js";
import { setRoomPassword } from "./imageCrypto.js";
import { requestIp } from "./ipRateLimit.js";
import { isModeratable, type RoomSettings, type WaitingPerson } from "./protocol.js";
import { getParticipantsArray, hasPermission, type Room, type RoomCtx, type WaitingEntry } from "./roomManager.js";
import { onRoom, type AppServer } from "./socketRoute.js";
import { parseAdmitWaiting, parseChangePassword, parseKick, parseRoomPermissions, parseSetOwner } from "./validation.js";

/** How long a room can have no owner present before someone takes over: longer than a reconnect takes. */
export const OWNER_GRACE_MS = 60_000;

/** Sent to the whole room, so never put the password or an owner token here. */
export function roomSettingsOf(room: Room): RoomSettings {
  return { ...room.settings, hasPassword: !!room.password, ownerIds: [...room.owners], creatorId: room.creatorId };
}

export function waitingEntryFor(room: Room, userId: string): WaitingEntry | undefined {
  return [...room.waiting.values()].find((entry) => entry.userId === userId);
}

function ownersPresent(room: Room) {
  return getParticipantsArray(room).filter((p) => room.owners.has(p.userId));
}

/** Tells the owners who is waiting, and only them: others have no use for the names. */
export function announceWaiting(io: AppServer, room: Room): void {
  const list: WaitingPerson[] = [...room.waiting.values()].map(({ id, name, wasRemoved }) => ({ id, name, wasRemoved }));
  for (const owner of ownersPresent(room)) io.to(owner.id).emit("waiting-list", list);
}

export function announceSettings(io: AppServer, room: Room): void {
  io.to(room.id).emit("room-settings", roomSettingsOf(room));
}

/** Ends a screen share that the room's settings no longer allow. */
function stopDisallowedShare(io: AppServer, room: Room): void {
  const sharer = room.screenSharerId ? room.participants.get(room.screenSharerId) : undefined;
  if (!sharer || hasPermission(room, "screenSharePermission", sharer.userId)) return;
  room.screenSharerId = null;
  io.to(room.id).emit("screen-share-stopped", { id: sharer.id });
}

/** True if someone was promoted, and so the room was sent the new settings. */
function promoteLongestPresent(io: AppServer, room: Room): boolean {
  const [longestPresent] = getParticipantsArray(room);
  if (!longestPresent) return false;
  room.owners.add(longestPresent.userId);
  room.ownerlessSince = null;
  announceSettings(io, room);
  announceWaiting(io, room);
  return true;
}

/** Makes the longest-present participant an owner, if nobody present is one. */
/** True if someone was promoted, and so the room was sent the new settings. */
export function promoteIfOwnerless(io: AppServer, room: Room): boolean {
  if (ownersPresent(room).length === 0) return promoteLongestPresent(io, room);
  room.ownerlessSince = null;
  return false;
}

/** For the periodic sweep: gives a disconnected owner time to come back first. */
export function promoteAfterGrace(io: AppServer, room: Room, now: number): void {
  if (ownersPresent(room).length > 0) {
    room.ownerlessSince = null;
    return;
  }
  room.ownerlessSince ??= now;
  if (now - room.ownerlessSince >= OWNER_GRACE_MS) promoteLongestPresent(io, room);
}

export function setupModeration(io: AppServer, proxyHops = 0): void {
  /** Runs `action` only for an owner, as every moderation event requires. */
  const ownerOnly = <T>(action: (ctx: RoomCtx, data: T) => void) => (ctx: RoomCtx, data: T) => {
    if (ctx.room.owners.has(ctx.participant.userId)) action(ctx, data);
  };

  io.on("connection", (socket) => {
    onRoom(socket, "set-owner", parseSetOwner, ownerOnly(({ room, participant }, { userId, isOwner }) => {
      // Others only, so a room with an owner present can't be left without one by accident.
      if (!isModeratable(userId, participant.userId, room.creatorId) || !getParticipantsArray(room).some((p) => p.userId === userId)) return;
      if (isOwner) room.owners.add(userId);
      else room.owners.delete(userId);
      stopDisallowedShare(io, room);
      announceSettings(io, room);
      announceWaiting(io, room);
    }));

    onRoom(socket, "kick-participant", parseKick, ownerOnly(({ room, participant }, { userId }) => {
      if (!isModeratable(userId, participant.userId, room.creatorId)) return;
      const target = getParticipantsArray(room).find((p) => p.userId === userId);
      if (!target) return;
      room.blockedUsers.add(userId);
      room.memberIds.delete(userId);
      room.owners.delete(userId);
      const targetSocket = io.sockets.sockets.get(target.id);
      if (targetSocket) {
        room.blockedIps.add(requestIp(targetSocket.request, proxyHops));
        targetSocket.emit("kicked");
        // Server-side, so that it doesn't reconnect by itself. The socket's own
        // disconnect handling removes it from the room and tells the others.
        targetSocket.disconnect(true);
      }
      announceSettings(io, room);
    }));

    onRoom(socket, "update-room-settings", parseRoomPermissions, ownerOnly(({ room }, changes) => {
      const wasWaitingRoom = room.settings.waitingRoom;
      Object.assign(room.settings, changes);
      stopDisallowedShare(io, room);
      announceSettings(io, room);
      // Someone removed earlier still needs an owner's decision.
      if (wasWaitingRoom && !room.settings.waitingRoom) {
        for (const entry of [...room.waiting.values()]) {
          if (!entry.wasRemoved) entry.admit();
        }
        announceWaiting(io, room);
      }
    }));

    onRoom(socket, "change-room-password", parseChangePassword, ownerOnly(({ room }, { password }) => {
      setRoomPassword(room, password).then(
        () => {
          socket.emit("room-password-result", { ok: true });
          announceSettings(io, room);
        },
        (err: unknown) => {
          console.error("[moderation] password change failed", errorSummary(err));
          socket.emit("room-password-result", { ok: false });
        },
      );
    }));

    onRoom(socket, "admit-waiting", parseAdmitWaiting, ownerOnly(({ room }, { id }) => {
      const entry = room.waiting.get(id);
      if (!entry) return;
      // Still waiting if the room is full, so the owner needs to know why nothing happened.
      if (!entry.admit()) socket.emit("admit-refused", { id });
      announceWaiting(io, room);
    }));
  });
}

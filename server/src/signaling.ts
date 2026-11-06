import {
  addParticipant,
  removeParticipant,
  getRoom,
  getParticipantsArray,
  httpTokenFor,
  hasPermission,
  rememberMember,
  setMuted,
  verifyPassword,
  isNameTaken,
  isRoomFull,
  socketRoomMap,
  touchRoom,
  type Room,
} from "./roomManager.js";
import { roomClosingNotice } from "./roomLifetime.js";
import { watchPartyStateOf } from "./watchPartyHandler.js";
import { announceSettings, announceWaiting, promoteIfOwnerless, roomSettingsOf, waitingEntryFor } from "./roomModeration.js";
import { countSecurityEvent } from "./securityLog.js";
import { deriveUserId } from "./identity.js";
import { createIpLimiter, IP_LIMITS, requestIp } from "./ipRateLimit.js";
import { JOIN_ERROR } from "./joinErrors.js";
import { MAX_PARTICIPANTS, MAX_WAITING_PER_ROOM } from "./limits.js";
import { on, onRelay, onRoom, type AppServer } from "./socketRoute.js";
import { noPayload, parseDisconnect, parseJoinRoom, parseMute } from "./validation.js";

/** Longer than the client's join retries last, so only a socket with no intention of joining reaches it. */
export const JOIN_DEADLINE_MS = 60_000;

/** Socket.IO's reason when a client chose to leave, as opposed to losing its connection. */
const LEFT_ON_PURPOSE = "client namespace disconnect";

interface JoinDetails {
  name: string;
  userId: string | undefined;
  isMuted: boolean | undefined;
  isCreator: boolean;
}

export function setupSignaling(io: AppServer, proxyHops = 0): void {
  const passwordGuesses = createIpLimiter(IP_LIMITS.passwordGuesses);
  const roomPasswordGuesses = createIpLimiter(IP_LIMITS.roomPasswordGuesses);

  io.on("connection", (socket) => {
    const ip = requestIp(socket.request, proxyHops);
    /** The room whose waiting room this socket is in, if any. */
    let waitingIn: Room | null = null;

    // Closes the transport, not `socket.disconnect`, because a client doesn't
    // reconnect after a server-side disconnect and a real one should recover.
    // Someone in a waiting room is expected to stay as long as they have to.
    const joinDeadline = setTimeout(() => {
      if (!socketRoomMap.has(socket.id) && !waitingIn) socket.conn.close();
    }, JOIN_DEADLINE_MS);

    const rejectAsLimited = () => {
      countSecurityEvent("join_rate_limited");
      socket.emit("error", { code: JOIN_ERROR.RATE_LIMITED, message: "Too many attempts to join, please try again shortly" });
    };

    // Removes a participant and tells the others; their share ends with them.
    const removeAndAnnounce = (roomId: string, id: string, deliberate = false) => {
      const room = getRoom(roomId);
      if (room?.screenSharerId === id) {
        room.screenSharerId = null;
        socket.to(roomId).emit("screen-share-stopped", { id });
      }
      const participant = room?.participants.get(id);
      removeParticipant(roomId, id, deliberate);
      if (participant) socket.to(roomId).emit("participant-left", { id, userId: participant.userId });
    };

    // Remove this socket from the room it has joined (if any) and tell the
    // others. Used on disconnect, and by a successful join-room into another
    // room so the socket never leaves a ghost participant behind.
    const leaveCurrentRoom = (deliberate = false) => {
      const roomId = socketRoomMap.get(socket.id);
      if (!roomId) return;
      removeAndAnnounce(roomId, socket.id, deliberate);
      void socket.leave(roomId);
      // The room lingers for ROOM_GRACE_MS after the last participant leaves
      // (in case everyone is reconnecting after a shared network blip); its
      // images are deleted via onRoomDestroyed once it is truly gone.
    };

    const leaveWaitingRoom = () => {
      if (!waitingIn) return;
      const room = waitingIn;
      waitingIn = null;
      room.waiting.delete(socket.id);
      announceWaiting(io, room);
    };

    // Rejoin race fix: after a network blip the client's socket reconnects
    // with a new socket.id and re-emits join-room, but the server may still
    // hold the participant entry of the OLD socket for up to ~20s (default
    // pingTimeout), and that socket can still look live. A matching userId
    // proves the entry is the joiner's own, so evict it instead of rejecting
    // the join with "Name already taken". A dead socket holding the name is
    // evicted too. Disconnecting a live one stops it reconnecting (it is
    // server-initiated), so two holders of a key can't keep evicting each other.
    const evictedBy = (room: Room, { name, userId }: JoinDetails) => {
      const lowerName = name.toLowerCase();
      return getParticipantsArray(room).filter(
        (p) => p.userId === userId || (p.name.toLowerCase() === lowerName && !io.sockets.sockets.has(p.id)),
      );
    };

    const refuseTakenName = () => socket.emit("error", { code: JOIN_ERROR.NAME_TAKEN, message: "Name already taken in this room" });

    /** Puts this socket in the room. False, with nothing changed, if the room is full. */
    const enterRoom = (room: Room, details: JoinDetails): boolean => {
      const { name, userId, isMuted, isCreator } = details;
      const evicted = evictedBy(room, details);
      if (isRoomFull(room, evicted)) return false;

      // Only once the join will succeed: a refused one must leave the old session alone.
      for (const p of evicted) {
        removeAndAnnounce(room.id, p.id);
        io.sockets.sockets.get(p.id)?.disconnect(true);
      }

      // Only now that the new join is certain to succeed, leave the previous
      // room; a failed join must not drop the socket from the room it is in.
      leaveCurrentRoom();
      const participant = addParticipant(room, socket.id, name, userId, isMuted);
      rememberMember(room, participant.userId);
      if (isCreator) {
        room.owners.add(participant.userId);
        room.creatorId = participant.userId;
        room.ownerToken = null;
      }

      socket.join(room.id);

      const existingParticipants = getParticipantsArray(room).filter(
        (p) => p.id !== socket.id,
      );
      socket.emit("room-joined", {
        userId: participant.userId,
        httpToken: httpTokenFor(socket.id)!,
        participants: existingParticipants,
        chatHistory: room.chatHistory,
        pinnedMessageId: room.pinnedMessageId,
        screenSharer: room.screenSharerId,
        closing: roomClosingNotice(room),
        settings: roomSettingsOf(room),
        watchParty: watchPartyStateOf(room),
      });

      socket.to(room.id).emit("participant-joined", participant);
      if (isCreator) announceSettings(io, room);
      announceWaiting(io, room);
      return true;
    };

    const enterWaitingRoom = (room: Room, details: JoinDetails, wasRemoved: boolean) => {
      // The same person trying again replaces their earlier place in the queue.
      const previous = details.userId ? waitingEntryFor(room, details.userId) : undefined;
      if (previous) io.sockets.sockets.get(previous.id)?.disconnect(true);
      if (room.waiting.size >= MAX_WAITING_PER_ROOM) {
        socket.emit("error", { code: JOIN_ERROR.WAITING_ROOM_FULL, message: "This room's waiting room is full, please try again later" });
        return;
      }
      room.waiting.set(socket.id, {
        id: socket.id,
        name: details.name,
        userId: details.userId,
        wasRemoved,
        admit: () => {
          if (isNameTaken(room, details.name, evictedBy(room, details))) {
            leaveWaitingRoom();
            refuseTakenName();
            return true;
          }
          if (!enterRoom(room, details)) return false;
          if (details.userId) room.blockedUsers.delete(details.userId);
          room.blockedIps.delete(ip);
          room.waiting.delete(socket.id);
          waitingIn = null;
          return true;
        },
      });
      waitingIn = room;
      socket.emit("join-waiting");
      announceWaiting(io, room);
    };

    on(socket, "join-room", parseJoinRoom, ({ roomId, name, password, clientKey, isMuted, ownerToken }) => {
      // A repeated join for the room this socket is already in (double emit
      // or retry) is a no-op: re-adding it would make peers tear down working
      // connections, and the earlier join already answered with room-joined.
      if (socketRoomMap.get(socket.id) === roomId || waitingIn) return;
      const room = getRoom(roomId);
      if (!room) {
        socket.emit("error", { code: JOIN_ERROR.ROOM_NOT_FOUND, message: "Room not found" });
        return;
      }

      const userId = clientKey ? deriveUserId(roomId, clientKey) : undefined;
      // The secret key behind a userId proves this person already got in, so a
      // reconnect or reload needs no password, and browsers don't have to keep it.
      const isMember = !!userId && room.memberIds.has(userId);

      // Only wrong passwords spend a token, so people who know the password are
      // unaffected. Checked first: once limited, even a correct guess must not
      // get a different answer. Not for members, who aren't guessing: someone
      // attacking the password must not be able to lock them out of a rejoin.
      const guesser = `${roomId}|${ip}`;
      if (!isMember && (!passwordGuesses.canTake(guesser) || !roomPasswordGuesses.canTake(roomId))) {
        rejectAsLimited();
        return;
      }
      if (!isMember && !verifyPassword(room, password)) {
        if (password === undefined) {
          socket.emit("error", { code: JOIN_ERROR.PASSWORD_REQUIRED, message: "This room needs a password" });
          return;
        }
        passwordGuesses.take(guesser);
        roomPasswordGuesses.take(roomId);
        countSecurityEvent("wrong_password");
        socket.emit("error", { code: JOIN_ERROR.INCORRECT_PASSWORD, message: "Incorrect password" });
        return;
      }

      const isCreator = !!ownerToken && room.ownerToken === ownerToken;
      const details: JoinDetails = { name, userId, isMuted, isCreator };

      if (isNameTaken(room, name, evictedBy(room, details))) {
        refuseTakenName();
        return;
      }

      // A person removed earlier always waits, while others on their network only
      // wait if they aren't already members. An owner or admitted member reconnecting
      // doesn't wait because of the room's setting.
      const wasRemoved = (!!userId && room.blockedUsers.has(userId)) || (!isMember && room.blockedIps.has(ip));
      const isKnown = isMember || (!!userId && room.owners.has(userId));
      if (!isCreator && (wasRemoved || (room.settings.waitingRoom && !isKnown))) {
        enterWaitingRoom(room, details, wasRemoved);
        return;
      }

      if (!enterRoom(room, details)) {
        socket.emit("error", {
          code: JOIN_ERROR.ROOM_FULL,
          message: `This room is full (max ${MAX_PARTICIPANTS} participants).`,
        });
      }
    }, () => {
      // Answer an invalid payload (missing/oversized name, non-string fields)
      // instead of dropping it, so the client can leave "Connecting…".
      socket.emit("error", { code: JOIN_ERROR.INVALID_JOIN, message: "Invalid name or room" });
    }, rejectAsLimited); // Answered for the same reason as above.

    onRelay(socket, "offer", "offer");
    onRelay(socket, "answer", "answer");
    onRelay(socket, "ice-candidate", "candidate");

    onRoom(socket, "mute-toggle", parseMute, ({ roomId, room }, { isMuted }) => {
      setMuted(room, socket.id, isMuted);
      socket.to(roomId).emit("participant-muted", { id: socket.id, isMuted });
    });

    onRoom(socket, "voice-activity", noPayload, ({ room }) => touchRoom(room));

    onRoom(socket, "screen-share-started", noPayload, ({ roomId, room, participant }) => {
      if (!hasPermission(room, "screenSharePermission", participant.userId)) return;
      room.screenSharerId = socket.id;
      socket.to(roomId).emit("screen-share-started", { id: socket.id });
    });

    onRoom(socket, "screen-share-stopped", noPayload, ({ roomId, room }) => {
      if (room.screenSharerId === socket.id) {
        room.screenSharerId = null;
      }
      socket.to(roomId).emit("screen-share-stopped", { id: socket.id });
    });

    // Not client input (Socket.IO passes a reason string); wrapped only so a
    // throw during cleanup cannot crash the process.
    on(socket, "disconnect", parseDisconnect, ({ reason }) => {
      clearTimeout(joinDeadline);
      leaveWaitingRoom();
      const roomId = socketRoomMap.get(socket.id);
      const room = roomId ? getRoom(roomId) : undefined;
      const userId = room?.participants.get(socket.id)?.userId;
      // A kick adds them to blockedUsers before disconnecting them.
      const kicked = !!userId && !!room?.blockedUsers.has(userId);
      leaveCurrentRoom(reason === LEFT_ON_PURPOSE || kicked);
      // Unlike a lost connection, leaving ends membership and ownership: Back or a
      // return visit starts over, and someone else can take over at once.
      if (room && userId && reason === LEFT_ON_PURPOSE) {
        room.memberIds.delete(userId);
        const wasOwner = room.owners.delete(userId);
        const wasCreator = room.creatorId === userId;
        if (wasCreator) room.creatorId = null;
        // With another owner present nobody is promoted, but the others must
        // still learn the role is gone, or their menus keep protecting it.
        if (!promoteIfOwnerless(io, room) && (wasOwner || wasCreator)) announceSettings(io, room);
      }
    });
  });
}

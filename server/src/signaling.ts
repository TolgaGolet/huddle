import {
  addParticipant,
  removeParticipant,
  getRoom,
  getParticipantsArray,
  setMuted,
  verifyPassword,
  isNameTaken,
  isRoomFull,
  socketRoomMap,
} from "./roomManager.js";
import { deriveUserId } from "./identity.js";
import { createIpLimiter, IP_LIMITS, requestIp } from "./ipRateLimit.js";
import { JOIN_ERROR } from "./joinErrors.js";
import { MAX_PARTICIPANTS } from "./limits.js";
import { on, onRelay, onRoom, type AppServer } from "./socketRoute.js";
import { noPayload, parseJoinRoom, parseMute } from "./validation.js";

const roomScreenSharer = new Map<string, string>();

export function setupSignaling(io: AppServer, proxyHops = 0): void {
  const passwordGuesses = createIpLimiter(IP_LIMITS.passwordGuesses);

  io.on("connection", (socket) => {
    const rejectAsLimited = () => {
      socket.emit("error", { code: JOIN_ERROR.RATE_LIMITED, message: "Too many attempts to join, please try again shortly" });
    };

    // Remove this socket from the room it has joined (if any) and tell the
    // others. Used on disconnect, and by a successful join-room into another
    // room so the socket never leaves a ghost participant behind.
    const leaveCurrentRoom = () => {
      const roomId = socketRoomMap.get(socket.id);
      if (!roomId) return;
      if (roomScreenSharer.get(roomId) === socket.id) {
        roomScreenSharer.delete(roomId);
        socket.to(roomId).emit("screen-share-stopped", { id: socket.id });
      }
      removeParticipant(roomId, socket.id);
      socket.to(roomId).emit("participant-left", { id: socket.id });
      void socket.leave(roomId);
      // The room lingers for ROOM_GRACE_MS after the last participant leaves
      // (in case everyone is reconnecting after a shared network blip); its
      // images are deleted via onRoomDestroyed once it is truly gone.
    };

    on(socket, "join-room", parseJoinRoom, ({ roomId, name, password, clientKey }) => {
      // A repeated join for the room this socket is already in (double emit
      // or retry) is a no-op: re-adding it would make peers tear down working
      // connections, and the earlier join already answered with room-joined.
      if (socketRoomMap.get(socket.id) === roomId) return;
      const room = getRoom(roomId);
      if (!room) {
        socket.emit("error", { code: JOIN_ERROR.ROOM_NOT_FOUND, message: "Room not found" });
        return;
      }

      // Only wrong passwords spend a token, so people who know the password are
      // unaffected. Checked first: once limited, even a correct guess must not
      // get a different answer.
      const guesser = `${roomId}|${requestIp(socket.request, proxyHops)}`;
      if (!passwordGuesses.canTake(guesser)) {
        rejectAsLimited();
        return;
      }
      if (!verifyPassword(roomId, password)) {
        passwordGuesses.take(guesser);
        socket.emit("error", { code: JOIN_ERROR.INCORRECT_PASSWORD, message: "Incorrect password" });
        return;
      }

      // Rejoin race fix: after a network blip the client's socket reconnects
      // with a new socket.id and re-emits join-room, but the server may still
      // hold the participant entry of the OLD socket for up to ~20s (default
      // pingTimeout), and that socket can still look live. A matching userId
      // proves the entry is the joiner's own, so evict it instead of rejecting
      // the join with "Name already taken". A dead socket holding the name is
      // evicted too. Disconnecting a live one stops it reconnecting (it is
      // server-initiated), so two holders of a key can't keep evicting each other.
      const userId = clientKey ? deriveUserId(roomId, clientKey) : undefined;
      const lowerName = name.toLowerCase();
      for (const p of room.participants.values()) {
        const nameHeldByDeadSocket = p.name.toLowerCase() === lowerName && !io.sockets.sockets.has(p.id);
        if (p.userId !== userId && !nameHeldByDeadSocket) continue;
        if (roomScreenSharer.get(roomId) === p.id) {
          roomScreenSharer.delete(roomId);
          socket.to(roomId).emit("screen-share-stopped", { id: p.id });
        }
        removeParticipant(roomId, p.id);
        socket.to(roomId).emit("participant-left", { id: p.id });
        io.sockets.sockets.get(p.id)?.disconnect(true);
      }

      if (isNameTaken(roomId, name)) {
        socket.emit("error", { code: JOIN_ERROR.NAME_TAKEN, message: "Name already taken in this room" });
        return;
      }

      if (isRoomFull(roomId)) {
        socket.emit("error", {
          code: JOIN_ERROR.ROOM_FULL,
          message: `This room is full (max ${MAX_PARTICIPANTS} participants).`,
        });
        return;
      }

      // Only now that the new join is certain to succeed, leave the previous
      // room; a failed join must not drop the socket from the room it is in.
      leaveCurrentRoom();
      const participant = addParticipant(roomId, socket.id, name, userId);
      if (!participant) return;

      socket.join(roomId);

      const existingParticipants = getParticipantsArray(roomId).filter(
        (p) => p.id !== socket.id,
      );
      socket.emit("room-joined", {
        userId: participant.userId,
        participants: existingParticipants,
        chatHistory: room.chatHistory,
        pinnedMessageId: room.pinnedMessageId,
        screenSharer: roomScreenSharer.get(roomId) || null,
      });

      socket.to(roomId).emit("participant-joined", participant);
    }, () => {
      // Answer an invalid payload (missing/oversized name, non-string fields)
      // instead of dropping it, so the client can leave "Connecting…".
      socket.emit("error", { code: JOIN_ERROR.INVALID_JOIN, message: "Invalid name or room" });
    }, rejectAsLimited); // Answered for the same reason as above.

    onRelay(socket, "offer", "offer");
    onRelay(socket, "answer", "answer");
    onRelay(socket, "ice-candidate", "candidate");

    onRoom(socket, "mute-toggle", parseMute, ({ roomId }, { isMuted }) => {
      setMuted(roomId, socket.id, isMuted);
      socket.to(roomId).emit("participant-muted", { id: socket.id, isMuted });
    });

    onRoom(socket, "screen-share-started", noPayload, ({ roomId }) => {
      roomScreenSharer.set(roomId, socket.id);
      socket.to(roomId).emit("screen-share-started", { id: socket.id });
    });

    onRoom(socket, "screen-share-stopped", noPayload, ({ roomId }) => {
      if (roomScreenSharer.get(roomId) === socket.id) {
        roomScreenSharer.delete(roomId);
      }
      socket.to(roomId).emit("screen-share-stopped", { id: socket.id });
    });

    // Not client input (Socket.IO passes a reason string); wrapped only so a
    // throw during cleanup cannot crash the process.
    on(socket, "disconnect", noPayload, leaveCurrentRoom);
  });
}

import type { Server, Socket } from "socket.io";
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
import { MAX_PARTICIPANTS } from "./limits.js";
import { on, onRelay, onRoom } from "./socketRoute.js";
import { noPayload, parseJoinRoom, parseMute } from "./validation.js";

const roomScreenSharer = new Map<string, string>();

export function setupSignaling(io: Server): void {
  io.on("connection", (socket: Socket) => {
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

    on(socket, "join-room", parseJoinRoom, ({ roomId, name, password }) => {
      // A repeated join for the room this socket is already in (double emit
      // or retry) is a no-op: re-adding it would make peers tear down working
      // connections, and the earlier join already answered with room-joined.
      if (socketRoomMap.get(socket.id) === roomId) return;
      const room = getRoom(roomId);
      if (!room) {
        socket.emit("error", { message: "Room not found" });
        return;
      }

      if (!verifyPassword(roomId, password)) {
        socket.emit("error", { message: "Incorrect password" });
        return;
      }

      // Rejoin race fix: after a network blip the client's socket reconnects
      // with a new socket.id and re-emits join-room, but the server may still
      // hold the participant entry of the OLD socket for up to ~20s (default
      // pingTimeout). If that stale entry owns the requested name, evict it
      // instead of rejecting the join — otherwise the user is kicked from the
      // room by "Name already taken" through no fault of their own.
      const lowerName = name.toLowerCase();
      for (const p of room.participants.values()) {
        if (p.name.toLowerCase() === lowerName && !io.sockets.sockets.has(p.id)) {
          removeParticipant(roomId, p.id);
          socket.to(roomId).emit("participant-left", { id: p.id });
        }
      }

      if (isNameTaken(roomId, name)) {
        socket.emit("error", { message: "Name already taken in this room" });
        return;
      }

      if (isRoomFull(roomId)) {
        socket.emit("error", {
          message: `This room is full (max ${MAX_PARTICIPANTS} participants).`,
        });
        return;
      }

      // Only now that the new join is certain to succeed, leave the previous
      // room; a failed join must not drop the socket from the room it is in.
      leaveCurrentRoom();
      const participant = addParticipant(roomId, socket.id, name);
      if (!participant) return;

      socket.join(roomId);

      const existingParticipants = getParticipantsArray(roomId).filter(
        (p) => p.id !== socket.id,
      );
      socket.emit("room-joined", {
        participants: existingParticipants,
        chatHistory: room.chatHistory,
        screenSharer: roomScreenSharer.get(roomId) || null,
      });

      socket.to(roomId).emit("participant-joined", participant);
    }, () => {
      // Answer an invalid payload (missing/oversized name, non-string fields)
      // instead of dropping it, so the client can leave "Connecting…".
      socket.emit("error", { message: "Invalid name or room" });
    });

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

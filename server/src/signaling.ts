import type { Server, Socket } from "socket.io";
import {
  addParticipant,
  removeParticipant,
  getRoom,
  getParticipantsArray,
  setMuted,
  verifyPassword,
  isNameTaken,
} from "./roomManager.js";

export const socketRoomMap = new Map<string, string>();
const roomScreenSharer = new Map<string, string>();

export function setupSignaling(io: Server): void {
  io.on("connection", (socket: Socket) => {
    socket.on("join-room", ({ roomId, name, password }: { roomId: string; name: string; password?: string }) => {
      const room = getRoom(roomId);
      if (!room) {
        socket.emit("error", { message: "Room not found" });
        return;
      }

      if (!verifyPassword(roomId, password)) {
        socket.emit("error", { message: "Incorrect password" });
        return;
      }

      if (isNameTaken(roomId, name)) {
        socket.emit("error", { message: "Name already taken in this room" });
        return;
      }

      const participant = addParticipant(roomId, socket.id, name);
      if (!participant) return;

      socketRoomMap.set(socket.id, roomId);
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
    });

    socket.on("offer", ({ to, offer }: { to: string; offer: RTCSessionDescriptionInit }) => {
      socket.to(to).emit("offer", { from: socket.id, offer });
    });

    socket.on("answer", ({ to, answer }: { to: string; answer: RTCSessionDescriptionInit }) => {
      socket.to(to).emit("answer", { from: socket.id, answer });
    });

    socket.on("ice-candidate", ({ to, candidate }: { to: string; candidate: RTCIceCandidateInit }) => {
      socket.to(to).emit("ice-candidate", { from: socket.id, candidate });
    });

    socket.on("mute-toggle", ({ isMuted }: { isMuted: boolean }) => {
      const roomId = socketRoomMap.get(socket.id);
      if (!roomId) return;
      setMuted(roomId, socket.id, isMuted);
      socket.to(roomId).emit("participant-muted", { id: socket.id, isMuted });
    });

    socket.on("screen-share-started", () => {
      const roomId = socketRoomMap.get(socket.id);
      if (!roomId) return;
      roomScreenSharer.set(roomId, socket.id);
      socket.to(roomId).emit("screen-share-started", { id: socket.id });
    });

    socket.on("screen-share-stopped", () => {
      const roomId = socketRoomMap.get(socket.id);
      if (!roomId) return;
      if (roomScreenSharer.get(roomId) === socket.id) {
        roomScreenSharer.delete(roomId);
      }
      socket.to(roomId).emit("screen-share-stopped", { id: socket.id });
    });

    socket.on("disconnect", () => {
      const roomId = socketRoomMap.get(socket.id);
      if (!roomId) return;
      if (roomScreenSharer.get(roomId) === socket.id) {
        roomScreenSharer.delete(roomId);
        socket.to(roomId).emit("screen-share-stopped", { id: socket.id });
      }
      removeParticipant(roomId, socket.id);
      socketRoomMap.delete(socket.id);
      socket.to(roomId).emit("participant-left", { id: socket.id });
    });
  });
}

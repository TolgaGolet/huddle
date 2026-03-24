import type { Server, Socket } from "socket.io";
import { nanoid } from "nanoid";
import { addChatMessage, getRoom } from "./roomManager.js";

const socketRoomMap = new Map<string, string>();

export function setupChat(io: Server): void {
  io.on("connection", (socket: Socket) => {
    socket.on("join-room", ({ roomId }: { roomId: string }) => {
      socketRoomMap.set(socket.id, roomId);
    });

    socket.on("chat-message", ({ text }: { text: string }) => {
      const roomId = socketRoomMap.get(socket.id);
      if (!roomId) return;

      const room = getRoom(roomId);
      if (!room) return;

      const participant = room.participants.get(socket.id);
      if (!participant) return;

      const msg = {
        id: nanoid(10),
        senderId: socket.id,
        senderName: participant.name,
        text: text.trim(),
        timestamp: Date.now(),
      };

      if (!msg.text) return;

      addChatMessage(roomId, msg);
      io.to(roomId).emit("chat-message", msg);
    });

    socket.on("disconnect", () => {
      socketRoomMap.delete(socket.id);
    });
  });
}

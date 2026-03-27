import type { Server, Socket } from "socket.io";
import { nanoid } from "nanoid";
import { addChatMessage, getRoom } from "./roomManager.js";
import { socketRoomMap } from "./signaling.js";

export function setupChat(io: Server): void {
  io.on("connection", (socket: Socket) => {
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
  });
}

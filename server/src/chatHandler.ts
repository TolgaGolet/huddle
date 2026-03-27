import type { Server, Socket } from "socket.io";
import { nanoid } from "nanoid";
import { addChatMessage, getRoom, type ChatMessage } from "./roomManager.js";
import { socketRoomMap } from "./signaling.js";

const GIPHY_CDN = "https://media";

interface IncomingChatMessage {
  text: string;
  replyTo?: { id: string; senderName: string; text: string };
  gifUrl?: string;
}

export function setupChat(io: Server): void {
  io.on("connection", (socket: Socket) => {
    socket.on("chat-message", ({ text, replyTo, gifUrl }: IncomingChatMessage) => {
      const roomId = socketRoomMap.get(socket.id);
      if (!roomId) return;

      const room = getRoom(roomId);
      if (!room) return;

      const participant = room.participants.get(socket.id);
      if (!participant) return;

      const trimmed = text?.trim() ?? "";

      // Validate gifUrl is a GIPHY CDN URL to prevent abuse
      const safeGifUrl =
        typeof gifUrl === "string" && gifUrl.startsWith(GIPHY_CDN)
          ? gifUrl
          : undefined;

      // A message must have text or a GIF
      if (!trimmed && !safeGifUrl) return;

      const msg: ChatMessage = {
        id: nanoid(10),
        senderId: socket.id,
        senderName: participant.name,
        text: trimmed,
        timestamp: Date.now(),
        reactions: {},
      };

      if (safeGifUrl) {
        msg.gifUrl = safeGifUrl;
      }

      if (replyTo?.id && replyTo.senderName && replyTo.text) {
        msg.replyTo = {
          id: replyTo.id,
          senderName: replyTo.senderName,
          text: replyTo.text,
        };
      }

      addChatMessage(roomId, msg);
      io.to(roomId).emit("chat-message", msg);
    });

    socket.on("chat-reaction", ({ messageId, emoji }: { messageId: string; emoji: string }) => {
      const roomId = socketRoomMap.get(socket.id);
      if (!roomId) return;

      const room = getRoom(roomId);
      if (!room) return;

      const participant = room.participants.get(socket.id);
      if (!participant) return;

      const entry = room.chatHistory.find((m) => m.id === messageId);
      if (!entry || "type" in entry) return;

      const msg = entry as ChatMessage;
      if (!msg.reactions) msg.reactions = {};

      const list = msg.reactions[emoji] || [];
      const idx = list.indexOf(participant.name);
      if (idx >= 0) {
        list.splice(idx, 1);
        if (list.length === 0) {
          delete msg.reactions[emoji];
        } else {
          msg.reactions[emoji] = list;
        }
      } else {
        msg.reactions[emoji] = [...list, participant.name];
      }

      io.to(roomId).emit("chat-reaction-update", {
        messageId,
        reactions: msg.reactions,
      });
    });
  });
}

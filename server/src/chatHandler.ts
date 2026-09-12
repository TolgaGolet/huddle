import type { Server, Socket } from "socket.io";
import { nanoid } from "nanoid";
import { addChatMessage, getRoom, type ChatMessage } from "./roomManager.js";
import { socketRoomMap } from "./signaling.js";

const GIPHY_CDN = "https://media";

interface IncomingChatMessage {
  text: string;
  replyTo?: { id: string; senderName: string; text: string; imageUrl?: string };
  gifUrl?: string;
  imageUrls?: string[];
}

function validImageUrls(roomId: string, imageUrls: unknown): imageUrls is string[] {
  if (!Array.isArray(imageUrls) || imageUrls.length > 10) return false;
  const prefix = `/api/rooms/${roomId}/images/`;
  return imageUrls.every((url) =>
    typeof url === "string" &&
    url.startsWith(prefix) &&
    /^\/api\/rooms\/[^/]+\/images\/[a-z0-9_-]{10}\.(jpg|jpeg|png|gif|webp|bmp|avif|heic|heif)$/.test(url),
  );
}

function validImageUrl(roomId: string, imageUrl: unknown): imageUrl is string {
  return validImageUrls(roomId, [imageUrl]);
}

export function setupChat(io: Server): void {
  io.on("connection", (socket: Socket) => {
    // Typing indicator relay: broadcast to the room so others can show
    // "X is typing...". Clients auto-expire the indicator themselves.
    socket.on("typing", () => {
      const roomId = socketRoomMap.get(socket.id);
      if (!roomId) return;
      const room = getRoom(roomId);
      const participant = room?.participants.get(socket.id);
      if (!participant) return;
      io.to(roomId).emit("typing", {
        senderId: socket.id,
        senderName: participant.name,
      });
    });

    socket.on("chat-message", ({ text, replyTo, gifUrl, imageUrls }: IncomingChatMessage) => {
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
      const safeImageUrls = validImageUrls(roomId, imageUrls) ? imageUrls : undefined;

      // A message must have text, a GIF, or at least one room-scoped image.
      if (!trimmed && !safeGifUrl && !safeImageUrls?.length) return;

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
      if (safeImageUrls?.length) {
        msg.imageUrls = safeImageUrls;
      }

      const replyImageUrl = validImageUrl(roomId, replyTo?.imageUrl) ? replyTo.imageUrl : undefined;
      if (replyTo?.id && replyTo.senderName && (replyTo.text || replyImageUrl)) {
        msg.replyTo = {
          id: replyTo.id,
          senderName: replyTo.senderName,
          text: replyTo.text || "[Image]",
        };
        if (replyImageUrl) msg.replyTo.imageUrl = replyImageUrl;
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

    socket.on("chat-edit", ({ messageId, text }: { messageId: string; text: string }) => {
      const roomId = socketRoomMap.get(socket.id);
      if (!roomId) return;
      const room = getRoom(roomId);
      if (!room) return;
      const participant = room.participants.get(socket.id);
      if (!participant) return;

      const entry = room.chatHistory.find((m) => m.id === messageId);
      if (!entry || "type" in entry) return;
      const msg = entry as ChatMessage;

      // Only the sender can edit their own message. GIFs and image-only
      // messages cannot be edited to text.
      if (msg.senderId !== socket.id) return;
      const trimmed = text?.trim() ?? "";
      if (!trimmed || msg.gifUrl || msg.imageUrls?.length) return;

      msg.text = trimmed;
      msg.edited = true;
      io.to(roomId).emit("chat-message-edit", { messageId, text: trimmed });
    });

    socket.on("chat-delete", ({ messageId }: { messageId: string }) => {
      const roomId = socketRoomMap.get(socket.id);
      if (!roomId) return;
      const room = getRoom(roomId);
      if (!room) return;
      if (!room.participants.has(socket.id)) return;

      const entry = room.chatHistory.find((m) => m.id === messageId);
      if (!entry) return;
      if (entry.senderId !== socket.id) return;

      if (room.pinnedMessageId === messageId) room.pinnedMessageId = null;
      room.chatHistory = room.chatHistory.filter((m) => m.id !== messageId);
      io.to(roomId).emit("chat-message-delete", { messageId });
    });

    socket.on("chat-pin", ({ messageId }: { messageId: string }) => {
      const roomId = socketRoomMap.get(socket.id);
      if (!roomId) return;
      const room = getRoom(roomId);
      if (!room) return;
      if (!room.participants.has(socket.id)) return;

      const entry = room.chatHistory.find((m) => m.id === messageId);
      if (!entry) return;

      // Toggle: pinning a different message unpins the previous one.
      room.pinnedMessageId = room.pinnedMessageId === messageId ? null : messageId;
      io.to(roomId).emit("chat-pin-update", {
        pinnedMessageId: room.pinnedMessageId,
        chatHistory: room.chatHistory,
      });
    });
  });
}

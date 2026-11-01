import type { Server, Socket } from "socket.io";
import { nanoid } from "nanoid";
import { addChatMessage, emptyReactions, removeMessage, type ChatMessage } from "./roomManager.js";
import { isRoomImageUrl } from "./imageRouter.js";
import { onRoom } from "./socketRoute.js";
import {
  noPayload,
  parseChatEdit,
  parseChatMessage,
  parseChatReaction,
  parseMessageId,
} from "./validation.js";

// GIFs must come from Giphy's CDN (media.giphy.com, media0-4.giphy.com) so a
// crafted URL cannot make every member's browser fetch an arbitrary host.
const GIPHY_CDN_HOST = /^media\d*\.giphy\.com$/;
// Distinct reaction keys per message. The emoji is free-form (any picker
// emoji), so without a cap a client could grow a message's reaction map, and
// every broadcast of it, without bound.
const MAX_REACTION_KEYS = 20;

function isGiphyUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && GIPHY_CDN_HOST.test(u.hostname);
  } catch {
    return false;
  }
}

export function setupChat(io: Server): void {
  io.on("connection", (socket: Socket) => {
    // Typing indicator relay: broadcast to the room so others can show
    // "X is typing...". Clients auto-expire the indicator themselves.
    onRoom(socket, "typing", noPayload, ({ roomId, participant }) => {
      io.to(roomId).emit("typing", {
        senderId: socket.id,
        senderName: participant.name,
      });
    });

    onRoom(socket, "chat-message", parseChatMessage, ({ roomId, participant }, { text, replyTo, gifUrl, imageUrls }) => {
      // Validate gifUrl is a GIPHY CDN URL to prevent abuse
      const safeGifUrl = gifUrl && isGiphyUrl(gifUrl) ? gifUrl : undefined;
      // Shape and count are enforced by the parser; each URL must also point
      // at an image uploaded to this room.
      const safeImageUrls = imageUrls?.every((u) => isRoomImageUrl(roomId, u)) ? imageUrls : undefined;

      // A message must have text, a GIF, or at least one room-scoped image.
      if (!text && !safeGifUrl && !safeImageUrls?.length) return;

      const msg: ChatMessage = {
        id: nanoid(10),
        senderId: participant.userId,
        senderName: participant.name,
        text,
        timestamp: Date.now(),
        reactions: emptyReactions(),
      };

      if (safeGifUrl) {
        msg.gifUrl = safeGifUrl;
      }
      if (safeImageUrls?.length) {
        msg.imageUrls = safeImageUrls;
      }

      const replyImageUrl =
        replyTo?.imageUrl && isRoomImageUrl(roomId, replyTo.imageUrl) ? replyTo.imageUrl : undefined;
      if (replyTo && (replyTo.text || replyImageUrl)) {
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

    onRoom(socket, "chat-reaction", parseChatReaction, ({ roomId, room, participant }, { messageId, emoji }) => {
      const entry = room.chatHistory.find((m) => m.id === messageId);
      if (!entry || "type" in entry) return;

      const msg = entry as ChatMessage;
      const list = msg.reactions[emoji] ?? [];
      const idx = list.findIndex((u) => u.userId === participant.userId);
      if (idx >= 0) {
        list.splice(idx, 1);
        if (list.length === 0) {
          delete msg.reactions[emoji];
        } else {
          msg.reactions[emoji] = list;
        }
      } else {
        if (!(emoji in msg.reactions) && Object.keys(msg.reactions).length >= MAX_REACTION_KEYS) return;
        msg.reactions[emoji] = [...list, { userId: participant.userId, name: participant.name }];
      }

      io.to(roomId).emit("chat-reaction-update", {
        messageId,
        reactions: msg.reactions,
      });
    });

    onRoom(socket, "chat-edit", parseChatEdit, ({ roomId, room, participant }, { messageId, text }) => {
      const entry = room.chatHistory.find((m) => m.id === messageId);
      if (!entry || "type" in entry) return;
      const msg = entry as ChatMessage;

      // Only the sender can edit their own message. GIFs and image-only
      // messages cannot be edited to text.
      if (msg.senderId !== participant.userId) return;
      if (msg.gifUrl || msg.imageUrls?.length) return;

      msg.text = text;
      msg.edited = true;
      io.to(roomId).emit("chat-message-edit", { messageId, text });
    });

    onRoom(socket, "chat-delete", parseMessageId, ({ roomId, room, participant }, { messageId }) => {
      const entry = room.chatHistory.find((m) => m.id === messageId);
      if (!entry) return;
      if (entry.senderId !== participant.userId) return;

      removeMessage(roomId, messageId);
      io.to(roomId).emit("chat-message-delete", { messageId });
    });

    onRoom(socket, "chat-pin", parseMessageId, ({ roomId, room }, { messageId }) => {
      const entry = room.chatHistory.find((m) => m.id === messageId);
      if (!entry) return;

      // Toggle: pinning a different message unpins the previous one.
      room.pinnedMessageId = room.pinnedMessageId === messageId ? null : messageId;
      io.to(roomId).emit("chat-pin-update", { pinnedMessageId: room.pinnedMessageId });
    });
  });
}

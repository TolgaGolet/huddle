import { nanoid } from "nanoid";
import { addChatMessage, findEntry, emptyReactions, hasPermission, removeMessage, touchRoom, type ChatMessage, type RoomCtx } from "./roomManager.js";
import { isRoomImageUrl } from "./imageRouter.js";
import { attachmentLabel, hasEditableContent, isPollMessage, mayDeleteMessage, quoteText } from "./protocol.js";
import { onRoom, type AppServer, type AppSocket } from "./socketRoute.js";
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

/**
 * Text, GIFs, images, polls and edits need the room's message permission. The
 * sender is told when it's missing, since its client may already have cleared
 * a draft sent just as the setting changed.
 */
export function maySendMessages(socket: AppSocket, { room, participant }: RoomCtx, event: string): boolean {
  if (hasPermission(room, "messagePermission", participant.userId)) return true;
  socket.emit("not-permitted", { event });
  return false;
}

function isGiphyUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && GIPHY_CDN_HOST.test(u.hostname);
  } catch {
    return false;
  }
}

/** Built from the server's own history, so nobody can attribute words to someone else. */
function quoteOf(quoted: ChatMessage): NonNullable<ChatMessage["replyTo"]> {
  return { id: quoted.id, senderName: quoted.senderName, text: quoteText(quoted.text) || attachmentLabel(quoted), imageUrl: quoted.imageUrls?.[0] };
}

export function setupChat(io: AppServer): void {
  io.on("connection", (socket) => {
    // Typing indicator relay: broadcast to the others so they can show
    // "X is typing...". Clients auto-expire the indicator themselves.
    onRoom(socket, "typing", noPayload, ({ roomId, room, participant }) => {
      if (!hasPermission(room, "messagePermission", participant.userId)) return;
      touchRoom(room);
      socket.to(roomId).emit("typing", {
        userId: participant.userId,
        senderName: participant.name,
      });
    });

    onRoom(socket, "chat-message", parseChatMessage, (ctx, { text, replyToId, gifUrl, imageUrls }) => {
      if (!maySendMessages(socket, ctx, "chat-message")) return;
      const { roomId, room, participant } = ctx;
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

      // If the original is gone, the message still goes, without a quote.
      const quoted = replyToId ? findEntry(room, replyToId) : undefined;
      if (quoted && !isPollMessage(quoted)) msg.replyTo = quoteOf(quoted);

      addChatMessage(room, msg);
      touchRoom(room);
      io.to(roomId).emit("chat-message", msg);
    });

    onRoom(socket, "chat-reaction", parseChatReaction, ({ roomId, room, participant }, { messageId, emoji }) => {
      const msg = findEntry(room, messageId);
      if (!msg || isPollMessage(msg)) return;

      touchRoom(room);
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

    onRoom(socket, "chat-edit", parseChatEdit, (ctx, { messageId, text }) => {
      // An edit can say anything, so it counts as sending.
      if (!maySendMessages(socket, ctx, "chat-edit")) return;
      const { roomId, room, participant } = ctx;
      const msg = findEntry(room, messageId);
      if (!msg || isPollMessage(msg)) return;

      // Only the sender can edit their own message, and only plain text.
      if (msg.senderId !== participant.userId || !hasEditableContent(msg)) return;

      touchRoom(room);
      msg.text = text;
      msg.edited = true;
      for (const m of room.chatHistory) {
        if (!isPollMessage(m) && m.replyTo?.id === messageId) m.replyTo.text = quoteText(text);
      }
      io.to(roomId).emit("chat-message-edit", { messageId, text });
    });

    onRoom(socket, "chat-delete", parseMessageId, ({ roomId, room, participant }, { messageId }) => {
      const entry = findEntry(room, messageId);
      if (!entry) return;
      if (!mayDeleteMessage(entry.senderId, participant.userId, room.owners.has(participant.userId))) return;

      removeMessage(room, messageId);
      io.to(roomId).emit("chat-message-delete", { messageId });
    });

    onRoom(socket, "chat-pin", parseMessageId, ({ roomId, room, participant }, { messageId }) => {
      if (!hasPermission(room, "pinPermission", participant.userId)) return;
      const entry = findEntry(room, messageId);
      if (!entry) return;

      // Toggle: pinning a different message unpins the previous one.
      room.pinnedMessageId = room.pinnedMessageId === messageId ? null : messageId;
      io.to(roomId).emit("chat-pin-update", { pinnedMessageId: room.pinnedMessageId });
    });
  });
}

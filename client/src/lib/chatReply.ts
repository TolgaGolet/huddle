import type { ChatMessage } from "../types";

/**
 * The reply quote sent with a text, image or GIF message. An image-only message
 * needs the "[Image]" text or its URL, or the server drops the quote.
 */
export function buildReplyTo(msg: ChatMessage): NonNullable<ChatMessage["replyTo"]> {
  return {
    id: msg.id,
    senderName: msg.senderName,
    text: msg.text || (msg.imageUrls?.length ? "[Image]" : ""),
    imageUrl: msg.imageUrls?.[0],
  };
}

import { describe, expect, it } from "vitest";
import { buildReplyTo } from "./chatReply";
import type { ChatMessage } from "../types";

function message(fields: Partial<ChatMessage>): ChatMessage {
  return { id: "m1", senderId: "u1", senderName: "Ana", text: "", timestamp: 1, ...fields } as ChatMessage;
}

describe("buildReplyTo", () => {
  it("quotes a text message", () => {
    expect(buildReplyTo(message({ text: "hello" }))).toEqual({ id: "m1", senderName: "Ana", text: "hello" });
  });

  it("keeps the image and a text fallback for an image-only message", () => {
    // Regression: GIF replies sent empty text and no image, so the server dropped the quote.
    expect(buildReplyTo(message({ imageUrls: ["/a.png", "/b.png"] }))).toEqual({
      id: "m1",
      senderName: "Ana",
      text: "[Image]",
      imageUrl: "/a.png",
    });
  });

  it("prefers a message's own text over the image fallback", () => {
    expect(buildReplyTo(message({ text: "look", imageUrls: ["/a.png"] })).text).toBe("look");
  });
});

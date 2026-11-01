import { describe, it, expect } from "vitest";
import type { ChatMessage, PollMessage } from "../types";
import { isEditable } from "./messageEdit";

const message = (fields: Partial<ChatMessage> = {}): ChatMessage => ({
  id: "m1",
  senderId: "u1",
  senderName: "Ana",
  text: "hello",
  timestamp: 0,
  reactions: {},
  ...fields,
});

describe("isEditable", () => {
  it("allows a plain text message", () => {
    expect(isEditable(message())).toBe(true);
  });

  it("rejects a GIF, whose title is stored as its text", () => {
    expect(isEditable(message({ text: "cat", gifUrl: "https://example.com/cat.gif" }))).toBe(false);
  });

  it("rejects a message with images, even with a caption", () => {
    expect(isEditable(message({ imageUrls: ["/api/rooms/r/images/a.png"] }))).toBe(false);
  });

  it("rejects a poll", () => {
    const poll: PollMessage = { id: "p1", type: "poll", senderId: "u1", senderName: "Ana", question: "?", options: [], allowMultiple: false, timestamp: 0 };
    expect(isEditable(poll)).toBe(false);
  });
});

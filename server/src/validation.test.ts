import { describe, it, expect } from "vitest";
import {
  MAX_CHAT_TEXT_LENGTH,
  MAX_IMAGES_PER_MESSAGE,
  MAX_NAME_LENGTH,
  MAX_PASSWORD_LENGTH,
  MAX_POLL_OPTION_LENGTH,
  MAX_POLL_OPTIONS,
  MAX_POLL_QUESTION_LENGTH,
} from "./limits.js";
import {
  parseChatEdit,
  parseChatMessage,
  parseCreateRoom,
  parseChatReaction,
  parseJoinRoom,
  parseMessageId,
  parseMute,
  parsePollCreate,
  parsePollVote,
  parseRelay,
} from "./validation.js";

// Non-object payloads every parser must reject. These used to crash the
// server via destructuring or string methods on the wrong type (CQ-01).
const junk: unknown[] = [undefined, null, 5, "x", true, [], [1, 2]];

describe.each([
  ["parseJoinRoom", parseJoinRoom],
  ["parseRelay(offer)", parseRelay("offer")],
  ["parseMute", parseMute],
  ["parseChatMessage", parseChatMessage],
  ["parseChatReaction", parseChatReaction],
  ["parseChatEdit", parseChatEdit],
  ["parseMessageId", parseMessageId],
  ["parsePollCreate", parsePollCreate],
  ["parsePollVote", parsePollVote],
] as const)("%s", (_name, parse) => {
  it.each(junk)("rejects %j without throwing", (raw) => {
    expect(parse(raw)).toBeNull();
  });
});

describe("parseJoinRoom", () => {
  it("trims the name and keeps an optional password", () => {
    expect(parseJoinRoom({ roomId: "abc123", name: "  Ana ", password: "pw" })).toEqual({
      roomId: "abc123",
      name: "Ana",
      password: "pw",
    });
    expect(parseJoinRoom({ roomId: "abc123", name: "Ana" })).toEqual({ roomId: "abc123", name: "Ana" });
  });

  it("rejects missing, blank, non-string and oversized names", () => {
    expect(parseJoinRoom({ roomId: "abc123" })).toBeNull();
    expect(parseJoinRoom({ roomId: "abc123", name: "   " })).toBeNull();
    expect(parseJoinRoom({ roomId: "abc123", name: 42 })).toBeNull();
    expect(parseJoinRoom({ roomId: "abc123", name: "a".repeat(MAX_NAME_LENGTH + 1) })).toBeNull();
    expect(parseJoinRoom({ roomId: "abc123", name: "a".repeat(MAX_NAME_LENGTH) })).not.toBeNull();
  });

  it("rejects a non-string password", () => {
    expect(parseJoinRoom({ roomId: "abc123", name: "Ana", password: 1 })).toBeNull();
  });

  it("keeps a well-formed clientKey and treats it as optional", () => {
    const clientKey = "a".repeat(32);
    expect(parseJoinRoom({ roomId: "abc123", name: "Ana", clientKey })?.clientKey).toBe(clientKey);
    expect(parseJoinRoom({ roomId: "abc123", name: "Ana" })?.clientKey).toBeUndefined();
  });

  it("rejects a malformed clientKey instead of ignoring it", () => {
    for (const clientKey of [1, "", "short", "a".repeat(65), "has spaces in the key here"]) {
      expect(parseJoinRoom({ roomId: "abc123", name: "Ana", clientKey })).toBeNull();
    }
  });
});

describe("parseRelay", () => {
  it("requires a target and an object body", () => {
    expect(parseRelay("offer")({ to: "s1", offer: { type: "offer", sdp: "v=0" } })).toEqual({
      to: "s1",
      body: { type: "offer", sdp: "v=0" },
    });
    expect(parseRelay("offer")({ to: "s1" })).toBeNull();
    expect(parseRelay("answer")({ to: 1, answer: {} })).toBeNull();
    expect(parseRelay("answer")({ to: "s1", answer: "sdp" })).toBeNull();
  });

  it("allows a null end-of-candidates signal only for ICE", () => {
    expect(parseRelay("candidate")({ to: "s1", candidate: null })).toEqual({ to: "s1", body: null });
    expect(parseRelay("offer")({ to: "s1", offer: null })).toBeNull();
  });
});

describe("parseMute", () => {
  it("requires a boolean", () => {
    expect(parseMute({ isMuted: true })).toEqual({ isMuted: true });
    expect(parseMute({ isMuted: "true" })).toBeNull();
    expect(parseMute({})).toBeNull();
  });
});

describe("parseCreateRoom", () => {
  it("applies the same password limit as join-room", () => {
    const pw = "p".repeat(MAX_PASSWORD_LENGTH);
    expect(parseCreateRoom({})).toEqual({});
    expect(parseCreateRoom({ password: pw })).toEqual({ password: pw });
    expect(parseJoinRoom({ roomId: "r1", name: "Ana", password: pw })).not.toBeNull();
    expect(parseCreateRoom({ password: pw + "p" })).toBeNull();
    expect(parseCreateRoom({ password: 5 })).toBeNull();
  });
});

describe("parseChatMessage", () => {
  it("trims text and keeps valid optional fields", () => {
    expect(
      parseChatMessage({
        text: " hi ",
        replyTo: { id: "m1", senderName: "Ana", text: "earlier" },
        imageUrls: ["/api/rooms/r/images/abc.png"],
      }),
    ).toEqual({
      text: "hi",
      replyTo: { id: "m1", senderName: "Ana", text: "earlier" },
      imageUrls: ["/api/rooms/r/images/abc.png"],
    });
  });

  it("treats a missing text as empty (image/GIF-only messages)", () => {
    expect(parseChatMessage({ gifUrl: "https://media.giphy.com/x.gif" })).toEqual({
      text: "",
      gifUrl: "https://media.giphy.com/x.gif",
    });
  });

  it("rejects a wrong-typed or oversized text", () => {
    expect(parseChatMessage({ text: 5 })).toBeNull();
    expect(parseChatMessage({ text: "a".repeat(MAX_CHAT_TEXT_LENGTH + 1) })).toBeNull();
    expect(parseChatMessage({ text: "a".repeat(MAX_CHAT_TEXT_LENGTH) })).not.toBeNull();
  });

  it("drops a malformed optional field but still delivers the message", () => {
    const hi = { text: "hi", replyTo: undefined, gifUrl: undefined, imageUrls: undefined };
    for (const extra of [
      { gifUrl: 1 },
      { gifUrl: null },
      { imageUrls: "x" },
      { imageUrls: [1] },
      { imageUrls: Array(MAX_IMAGES_PER_MESSAGE + 1).fill("/a") },
      { replyTo: "m1" },
      { replyTo: { id: "m1", senderName: "Ana", text: 3 } },
      { replyTo: { id: "m1", senderName: "", text: "x" } },
      { replyTo: { id: "m1", senderName: "Ana", text: "x", imageUrl: null } },
    ]) {
      expect(parseChatMessage({ text: "hi", ...extra })).toStrictEqual(hi);
    }
  });
});

describe("message-id events", () => {
  it("parseChatReaction requires id and emoji", () => {
    expect(parseChatReaction({ messageId: "m1", emoji: "👍" })).toEqual({ messageId: "m1", emoji: "👍" });
    expect(parseChatReaction({ messageId: "m1" })).toBeNull();
  });

  it("parseChatEdit trims and rejects blank or oversized text", () => {
    expect(parseChatEdit({ messageId: "m1", text: " new " })).toEqual({ messageId: "m1", text: "new" });
    expect(parseChatEdit({ messageId: "m1", text: "  " })).toBeNull();
    expect(parseChatEdit({ messageId: "m1", text: "a".repeat(MAX_CHAT_TEXT_LENGTH + 1) })).toBeNull();
  });

  it("parseMessageId rejects non-strings", () => {
    expect(parseMessageId({ messageId: "m1" })).toEqual({ messageId: "m1" });
    expect(parseMessageId({ messageId: {} })).toBeNull();
  });

  it("parsePollVote requires both ids", () => {
    expect(parsePollVote({ pollId: "p1", optionId: "o1" })).toEqual({ pollId: "p1", optionId: "o1" });
    expect(parsePollVote({ pollId: "p1" })).toBeNull();
  });
});

describe("parsePollCreate", () => {
  const ok = { question: " Lunch? ", options: [" Pizza ", "", "Sushi"], allowMultiple: true };

  it("trims, drops blank options and coerces allowMultiple", () => {
    expect(parsePollCreate(ok)).toEqual({ question: "Lunch?", options: ["Pizza", "Sushi"], allowMultiple: true });
    expect(parsePollCreate({ ...ok, allowMultiple: "yes" })?.allowMultiple).toBe(false);
  });

  it("rejects a non-string question (the original crash)", () => {
    expect(parsePollCreate({ ...ok, question: 5 })).toBeNull();
  });

  it("rejects too few, too many, non-string or oversized options", () => {
    expect(parsePollCreate({ ...ok, options: ["a", " "] })).toBeNull();
    expect(parsePollCreate({ ...ok, options: "a,b" })).toBeNull();
    expect(parsePollCreate({ ...ok, options: ["a", 2] })).toBeNull();
    expect(parsePollCreate({ ...ok, options: Array(MAX_POLL_OPTIONS + 1).fill("x") })).toBeNull();
    expect(parsePollCreate({ ...ok, options: ["a", "b".repeat(MAX_POLL_OPTION_LENGTH + 1)] })).toBeNull();
  });

  it("counts only non-blank options toward the limit", () => {
    const options = [...Array(MAX_POLL_OPTIONS).fill("x"), "  "];
    expect(parsePollCreate({ ...ok, options })?.options).toHaveLength(MAX_POLL_OPTIONS);
  });

  it("rejects an oversized question", () => {
    expect(parsePollCreate({ ...ok, question: "q".repeat(MAX_POLL_QUESTION_LENGTH + 1) })).toBeNull();
  });
});

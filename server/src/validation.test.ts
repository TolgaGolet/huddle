import { describe, it, expect } from "vitest";
import {
  MAX_CHAT_TEXT_LENGTH,
  MAX_IMAGES_PER_MESSAGE,
  MAX_NAME_LENGTH,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  MAX_POLL_OPTION_LENGTH,
  MAX_POLL_OPTIONS,
  MAX_POLL_QUESTION_LENGTH,
  MAX_WATCH_QUEUE,
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
  parsePollSubmit,
  parsePollVote,
  parseRelay,
  parseRelayTarget,
  parseAdmitWaiting,
  parseChangePassword,
  parseKick,
  parseRoomPermissions,
  parseSetOwner,
  parseWatchChangeVideo,
  parseWatchEntry,
  parseWatchJoin,
  parseWatchQueueMove,
  parseWatchPlayback,
  parseWatchStart,
} from "./validation.js";

// Non-object payloads every parser must reject. These used to crash the
// server via destructuring or string methods on the wrong type (CQ-01).
const junk: unknown[] = [undefined, null, 5, "x", true, [], [1, 2]];

describe.each([
  ["parseJoinRoom", parseJoinRoom],
  ["parseRelay(offer)", parseRelay("offer")],
  ["parseRelayTarget", parseRelayTarget],
  ["parseMute", parseMute],
  ["parseChatMessage", parseChatMessage],
  ["parseChatReaction", parseChatReaction],
  ["parseChatEdit", parseChatEdit],
  ["parseMessageId", parseMessageId],
  ["parsePollCreate", parsePollCreate],
  ["parsePollVote", parsePollVote],
  ["parsePollSubmit", parsePollSubmit],
  ["parseWatchStart", parseWatchStart],
  ["parseWatchJoin", parseWatchJoin],
  ["parseWatchChangeVideo", parseWatchChangeVideo],
  ["parseWatchPlayback", parseWatchPlayback],
  ["parseWatchEntry", parseWatchEntry],
  ["parseWatchQueueMove", parseWatchQueueMove],
] as const)("%s", (_name, parse) => {
  it.each(junk)("rejects %j without throwing", (raw) => {
    expect(parse(raw)).toBeNull();
  });
});

describe("parseJoinRoom", () => {
  it("accepts an optional boolean mute state, and rejects anything else", () => {
    expect(parseJoinRoom({ roomId: "abc123", name: "Ana", isMuted: true })?.isMuted).toBe(true);
    expect(parseJoinRoom({ roomId: "abc123", name: "Ana", isMuted: false })?.isMuted).toBe(false);
    expect(parseJoinRoom({ roomId: "abc123", name: "Ana" })?.isMuted).toBeUndefined();
    expect(parseJoinRoom({ roomId: "abc123", name: "Ana", isMuted: "yes" })).toBeNull();
  });

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
    // Regression: 64 KB candidates and offers could be relayed at 50 per second.
    expect(parseRelay("candidate")({ to: "s1", candidate: { candidate: "c".repeat(2100) } })).toBeNull();
    expect(parseRelay("offer")({ to: "s1", offer: { type: "offer", sdp: "v".repeat(33 * 1024) } })).toBeNull();
    expect(parseRelay("offer")({ to: "s1", offer: { type: "offer", sdp: "v".repeat(20 * 1024) } })).not.toBeNull();
  });
});

describe("parseRelayTarget", () => {
  it("requires a target id", () => {
    expect(parseRelayTarget({ to: "s1" })).toEqual({ to: "s1" });
    expect(parseRelayTarget({ to: "" })).toBeNull();
    expect(parseRelayTarget({ to: 1 })).toBeNull();
    expect(parseRelayTarget({})).toBeNull();
  });
});

describe("parseMute", () => {
  it("requires a boolean", () => {
    expect(parseMute({ isMuted: true })).toEqual({ isMuted: true });
    expect(parseMute({ isMuted: "true" })).toBeNull();
    expect(parseMute({})).toBeNull();
  });
});

describe("room settings", () => {
  it("takes only known permission values when creating a room", () => {
    expect(parseCreateRoom({ pinPermission: "owners", waitingRoom: true, extra: "x" })?.permissions).toEqual({ pinPermission: "owners", waitingRoom: true });
    expect(parseCreateRoom({ pinPermission: "nobody" })).toBeNull();
    expect(parseCreateRoom({ waitingRoom: "yes" })).toBeNull();
    expect(parseCreateRoom({ messagePermission: "owners" })?.permissions).toEqual({ messagePermission: "owners" });
    expect(parseCreateRoom({ messagePermission: "nobody" })).toBeNull();
  });

  it("rebuilds an update, so that nothing else can be assigned to the room", () => {
    expect(parseRoomPermissions({ screenSharePermission: "everyone", __proto__: { polluted: true }, password: "x" })).toEqual({ screenSharePermission: "everyone" });
    expect(parseRoomPermissions({ screenSharePermission: 5 })).toBeNull();
  });

  it("applies the new-room rule to a password change, and allows removing it", () => {
    expect(parseChangePassword({ password: " long-secret " })).toEqual({ password: "long-secret" });
    expect(parseChangePassword({ password: "" })).toEqual({ password: "" });
    expect(parseChangePassword({ password: "short" })).toBeNull();
    expect(parseChangePassword({ password: "      " })).toBeNull();
  });

  it("requires a target for owner changes and kicks", () => {
    expect(parseSetOwner({ userId: "u", isOwner: false })).toEqual({ userId: "u", isOwner: false });
    expect(parseSetOwner({ userId: "u" })).toBeNull();
    expect(parseKick({})).toBeNull();
    expect(parseAdmitWaiting({ id: "s" })).toEqual({ id: "s" });
  });
});

describe("parseCreateRoom", () => {
  it("applies the same password limit as join-room", () => {
    const pw = "p".repeat(MAX_PASSWORD_LENGTH);
    expect(parseCreateRoom({})?.password).toBeUndefined();
    expect(parseCreateRoom({ password: pw })?.password).toBe(pw);
    expect(parseJoinRoom({ roomId: "r1", name: "Ana", password: pw })).not.toBeNull();
    expect(parseCreateRoom({ password: pw + "p" })).toBeNull();
    expect(parseCreateRoom({ password: 5 })).toBeNull();
  });

  // Regression: a pasted trailing space spent a password guess on a correct password.
  it("trims passwords the same way as join-room, before the limit", () => {
    expect(parseCreateRoom({ password: " password " })?.password).toBe("password");
    expect(parseJoinRoom({ roomId: "r1", name: "Ana", password: " password " })?.password).toBe("password");

    const padded = ` ${"p".repeat(MAX_PASSWORD_LENGTH)} `;
    expect(parseCreateRoom({ password: padded })?.password).toBe(padded.trim());
  });

  // Regression: spaces created an open room with no warning, and any length was accepted.
  it("requires a minimum length for a new room's password, after trimming", () => {
    expect(parseCreateRoom({ password: "p".repeat(MIN_PASSWORD_LENGTH) })).not.toBeNull();
    expect(parseCreateRoom({ password: "p".repeat(MIN_PASSWORD_LENGTH - 1) })).toBeNull();
    expect(parseCreateRoom({ password: ` ${"p".repeat(MIN_PASSWORD_LENGTH - 1)} ` })).toBeNull();
    expect(parseCreateRoom({ password: "        " })).toBeNull();
  });

  it("still means an open room for no password or an empty one", () => {
    expect(parseCreateRoom({})?.password).toBeUndefined();
    expect(parseCreateRoom({ password: "" })?.password).toBe("");
  });

  it("doesn't apply the minimum to a join, whose answer must not depend on the guess", () => {
    expect(parseJoinRoom({ roomId: "r1", name: "Ana", password: "x" })?.password).toBe("x");
  });
});

describe("parseChatMessage", () => {
  it("trims text and keeps valid optional fields", () => {
    expect(
      parseChatMessage({
        text: " hi ",
        replyToId: "m1",
        imageUrls: ["/api/rooms/r/images/abc.png"],
      }),
    ).toEqual({
      text: "hi",
      replyToId: "m1",
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
    const hi = { text: "hi", replyToId: undefined, gifUrl: undefined, imageUrls: undefined };
    for (const extra of [
      { gifUrl: 1 },
      { gifUrl: null },
      { imageUrls: "x" },
      { imageUrls: [1] },
      { imageUrls: Array(MAX_IMAGES_PER_MESSAGE + 1).fill("/a") },
      { replyToId: 1 },
      { replyToId: "" },
      { replyToId: "a".repeat(33) },
      // The old client-built quote is not part of the protocol any more.
      { replyTo: { id: "m1", senderName: "Ana", text: "forged" } },
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
    expect(parsePollCreate(ok)).toEqual({ question: "Lunch?", options: ["Pizza", "Sushi"], allowMultiple: true, lockVotes: false });
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

  it("accepts only the offered durations and coerces lockVotes", () => {
    expect(parsePollCreate({ ...ok, durationMs: 5 * 60_000, lockVotes: true })).toMatchObject({ durationMs: 5 * 60_000, lockVotes: true });
    expect(parsePollCreate({ ...ok, lockVotes: "yes" })?.lockVotes).toBe(false);
    expect(parsePollCreate({ ...ok, durationMs: 1234 })).toBeNull();
    expect(parsePollCreate({ ...ok, durationMs: "300000" })).toBeNull();
  });
});

describe("parsePollSubmit", () => {
  it("takes 1..MAX_POLL_OPTIONS distinct ids", () => {
    expect(parsePollSubmit({ pollId: "p", optionIds: ["a", "b"] })).toEqual({ pollId: "p", optionIds: ["a", "b"] });
    expect(parsePollSubmit({ pollId: "p", optionIds: [] })).toBeNull();
    expect(parsePollSubmit({ pollId: "p", optionIds: ["a", "a"] })).toBeNull();
    expect(parsePollSubmit({ pollId: "p", optionIds: ["a", 1] })).toBeNull();
    expect(parsePollSubmit({ pollId: "p", optionIds: Array.from({ length: MAX_POLL_OPTIONS + 1 }, (_, i) => `o${i}`) })).toBeNull();
  });
});

describe("watch party parsers", () => {
  it("accept only a YouTube video id, never a link or other text", () => {
    expect(parseWatchStart({ videoId: "dQw4w9WgXcQ", allowOthersToChange: true })).toEqual({ videoId: "dQw4w9WgXcQ", allowOthersToChange: true });
    expect(parseWatchStart({ videoId: "dQw4w9WgXcQ" })).toEqual({ videoId: "dQw4w9WgXcQ", allowOthersToChange: false });
    expect(parseWatchStart({ videoId: "https://youtu.be/dQw4w9WgXcQ" })).toBeNull();
    expect(parseWatchChangeVideo({ videoId: "short" })).toBeNull();
    expect(parseWatchChangeVideo({ videoId: "dQw4w9WgXc<" })).toBeNull();
    expect(parseWatchJoin({ partyId: "abc" })).toEqual({ partyId: "abc" });
  });

  it("accept playback with a known state and rate, clamping the position", () => {
    const entryId = "e1";
    expect(parseWatchPlayback({ entryId, state: "playing", position: 12.5, rate: 1.5 })).toEqual({ entryId, state: "playing", position: 12.5, rate: 1.5 });
    expect(parseWatchPlayback({ entryId, state: "paused", position: -3, rate: 1 })?.position).toBe(0);
    expect(parseWatchPlayback({ entryId, state: "paused", position: 1e12, rate: 1 })?.position).toBe(24 * 60 * 60);
    expect(parseWatchPlayback({ entryId, state: "stopped", position: 0, rate: 1 })).toBeNull();
    expect(parseWatchPlayback({ entryId, state: "paused", position: Number.NaN, rate: 1 })).toBeNull();
    expect(parseWatchPlayback({ entryId, state: "paused", position: 0, rate: 16 })).toBeNull();
    expect(parseWatchPlayback({ state: "paused", position: 0, rate: 1 })).toBeNull();
    expect(parseWatchPlayback({ entryId: 42, state: "paused", position: 0, rate: 1 })).toBeNull();
  });

  it("accept a queue move only to a whole index inside the queue's limit", () => {
    expect(parseWatchQueueMove({ entryId: "e1", toIndex: 0 })).toEqual({ entryId: "e1", toIndex: 0 });
    expect(parseWatchQueueMove({ entryId: "e1", toIndex: MAX_WATCH_QUEUE - 1 })).toEqual({ entryId: "e1", toIndex: MAX_WATCH_QUEUE - 1 });
    expect(parseWatchQueueMove({ entryId: "e1", toIndex: MAX_WATCH_QUEUE })).toBeNull();
    expect(parseWatchQueueMove({ entryId: "e1", toIndex: -1 })).toBeNull();
    expect(parseWatchQueueMove({ entryId: "e1", toIndex: 1.5 })).toBeNull();
    expect(parseWatchQueueMove({ toIndex: 0 })).toBeNull();
    expect(parseWatchEntry({ entryId: "e1" })).toEqual({ entryId: "e1" });
  });
});

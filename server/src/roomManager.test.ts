import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { MAX_PARTICIPANTS, MAX_ROOMS, MAX_ROOMS_PER_IP } from "./limits.js";
import {
  addChatMessage,
  addParticipant,
  createRoom,
  emptyReactions,
  findEntry,
  getParticipantsArray,
  getRoom,
  httpTokenFor,
  isNameTaken,
  isRoomFull,
  onMessageRemoved,
  onRoomDestroyed,
  purgeExpiredRooms,
  removeMessage,
  removeParticipant,
  resolveParticipant,
  resolveParticipantByHttpToken,
  ROOM_GRACE_MS,
  roomCount,
  roomCountForIp,
  setMuted,
  totalImageBytes,
  verifyPassword,
} from "./roomManager.js";
import { createRoomRouter } from "./roomRouter.js";

describe("server-wide limits", () => {
  it("sums image bytes across rooms", () => {
    const before = totalImageBytes();
    const a = createRoom();
    const b = createRoom();
    a.imageBytes = 100;
    b.imageBytes = 23;

    expect(totalImageBytes()).toBe(before + 123);
    a.imageBytes = 0;
    b.imageBytes = 0;
  });

  it("refuses new rooms at the cap, until expired ones can be purged", async () => {
    const app = express();
    app.use(express.json());
    app.use("/api", createRoomRouter());
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const url = `http://localhost:${(server.address() as AddressInfo).port}/api/rooms`;
    const post = () => fetch(url, { method: "POST" });

    while (roomCount() < MAX_ROOMS) createRoom();
    try {
      const full = await post();
      expect(full.status).toBe(503);
      expect((await full.json()).error).toMatch(/full/);

      const now = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(now + ROOM_GRACE_MS + 1);
      try {
        expect((await post()).status).toBe(200);
      } finally {
        clock.mockRestore();
      }
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  // Regression: one IP could fill MAX_ROOMS and lock everyone else out for good.
  it("caps the live rooms one IP can create, leaving others unaffected", async () => {
    const app = express();
    app.use(express.json());
    app.use("/api", createRoomRouter(1));
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const url = `http://localhost:${(server.address() as AddressInfo).port}/api/rooms`;
    const post = (ip: string) => fetch(url, { method: "POST", headers: { "X-Forwarded-For": ip } });

    try {
      for (let i = 0; i < MAX_ROOMS_PER_IP; i++) expect((await post("203.0.113.1")).status).toBe(200);
      expect((await post("203.0.113.1")).status).toBe(429);
      expect((await post("203.0.113.2")).status).toBe(200);

      const now = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(now + ROOM_GRACE_MS + 1);
      try {
        expect((await post("203.0.113.1")).status).toBe(200);
      } finally {
        clock.mockRestore();
      }
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe("removeMessage", () => {
  const message = (id: string) => ({
    id,
    senderId: "u",
    senderName: "Ana",
    text: "hi",
    timestamp: 0,
    reactions: emptyReactions(),
  });
  const listener = vi.fn();
  let unsubscribe: () => void;

  beforeEach(() => {
    listener.mockClear();
    unsubscribe = onMessageRemoved(listener);
  });

  afterEach(() => unsubscribe());

  it("removes the message, clears its pin and notifies listeners", () => {
    const room = createRoom();
    addChatMessage(room, message("a"));
    room.pinnedMessageId = "a";

    removeMessage(room, "a");

    expect(room.chatHistory).toEqual([]);
    expect(room.pinnedMessageId).toBeNull();
    expect(listener).toHaveBeenCalledWith(room, expect.objectContaining({ id: "a" }));
  });

  it("does the same for a message pushed out by the history cap", () => {
    const room = createRoom();
    for (let i = 0; i < 200; i++) addChatMessage(room, message(`m${i}`));
    room.pinnedMessageId = "m0";

    addChatMessage(room, message("newest"));

    expect(room.chatHistory).toHaveLength(200);
    expect(room.pinnedMessageId).toBeNull();
    expect(listener).toHaveBeenCalledWith(room, expect.objectContaining({ id: "m0" }));
  });
});

describe("room destruction", () => {
  const listener = vi.fn();
  let unsubscribe: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    listener.mockClear();
    unsubscribe = onRoomDestroyed(listener);
  });

  afterEach(() => {
    unsubscribe();
    vi.useRealTimers();
  });

  function abandonedRoom(): string {
    const room = createRoom();
    addParticipant(room, "s1", "Ana");
    removeParticipant(room.id, "s1");
    return room.id;
  }

  // Regression: the lazy purge in getRoom() deleted the room without any
  // cleanup, so the sweep never saw it and its uploaded images were orphaned.
  it("notifies listeners when getRoom() lazily purges an expired room", () => {
    const id = abandonedRoom();
    vi.advanceTimersByTime(ROOM_GRACE_MS + 1);
    expect(getRoom(id)).toBeUndefined();
    expect(listener).toHaveBeenCalledWith(id);
  });

  it("notifies listeners when the sweep purges an expired room", () => {
    const id = abandonedRoom();
    vi.advanceTimersByTime(ROOM_GRACE_MS + 1);
    purgeExpiredRooms();
    expect(listener.mock.calls.filter(([r]) => r === id)).toHaveLength(1);
    expect(getRoom(id)).toBeUndefined();
  });

  // Regression: rooms started with emptySince = null, so a room nobody ever
  // joined was never purged and stayed in memory forever.
  it("purges a room that was created but never joined", () => {
    const { id } = createRoom();
    vi.advanceTimersByTime(ROOM_GRACE_MS + 1);
    purgeExpiredRooms();
    expect(getRoom(id)).toBeUndefined();
    expect(listener).toHaveBeenCalledWith(id);
  });

  it("keeps a never-joined room within its grace period", () => {
    const { id } = createRoom();
    vi.advanceTimersByTime(ROOM_GRACE_MS - 1);
    expect(getRoom(id)).toBeDefined();
  });

  it("keeps an empty room within its grace period", () => {
    const id = abandonedRoom();
    vi.advanceTimersByTime(ROOM_GRACE_MS - 1);
    purgeExpiredRooms();
    expect(getRoom(id)).toBeDefined();
    expect(listener).not.toHaveBeenCalledWith(id);
  });
});

describe("participant membership", () => {
  it("keeps the socket -> room index in step with add/removeParticipant", () => {
    const room = createRoom();
    addParticipant(room, "s1", "Ana");
    expect(resolveParticipant("s1")?.roomId).toBe(room.id);

    removeParticipant(room.id, "s1");
    expect(resolveParticipant("s1")).toBeNull();
  });
});

describe("emptyReactions", () => {
  // Emoji keys are client-supplied. On a plain `{}`, "constructor" read back
  // Object and crashed the reaction handler, and "__proto__" replaced the
  // object's prototype (F-01 / CQ-01).
  it.each(["constructor", "__proto__", "toString", "hasOwnProperty"])(
    "treats %s as an ordinary key",
    (emoji) => {
      const reactions = emptyReactions();
      expect(reactions[emoji]).toBeUndefined();

      const users = [{ userId: "u1", name: "Ana" }];
      reactions[emoji] = users;
      expect(Object.keys(reactions)).toEqual([emoji]);
      expect(JSON.parse(JSON.stringify(reactions))).toEqual({ [emoji]: users });
    },
  );
});

describe("verifyPassword", () => {
  it("lets anyone into an open room", () => {
    expect(verifyPassword(createRoom())).toBe(true);
    expect(verifyPassword(createRoom(), "anything")).toBe(true);
  });

  it("requires the exact password otherwise", () => {
    const room = createRoom("secret");

    expect(verifyPassword(room, "secret")).toBe(true);
    expect(verifyPassword(room, "Secret")).toBe(false);
    expect(verifyPassword(room, "")).toBe(false);
    expect(verifyPassword(room)).toBe(false);
  });
});

describe("isNameTaken", () => {
  it("ignores case", () => {
    const room = createRoom();
    addParticipant(room, "name-1", "Ana");

    expect(isNameTaken(room, "ANA", [])).toBe(true);
    expect(isNameTaken(room, "Bo", [])).toBe(false);
  });

  it("frees the name of someone about to be evicted", () => {
    const room = createRoom();
    const ana = addParticipant(room, "name-2", "Ana");

    expect(isNameTaken(room, "Ana", [ana])).toBe(false);
  });
});

describe("isRoomFull", () => {
  const fill = () => {
    const room = createRoom();
    return { room, people: Array.from({ length: MAX_PARTICIPANTS }, (_, i) => addParticipant(room, `full-${room.id}-${i}`, `P${i}`)) };
  };

  it("is full only at the cap", () => {
    const { room, people } = fill();
    expect(isRoomFull(room, [])).toBe(true);

    removeParticipant(room.id, people[0].id);
    expect(isRoomFull(room, [])).toBe(false);
  });

  it("doesn't count someone about to be evicted", () => {
    const { room, people } = fill();

    expect(isRoomFull(room, [people[0]])).toBe(false);
  });
});

describe("participant state", () => {
  it("defaults the identity to the socket and to unmuted", () => {
    const room = createRoom();

    expect(addParticipant(room, "state-1", "Ana")).toEqual({ id: "state-1", userId: "state-1", name: "Ana", isMuted: false });
  });

  it("carries the announced mute state and later changes", () => {
    const room = createRoom();
    addParticipant(room, "state-2", "Ana", "user-2", true);
    expect(getParticipantsArray(room)[0].isMuted).toBe(true);

    setMuted(room, "state-2", false);

    expect(getParticipantsArray(room)[0].isMuted).toBe(false);
  });

  it("ignores a mute change for someone not in the room", () => {
    const room = createRoom();

    expect(() => setMuted(room, "ghost", true)).not.toThrow();
  });

  it("clears the empty timer when someone joins", () => {
    const room = createRoom();
    addParticipant(room, "state-3", "Ana");

    expect(room.emptySince).toBeNull();
  });

  it("ignores removal from a room that no longer exists", () => {
    expect(() => removeParticipant("no-such-room", "ghost")).not.toThrow();
  });

  it("counts rooms by creator IP only", () => {
    const ip = "198.51.100.77";
    createRoom(undefined, ip);
    createRoom(undefined, ip);
    createRoom(undefined, "198.51.100.78");

    expect(roomCountForIp(ip)).toBe(2);
  });

  it("finds a chat entry by id", () => {
    const room = createRoom();
    const entry = { id: "m1", senderId: "u", senderName: "Ana", text: "hi", timestamp: 0, reactions: emptyReactions() };
    addChatMessage(room, entry);

    expect(findEntry(room, "m1")).toBe(entry);
    expect(findEntry(room, "m2")).toBeUndefined();
  });
});

describe("HTTP tokens", () => {
  it("resolves the token to its owner", () => {
    const room = createRoom();
    const ana = addParticipant(room, "token-1", "Ana");

    const ctx = resolveParticipantByHttpToken(httpTokenFor("token-1")!);

    expect(ctx?.room).toBe(room);
    expect(ctx?.participant).toBe(ana);
  });

  it("gives every membership its own token", () => {
    const room = createRoom();
    addParticipant(room, "token-2", "Ana");
    addParticipant(room, "token-3", "Bo");

    expect(httpTokenFor("token-2")).not.toBe(httpTokenFor("token-3"));
  });

  it("isn't on the participant, which is broadcast to the room", () => {
    const room = createRoom();
    const ana = addParticipant(room, "token-4", "Ana");

    expect(JSON.stringify(ana)).not.toContain(httpTokenFor("token-4")!);
  });

  it("ends with the membership", () => {
    const room = createRoom();
    addParticipant(room, "token-5", "Ana");
    const token = httpTokenFor("token-5")!;

    removeParticipant(room.id, "token-5");

    expect(httpTokenFor("token-5")).toBeUndefined();
    expect(resolveParticipantByHttpToken(token)).toBeNull();
  });

  it("replaces the old token when the same socket joins again", () => {
    const room = createRoom();
    addParticipant(room, "token-6", "Ana");
    const first = httpTokenFor("token-6")!;

    addParticipant(room, "token-6", "Ana");

    expect(resolveParticipantByHttpToken(first)).toBeNull();
    expect(resolveParticipantByHttpToken(httpTokenFor("token-6")!)).not.toBeNull();
  });

  it("rejects an unknown token", () => {
    expect(resolveParticipantByHttpToken("made-up")).toBeNull();
  });
});

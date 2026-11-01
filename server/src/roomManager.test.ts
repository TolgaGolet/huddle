import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  addChatMessage,
  addParticipant,
  createRoom,
  emptyReactions,
  getRoom,
  onMessageRemoved,
  onRoomDestroyed,
  purgeExpiredRooms,
  removeMessage,
  removeParticipant,
  resolveParticipant,
  ROOM_GRACE_MS,
} from "./roomManager.js";

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
    addChatMessage(room.id, message("a"));
    room.pinnedMessageId = "a";

    removeMessage(room.id, "a");

    expect(room.chatHistory).toEqual([]);
    expect(room.pinnedMessageId).toBeNull();
    expect(listener).toHaveBeenCalledWith(room, expect.objectContaining({ id: "a" }));
  });

  it("does the same for a message pushed out by the history cap", () => {
    const room = createRoom();
    for (let i = 0; i < 200; i++) addChatMessage(room.id, message(`m${i}`));
    room.pinnedMessageId = "m0";

    addChatMessage(room.id, message("newest"));

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
    addParticipant(room.id, "s1", "Ana");
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
    addParticipant(room.id, "s1", "Ana");
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

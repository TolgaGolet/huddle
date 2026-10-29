import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  addParticipant,
  createRoom,
  emptyReactions,
  getRoom,
  onRoomDestroyed,
  purgeExpiredRooms,
  removeParticipant,
  resolveParticipant,
  ROOM_GRACE_MS,
} from "./roomManager.js";

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

      reactions[emoji] = ["Ana"];
      expect(Object.keys(reactions)).toEqual([emoji]);
      expect(JSON.parse(JSON.stringify(reactions))).toEqual({ [emoji]: ["Ana"] });
    },
  );
});

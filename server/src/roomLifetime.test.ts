import { afterEach, describe, expect, it, vi } from "vitest";
import { INACTIVE_WARNING_MS, LIFETIME_WARNING_MS, MAX_ROOM_LIFETIME_MS, ROOM_INACTIVE_MS } from "./limits.js";
import { closingStatus, roomClosingNotice, sweepRoomLifetimes } from "./roomLifetime.js";
import { addParticipant, createRoom, getRoom, httpTokenFor, onRoomDestroyed, resolveParticipant, resolveParticipantByHttpToken, socketRoomMap, touchRoom } from "./roomManager.js";
import type { AppServer } from "./socketRoute.js";

function fakeIo() {
  const sent: { room: string; event: string; payload: unknown }[] = [];
  const disconnected: string[] = [];
  const io = {
    to: (rooms: string | string[]) => ({
      emit: (event: string, payload: unknown) => [rooms].flat().forEach((room) => sent.push({ room, event, payload })),
    }),
    in: (rooms: string | string[]) => ({ disconnectSockets: () => disconnected.push(...[rooms].flat()) }),
  };
  return { io: io as unknown as AppServer, sent, disconnected };
}

function occupiedRoom() {
  const room = createRoom();
  addParticipant(room, `socket-${room.id}`, "Ana");
  return room;
}

afterEach(() => socketRoomMap.clear());

describe("closingStatus", () => {
  it("is quiet until the inactivity warning, 10 minutes before closing at 31 minutes", () => {
    expect(ROOM_INACTIVE_MS).toBe(31 * 60_000);
    expect(INACTIVE_WARNING_MS).toBe(10 * 60_000);
    const room = createRoom();
    const start = room.lastActivityAt;

    expect(closingStatus(room, start + 21 * 60_000 - 1)).toBeNull();
    expect(closingStatus(room, start + 21 * 60_000)).toEqual({ reason: "inactive", closesAt: start + ROOM_INACTIVE_MS });
  });

  it("warns 30 minutes before the 10-hour limit, whatever the activity", () => {
    expect(MAX_ROOM_LIFETIME_MS).toBe(10 * 3_600_000);
    const room = createRoom();
    const warnsAt = room.createdAt + MAX_ROOM_LIFETIME_MS - LIFETIME_WARNING_MS;

    touchRoom(room, warnsAt - 1);
    expect(closingStatus(room, warnsAt - 1)).toBeNull();
    touchRoom(room, warnsAt);
    expect(closingStatus(room, warnsAt)).toEqual({ reason: "lifetime", closesAt: room.createdAt + MAX_ROOM_LIFETIME_MS });
  });

  it("reports whichever closing comes first when both are due", () => {
    const room = createRoom();
    const warnsAt = room.createdAt + MAX_ROOM_LIFETIME_MS - LIFETIME_WARNING_MS;
    room.lastActivityAt = warnsAt - 25 * 60_000; // inactivity closes in 6 minutes, the limit in 30

    expect(closingStatus(room, warnsAt)?.reason).toBe("inactive");
  });

  it("gives clients a remaining time, never a negative one", () => {
    const room = createRoom();
    const now = room.lastActivityAt + 25 * 60_000;

    expect(roomClosingNotice(room, now)).toEqual({ reason: "inactive", remainingMs: 6 * 60_000 });
    expect(roomClosingNotice(room, room.lastActivityAt + ROOM_INACTIVE_MS + 1)?.remainingMs).toBe(0);
  });
});

describe("sweepRoomLifetimes", () => {
  it("warns once, and cancels the warning when there is activity", () => {
    const room = occupiedRoom();
    const { io, sent } = fakeIo();
    const warnsAt = room.lastActivityAt + 21 * 60_000;

    sweepRoomLifetimes(io, warnsAt);
    sweepRoomLifetimes(io, warnsAt + 10_000);
    const warnings = sent.filter((s) => s.room === room.id);
    expect(warnings).toEqual([{ room: room.id, event: "room-closing", payload: { reason: "inactive", remainingMs: 10 * 60_000 } }]);

    touchRoom(room, warnsAt + 20_000);
    sweepRoomLifetimes(io, warnsAt + 20_000);
    expect(sent.filter((s) => s.room === room.id).at(-1)).toEqual({ room: room.id, event: "room-closing", payload: null });
  });

  it("tells members why, then ends the room and everything attached to it", () => {
    const room = occupiedRoom();
    const socketId = `socket-${room.id}`;
    const token = httpTokenFor(socketId)!;
    const destroyed = vi.fn();
    const unsubscribe = onRoomDestroyed(destroyed);
    const { io, sent, disconnected } = fakeIo();

    sweepRoomLifetimes(io, room.lastActivityAt + ROOM_INACTIVE_MS);
    unsubscribe();

    expect(sent).toContainEqual({ room: room.id, event: "room-closed", payload: { reason: "inactive" } });
    expect(disconnected).toContain(room.id);
    expect(getRoom(room.id)).toBeUndefined();
    expect(destroyed).toHaveBeenCalledWith(room.id);
    expect(socketRoomMap.has(socketId)).toBe(false);
    expect(resolveParticipant(socketId)).toBeNull();
    expect(resolveParticipantByHttpToken(token)).toBeNull();
  });

  it("closes an active room at the 10-hour limit", () => {
    const room = occupiedRoom();
    const closesAt = room.createdAt + MAX_ROOM_LIFETIME_MS;
    touchRoom(room, closesAt);
    const { io, sent } = fakeIo();

    sweepRoomLifetimes(io, closesAt);

    expect(sent).toContainEqual({ room: room.id, event: "room-closed", payload: { reason: "lifetime" } });
  });

  it("counts a screen share in progress as activity", () => {
    const room = occupiedRoom();
    room.screenSharerId = `socket-${room.id}`;
    const { io, sent } = fakeIo();

    sweepRoomLifetimes(io, room.lastActivityAt + ROOM_INACTIVE_MS);

    expect(sent.filter((s) => s.room === room.id)).toEqual([]);
    expect(getRoom(room.id)).toBe(room);
  });

  it("counts a watch party playing for someone as activity, but not a paused one", () => {
    const room = occupiedRoom();
    room.watchParty = {
      id: "party",
      hostId: "u",
      allowOthersToChange: false,
      videoId: "dQw4w9WgXcQ",
      members: new Map([[`socket-${room.id}`, "u"]]),
      playback: { state: "playing", position: 0, rate: 1 },
      updatedAt: Date.now(),
    };
    const { io } = fakeIo();

    sweepRoomLifetimes(io, room.lastActivityAt + ROOM_INACTIVE_MS);
    expect(getRoom(room.id)).toBe(room);

    room.watchParty.playback.state = "paused";
    sweepRoomLifetimes(io, room.lastActivityAt + ROOM_INACTIVE_MS);
    expect(getRoom(room.id)).toBeUndefined();
  });

  it("leaves an empty room to its own grace period", () => {
    const room = createRoom();
    const { io, sent } = fakeIo();

    sweepRoomLifetimes(io, room.lastActivityAt + 21 * 60_000);

    expect(sent.filter((s) => s.room === room.id)).toEqual([]);
  });
});

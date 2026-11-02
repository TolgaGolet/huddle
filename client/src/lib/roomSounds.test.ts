import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSocket } from "../types";
import { playJoinSound, playLeaveSound, playMessageSound } from "./notificationSounds";
import { subscribeRoomSounds } from "./roomSounds";

vi.mock("./notificationSounds", () => ({
  playJoinSound: vi.fn(),
  playLeaveSound: vi.fn(),
  playMessageSound: vi.fn(),
}));

function fakeSocket() {
  const handlers = new Map<string, (data: unknown) => void>();
  return {
    socket: {
      on: (event: string, handler: (data: unknown) => void) => handlers.set(event, handler),
    } as unknown as Pick<AppSocket, "on">,
    emit: (event: string, data?: unknown) => handlers.get(event)?.(data),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("subscribeRoomSounds", () => {
  it("plays a cue when someone new is waiting, not when they go", () => {
    const { socket, emit } = fakeSocket();
    subscribeRoomSounds(socket, () => "me");
    const person = { id: "s", name: "Bo", wasRemoved: false };

    emit("waiting-list", [person]);
    expect(playMessageSound).toHaveBeenCalledOnce();

    emit("waiting-list", []);
    expect(playMessageSound).toHaveBeenCalledOnce();
  });

  it("plays a cue when a closing warning starts, not when it is cancelled", () => {
    const { socket, emit } = fakeSocket();
    subscribeRoomSounds(socket, () => "me");

    emit("room-closing", null);
    expect(playMessageSound).not.toHaveBeenCalled();

    emit("room-closing", { reason: "inactive", remainingMs: 1000 });
    expect(playMessageSound).toHaveBeenCalledOnce();
  });

  it("plays a cue for other people's messages but not our own", () => {
    const { socket, emit } = fakeSocket();
    subscribeRoomSounds(socket, () => "me");

    emit("chat-message", { senderId: "me" });
    expect(playMessageSound).not.toHaveBeenCalled();

    emit("chat-message", { senderId: "them" });
    expect(playMessageSound).toHaveBeenCalledOnce();
  });

  it("plays join and leave cues", () => {
    const { socket, emit } = fakeSocket();
    subscribeRoomSounds(socket, () => "me");

    emit("participant-joined");
    emit("participant-left");

    expect(playJoinSound).toHaveBeenCalledOnce();
    expect(playLeaveSound).toHaveBeenCalledOnce();
  });
});

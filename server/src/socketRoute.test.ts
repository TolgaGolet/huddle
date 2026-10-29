import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Socket } from "socket.io";
import { on, onRelay, onRoom } from "./socketRoute.js";
import { isRoomImageUrl } from "./imageRouter.js";
import { addParticipant, createRoom, socketRoomMap } from "./roomManager.js";
import { parseMute } from "./validation.js";

/** Minimal stand-in for a Socket.IO socket: records listeners so tests can fire them. */
function fakeSocket(id: string) {
  const listeners = new Map<string, (raw: unknown) => void>();
  const sent: { to: string; event: string; payload: unknown }[] = [];
  const socket = {
    id,
    on(event: string, fn: (raw: unknown) => void) {
      listeners.set(event, fn);
      return socket;
    },
    to(target: string) {
      return { emit: (event: string, payload: unknown) => sent.push({ to: target, event, payload }) };
    },
  };
  const fire = (event: string, raw?: unknown) => listeners.get(event)?.(raw);
  return { socket: socket as unknown as Socket, fire, sent };
}

describe("on", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => errorSpy.mockRestore());

  it("never calls the handler with a payload the parser rejects", () => {
    const { socket, fire } = fakeSocket("s1");
    const handler = vi.fn();
    on(socket, "mute-toggle", parseMute, handler);

    // `socket.emit("mute-toggle")` with no payload used to crash the server.
    fire("mute-toggle");
    fire("mute-toggle", { isMuted: "yes" });
    expect(handler).not.toHaveBeenCalled();

    fire("mute-toggle", { isMuted: true });
    expect(handler).toHaveBeenCalledWith({ isMuted: true });
  });

  it("catches a throwing handler and never logs the error message", () => {
    const { socket, fire } = fakeSocket("s1");
    on(socket, "boom", (raw) => raw, () => {
      throw new TypeError("secret payload text");
    });

    expect(() => fire("boom", { text: "private" })).not.toThrow();
    expect(errorSpy).toHaveBeenCalledWith("[socket] handler error", expect.objectContaining({
      event: "boom",
      name: "TypeError",
    }));
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("secret");
  });

  it("catches a throwing parser", () => {
    const { socket, fire } = fakeSocket("s1");
    const handler = vi.fn();
    on(socket, "x", () => {
      throw new Error("bad parser");
    }, handler);

    expect(() => fire("x", {})).not.toThrow();
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("on with onInvalid", () => {
  it("calls onInvalid instead of the handler for a rejected payload", () => {
    const { socket, fire } = fakeSocket("s1");
    const handler = vi.fn();
    const onInvalid = vi.fn();
    on(socket, "mute-toggle", parseMute, handler, onInvalid);

    fire("mute-toggle", "junk");
    expect(onInvalid).toHaveBeenCalledOnce();
    expect(handler).not.toHaveBeenCalled();

    fire("mute-toggle", { isMuted: true });
    expect(onInvalid).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledOnce();
  });
});

describe("onRoom", () => {
  afterEach(() => socketRoomMap.clear());

  it("drops events from a socket that has not joined a room", () => {
    const { socket, fire } = fakeSocket("lonely");
    const handler = vi.fn();
    onRoom(socket, "mute-toggle", parseMute, handler);

    fire("mute-toggle", { isMuted: true });
    expect(handler).not.toHaveBeenCalled();
  });

  it("passes the resolved room and participant to the handler", () => {
    const room = createRoom();
    addParticipant(room.id, "s1", "Ana");

    const { socket, fire } = fakeSocket("s1");
    const handler = vi.fn();
    onRoom(socket, "mute-toggle", parseMute, handler);

    fire("mute-toggle", { isMuted: false });
    expect(handler).toHaveBeenCalledWith(
      { roomId: room.id, room, participant: expect.objectContaining({ id: "s1", name: "Ana" }) },
      { isMuted: false },
    );
  });
});

describe("onRelay", () => {
  afterEach(() => socketRoomMap.clear());

  it("forwards to a peer in the same room under the original key", () => {
    socketRoomMap.set("a", "r1").set("b", "r1");
    const { socket, fire, sent } = fakeSocket("a");
    onRelay(socket, "ice-candidate", "candidate");

    fire("ice-candidate", { to: "b", candidate: null });
    expect(sent).toEqual([{ to: "b", event: "ice-candidate", payload: { from: "a", candidate: null } }]);
  });

  it("drops relays to itself, to another room, or from a socket not in a room", () => {
    socketRoomMap.set("a", "r1").set("c", "r2");
    const { socket, fire, sent } = fakeSocket("a");
    onRelay(socket, "offer", "offer");
    fire("offer", { to: "a", offer: {} });
    fire("offer", { to: "c", offer: {} });

    const lonely = fakeSocket("z");
    onRelay(lonely.socket, "offer", "offer");
    lonely.fire("offer", { to: "a", offer: {} });

    expect(sent).toEqual([]);
    expect(lonely.sent).toEqual([]);
  });
});

describe("isRoomImageUrl", () => {
  it("accepts only uploaded-image paths of the given room", () => {
    expect(isRoomImageUrl("r1", "/api/rooms/r1/images/abcdefghij.png")).toBe(true);
    expect(isRoomImageUrl("r1", "/api/rooms/r2/images/abcdefghij.png")).toBe(false);
    expect(isRoomImageUrl("r1", "/api/rooms/r1/images/abcdefghij.exe")).toBe(false);
    expect(isRoomImageUrl("r1", "/api/rooms/r1/images/../x/abcdefghij.png")).toBe(false);
  });
});

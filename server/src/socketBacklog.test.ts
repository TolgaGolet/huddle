import { describe, it, expect, vi } from "vitest";
import { evictBacklogged, isBacklogged } from "./socketBacklog.js";
import type { AppServer, AppSocket } from "./socketRoute.js";

function fakeSocket(packets: number, bytes: number) {
  const destroy = vi.fn();
  const socket = { conn: { writeBuffer: new Array(packets), request: { socket: { writableLength: bytes, destroy } } } };
  return { socket: socket as unknown as AppSocket, destroy };
}

describe("isBacklogged", () => {
  it("is false for a client keeping up, even mid-burst", () => {
    expect(isBacklogged(fakeSocket(256, 1024 * 1024).socket)).toBe(false);
  });

  it("is true past the limit on queued packets or on buffered bytes", () => {
    expect(isBacklogged(fakeSocket(257, 0).socket)).toBe(true);
    expect(isBacklogged(fakeSocket(0, 1024 * 1024 + 1).socket)).toBe(true);
  });
});

describe("evictBacklogged", () => {
  it("destroys only the connections that have stopped reading", () => {
    const stuck = fakeSocket(1000, 0);
    const fine = fakeSocket(1, 100);
    const io = { sockets: { sockets: new Map([["stuck", stuck.socket], ["fine", fine.socket]]) } };

    evictBacklogged(io as unknown as AppServer);

    expect(stuck.destroy).toHaveBeenCalledOnce();
    expect(fine.destroy).not.toHaveBeenCalled();
  });
});

import { describe, it, expect } from "vitest";
import { reserveRoomImageBytes } from "./imageQuota.js";
import type { Room } from "./roomManager.js";

const room = () => ({ imageBytes: 100 }) as Room;

describe("reserveRoomImageBytes", () => {
  it("counts the bytes as soon as they are reserved", () => {
    const r = room();
    reserveRoomImageBytes(r, 50);
    expect(r.imageBytes).toBe(150);
  });

  it("gives back everything when nothing was stored", async () => {
    const r = room();
    await reserveRoomImageBytes(r, 50).release();
    expect(r.imageBytes).toBe(100);
  });

  it("keeps only the committed bytes", async () => {
    const r = room();
    const reservation = reserveRoomImageBytes(r, 50);
    reservation.commit(20);
    await reservation.release();
    expect(r.imageBytes).toBe(120);
  });

  it("waits for a running store, whose commits would otherwise leak", async () => {
    const r = room();
    const reservation = reserveRoomImageBytes(r, 50);
    let finishStore!: () => void;
    reservation.trackStore(new Promise((resolve) => { finishStore = resolve; }));

    const releasing = reservation.release();
    await Promise.resolve();
    expect(r.imageBytes).toBe(150);

    reservation.commit(30);
    finishStore();
    await releasing;
    expect(r.imageBytes).toBe(130);
  });
});

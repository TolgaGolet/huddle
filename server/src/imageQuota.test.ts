import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import type { Response } from "express";
import { holdImageMemory, imageMemoryFits, reserveRoomImageBytes, tryReserveClientImageBytes } from "./imageQuota.js";
import { MAX_CLIENT_INFLIGHT_IMAGE_BYTES, MAX_INFLIGHT_IMAGE_BYTES } from "./limits.js";
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

const fakeResponse = () => Object.assign(new EventEmitter(), { closed: false }) as unknown as Response;

describe("holdImageMemory", () => {
  it("takes only what fits, and gives it all back when the response closes", () => {
    const res = fakeResponse();
    const hold = holdImageMemory(res);

    expect(hold.take(MAX_INFLIGHT_IMAGE_BYTES - 10)).toBe(true);
    expect(hold.take(5)).toBe(true);
    expect(hold.take(6)).toBe(false);
    expect(imageMemoryFits(6)).toBe(false);

    res.emit("close");
    expect(imageMemoryFits(MAX_INFLIGHT_IMAGE_BYTES)).toBe(true);
  });

  it("refuses bytes for a closed response, whose release has already run", () => {
    const res = fakeResponse();
    const hold = holdImageMemory(res);
    res.emit("close");
    (res as unknown as { closed: boolean }).closed = true;

    expect(hold.take(1)).toBe(false);
    expect(imageMemoryFits(MAX_INFLIGHT_IMAGE_BYTES)).toBe(true);
  });
});

describe("tryReserveClientImageBytes", () => {
  it("caps each client separately, until its responses close", () => {
    const res = fakeResponse();

    expect(tryReserveClientImageBytes(res, "a", MAX_CLIENT_INFLIGHT_IMAGE_BYTES)).toBe(true);
    expect(tryReserveClientImageBytes(fakeResponse(), "a", 1)).toBe(false);
    expect(tryReserveClientImageBytes(fakeResponse(), "b", 1)).toBe(true);

    res.emit("close");
    expect(tryReserveClientImageBytes(fakeResponse(), "a", 1)).toBe(true);
  });
});

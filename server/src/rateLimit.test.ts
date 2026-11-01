import { describe, it, expect } from "vitest";
import { createBucket, EVENT_LIMITS, RATE_LIMITS } from "./rateLimit.js";

function clock() {
  let t = 1000;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("createBucket", () => {
  it("allows the burst, then refuses", () => {
    const { now } = clock();
    const bucket = createBucket({ burst: 3, perSecond: 1 }, now);
    expect([bucket.take(), bucket.take(), bucket.take(), bucket.take()]).toEqual([true, true, true, false]);
  });

  it("refills over time, and never above the burst", () => {
    const { now, advance } = clock();
    const bucket = createBucket({ burst: 2, perSecond: 2 }, now);
    bucket.take();
    bucket.take();
    expect(bucket.take()).toBe(false);

    advance(500);
    expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(false);

    advance(60_000);
    expect([bucket.take(), bucket.take(), bucket.take()]).toEqual([true, true, false]);
  });

  it("does not spend tokens on a refused take", () => {
    const { now, advance } = clock();
    const bucket = createBucket({ burst: 1, perSecond: 1 }, now);
    bucket.take();
    for (let i = 0; i < 100; i++) bucket.take();
    advance(1000);
    expect(bucket.take()).toBe(true);
  });

  it("reports full only once fully refilled", () => {
    const { now, advance } = clock();
    const bucket = createBucket({ burst: 2, perSecond: 1 }, now);
    expect(bucket.isFull()).toBe(true);
    bucket.take();
    expect(bucket.isFull()).toBe(false);
    advance(1000);
    expect(bucket.isFull()).toBe(true);
  });
});

describe("limits", () => {
  it("maps every event to a group that exists", () => {
    for (const group of Object.values(EVENT_LIMITS)) expect(RATE_LIMITS[group]).toBeDefined();
  });

  it("leaves room for an ICE burst to the five peers of a full mesh", () => {
    expect(RATE_LIMITS.signaling.burst).toBeGreaterThanOrEqual(5 * 40);
  });
});

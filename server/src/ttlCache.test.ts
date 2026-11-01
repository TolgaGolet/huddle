import { describe, it, expect, vi, afterEach } from "vitest";
import { TtlCache } from "./ttlCache.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("TtlCache", () => {
  it("returns the cached value until the TTL passes", async () => {
    vi.useFakeTimers();
    const cache = new TtlCache<number>(10);
    const load = vi.fn(async () => 1);

    await cache.getOrLoad("k", 1000, load);
    vi.advanceTimersByTime(999);
    await cache.getOrLoad("k", 1000, load);
    expect(load).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    await cache.getOrLoad("k", 1000, load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("evicts the least recently used key when full", async () => {
    const cache = new TtlCache<string>(2);
    const load = vi.fn(async () => "v");

    await cache.getOrLoad("a", 1000, load);
    await cache.getOrLoad("b", 1000, load);
    await cache.getOrLoad("a", 1000, load); // "b" is now the oldest
    await cache.getOrLoad("c", 1000, load); // evicts "b"
    expect(load).toHaveBeenCalledTimes(3);

    await cache.getOrLoad("a", 1000, load);
    expect(load).toHaveBeenCalledTimes(3);
    await cache.getOrLoad("b", 1000, load);
    expect(load).toHaveBeenCalledTimes(4);
  });

  it("shares one load between concurrent callers", async () => {
    const cache = new TtlCache<number>(10);
    const load = vi.fn(async () => 1);

    const results = await Promise.all([cache.getOrLoad("k", 1000, load), cache.getOrLoad("k", 1000, load)]);
    expect(results).toEqual([1, 1]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("does not cache failures", async () => {
    const cache = new TtlCache<number>(10);
    const load = vi.fn<() => Promise<number>>()
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValueOnce(1);

    await expect(cache.getOrLoad("k", 1000, load)).rejects.toThrow("down");
    await expect(cache.getOrLoad("k", 1000, load)).resolves.toBe(1);
  });
});

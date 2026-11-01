import { describe, it, expect } from "vitest";
import { imageRetryDelay, imageRetrySrc } from "./imageRetry";

describe("imageRetryDelay", () => {
  it("backs off, then gives up", () => {
    expect([0, 1, 2, 3, 4, 5].map(imageRetryDelay)).toEqual([1000, 2000, 4000, 8000, 15000, 30000]);
    expect(imageRetryDelay(6)).toBeNull();
  });
});

describe("imageRetrySrc", () => {
  it("leaves the URL alone before any failure", () => {
    expect(imageRetrySrc("/a.png", 1, 0, null)).toBe("/a.png");
  });

  // Regression: the first failure changed the URL at once, skipping the backoff.
  it("waits for the backoff after a failure", () => {
    expect(imageRetrySrc("/a.png", 1, 0, 1)).toBe("/a.png");
    expect(imageRetrySrc("/a.png", 1, 1, 1)).toBe("/a.png?session=1&retry=1");
  });

  it("retries at once when the session reopens after a failure", () => {
    expect(imageRetrySrc("/a.png", 2, 0, 1)).toBe("/a.png?session=2&retry=0");
  });

  it("doesn't reload a working image when the session reopens", () => {
    expect(imageRetrySrc("/a.png", 2, 0, null)).toBe("/a.png");
  });

  // Regression: one transient failure made every later session renewal refetch it.
  it("doesn't reload an image that a retry brought back", () => {
    const url = "/a.png?session=1&retry=1";
    expect(imageRetrySrc("/a.png", 2, 1, 1, { src: "/a.png", url })).toBe(url);
  });
});

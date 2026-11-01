import { describe, it, expect } from "vitest";
import { MAX_IMAGE_SIZE, MAX_IMAGES_PER_MESSAGE } from "../types";
import { uploadTimeoutMs } from "./requestTimeouts";

describe("uploadTimeoutMs", () => {
  it("allows a minute plus the transfer time at 1 Mbps", () => {
    expect(uploadTimeoutMs(0)).toBe(60_000);
    expect(uploadTimeoutMs(1_250_000)).toBe(70_000);
  });

  it("gives the largest batch long enough on a slow link", () => {
    const secondsAt1Mbps = (MAX_IMAGE_SIZE * MAX_IMAGES_PER_MESSAGE * 8) / 1_000_000;
    expect(uploadTimeoutMs(MAX_IMAGE_SIZE * MAX_IMAGES_PER_MESSAGE)).toBeGreaterThan(secondsAt1Mbps * 1000);
  });
});

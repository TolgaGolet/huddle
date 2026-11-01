import { describe, it, expect } from "vitest";
import {
  closeGate,
  getThresholdDb,
  INITIAL_GATE_STATE,
  MANUAL_THRESHOLD_MAX_DB,
  MANUAL_THRESHOLD_MIN_DB,
  NOISE_FLOOR_MAX_DB,
  NOISE_FLOOR_MIN_DB,
  normalizeManualThresholdDb,
  RELEASE_MS,
  stepGate,
  stepNoiseFloor,
  type GateState,
} from "./audioLevels";

describe("manual threshold", () => {
  it("normalizes to whole dB within the slider's range", () => {
    expect(normalizeManualThresholdDb(-100)).toBe(MANUAL_THRESHOLD_MIN_DB);
    expect(normalizeManualThresholdDb(0)).toBe(MANUAL_THRESHOLD_MAX_DB);
    expect(normalizeManualThresholdDb(-30.4)).toBe(-30);
  });

  it("derives the gate limits from the threshold", () => {
    expect(getThresholdDb("manual", -30)).toEqual({ openDb: -30, closeDb: -35 });
  });
});

const LIMITS = { openDb: -36, closeDb: -41 };
const LOUD = -20;
const BETWEEN = -38; // below open, above close
const QUIET = -60;

const closed: GateState = { openSince: 0, consecutiveHigh: 0, noiseFloorDb: -70 };
const openedAt = (t: number): GateState => ({ openSince: t, consecutiveHigh: 2, noiseFloorDb: -70 });

describe("stepNoiseFloor", () => {
  it("initialises from the first sample, clamped to the floor's range", () => {
    expect(stepNoiseFloor(null, -50)).toBe(-50);
    expect(stepNoiseFloor(null, -10)).toBe(NOISE_FLOOR_MAX_DB);
  });

  it("treats digital silence as the lowest floor", () => {
    expect(stepNoiseFloor(null, -100)).toBe(NOISE_FLOOR_MIN_DB);
  });

  // Regression: -60 used to mean "uninitialised", so a real floor of exactly
  // -60 jumped straight to the next sample's level.
  it("adapts slowly from a floor of exactly -60", () => {
    expect(stepNoiseFloor(-60, -40)).toBeCloseTo(-59.6);
  });
});

describe("stepGate attack", () => {
  // Regression: the settings meter opened on one sample while the real gate
  // required two, so the meter disagreed with what peers actually heard.
  it("needs two consecutive loud samples to open", () => {
    const first = stepGate(closed, LOUD, 1000, LIMITS);
    expect(first.openSince).toBe(0);

    const second = stepGate(first, LOUD, 1025, LIMITS);
    expect(second.openSince).toBe(1025);
  });

  it("restarts the count after a quiet sample", () => {
    const first = stepGate(closed, LOUD, 1000, LIMITS);
    const quiet = stepGate(first, QUIET, 1025, LIMITS);
    const second = stepGate(quiet, LOUD, 1050, LIMITS);
    expect(second.openSince).toBe(0);
    expect(second.consecutiveHigh).toBe(1);
  });
});

describe("stepGate release", () => {
  it("holds open during the release window", () => {
    const next = stepGate(openedAt(1000), QUIET, 1000 + RELEASE_MS - 1, LIMITS);
    expect(next.openSince).toBe(1000);
  });

  it("closes and resets the attack count once the window expires", () => {
    const next = stepGate(openedAt(1000), QUIET, 1000 + RELEASE_MS, LIMITS);
    expect(next.openSince).toBe(0);
    expect(next.consecutiveHigh).toBe(0);
  });

  it("refreshes the window while the level stays above the close threshold", () => {
    const now = 1000 + RELEASE_MS * 2;
    expect(stepGate(openedAt(1000), LOUD, now, LIMITS).openSince).toBe(now);
  });
});

describe("stepGate hysteresis", () => {
  it("keeps an open gate open between the two thresholds", () => {
    const now = 1000 + RELEASE_MS * 2;
    expect(stepGate(openedAt(1000), BETWEEN, now, LIMITS).openSince).toBe(now);
  });

  it("keeps a closed gate closed between the two thresholds", () => {
    const first = stepGate(closed, BETWEEN, 1000, LIMITS);
    expect(stepGate(first, BETWEEN, 1025, LIMITS).openSince).toBe(0);
  });
});

describe("stepGate noise floor", () => {
  it("raises the open threshold above the configured one in a noisy room", () => {
    const noisy: GateState = { ...closed, noiseFloorDb: NOISE_FLOOR_MAX_DB };
    // -30 clears the configured -36, but not the floor + 8 dB (-27).
    const first = stepGate(noisy, -30, 1000, LIMITS);
    expect(stepGate(first, -30, 1025, LIMITS).openSince).toBe(0);
  });

  it("measures the floor from the first sample", () => {
    expect(stepGate(INITIAL_GATE_STATE, -50, 1000, LIMITS).noiseFloorDb).toBe(-50);
  });
});

describe("gate state handling", () => {
  it("does not mutate the state it is given", () => {
    const state = Object.freeze({ ...closed });
    expect(() => stepGate(state, LOUD, 1000, LIMITS)).not.toThrow();
  });

  it("closeGate keeps the measured noise floor", () => {
    expect(closeGate(openedAt(1000))).toEqual({ openSince: 0, consecutiveHigh: 0, noiseFloorDb: -70 });
  });
});

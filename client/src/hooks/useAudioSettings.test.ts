// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { MANUAL_THRESHOLD_MAX_DB, MANUAL_THRESHOLD_MIN_DB, THRESHOLD_MEDIUM_OPEN_DB } from "../lib/audioLevels";
import { useAudioSettings } from "./useAudioSettings";

const KEY = "huddle.audioSettings.v1";
const DEFAULTS = { noiseCancellationEnabled: true, transmissionThreshold: "medium", manualThresholdDb: THRESHOLD_MEDIUM_OPEN_DB };

const stored = () => JSON.parse(localStorage.getItem(KEY)!);
const load = (value: unknown) => {
  localStorage.setItem(KEY, typeof value === "string" ? value : JSON.stringify(value));
  return renderHook(() => useAudioSettings()).result.current.settings;
};

beforeEach(() => localStorage.clear());

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("loading", () => {
  it("uses the defaults on a first visit", () => {
    expect(renderHook(() => useAudioSettings()).result.current.settings).toEqual(DEFAULTS);
  });

  it("restores saved settings", () => {
    const saved = { noiseCancellationEnabled: false, transmissionThreshold: "manual", manualThresholdDb: -20 };

    expect(load(saved)).toEqual(saved);
  });

  it.each([["corrupt JSON", "{oops"], ["null", "null"], ["a string", '"medium"'], ["a number", "5"]])("falls back to the defaults for %s", (_label, raw) => {
    expect(load(raw)).toEqual(DEFAULTS);
  });

  it("replaces only the fields that are invalid", () => {
    expect(load({ noiseCancellationEnabled: "yes", transmissionThreshold: "loud", manualThresholdDb: -20 })).toEqual({ ...DEFAULTS, manualThresholdDb: -20 });
  });

  it("keeps a valid field next to a missing one", () => {
    expect(load({ noiseCancellationEnabled: false })).toEqual({ ...DEFAULTS, noiseCancellationEnabled: false });
  });

  it("clamps a saved manual threshold into the slider's range", () => {
    expect(load({ manualThresholdDb: -500 }).manualThresholdDb).toBe(MANUAL_THRESHOLD_MIN_DB);
    expect(load({ manualThresholdDb: 500 }).manualThresholdDb).toBe(MANUAL_THRESHOLD_MAX_DB);
  });

  it("ignores a manual threshold that isn't a number", () => {
    expect(load({ manualThresholdDb: "-20" }).manualThresholdDb).toBe(THRESHOLD_MEDIUM_OPEN_DB);
  });

  it("uses the defaults when storage can't be read", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });

    expect(renderHook(() => useAudioSettings()).result.current.settings).toEqual(DEFAULTS);
  });
});

describe("changing", () => {
  it("saves each change", () => {
    const { result } = renderHook(() => useAudioSettings());

    act(() => result.current.setNoiseCancellationEnabled(false));
    act(() => result.current.setTransmissionThreshold("high"));
    act(() => result.current.setManualThresholdDb(-25));

    expect(stored()).toEqual({ noiseCancellationEnabled: false, transmissionThreshold: "high", manualThresholdDb: -25 });
    expect(result.current.settings).toEqual(stored());
  });

  it("normalizes the manual threshold", () => {
    const { result } = renderHook(() => useAudioSettings());

    act(() => result.current.setManualThresholdDb(-25.4));
    expect(result.current.settings.manualThresholdDb).toBe(-25);

    act(() => result.current.setManualThresholdDb(0));
    expect(result.current.settings.manualThresholdDb).toBe(MANUAL_THRESHOLD_MAX_DB);
  });

  it("keeps the settings object when nothing changed, so consumers don't re-render", () => {
    const { result } = renderHook(() => useAudioSettings());
    const before = result.current.settings;

    act(() => {
      result.current.setNoiseCancellationEnabled(true);
      result.current.setTransmissionThreshold("medium");
      result.current.setManualThresholdDb(THRESHOLD_MEDIUM_OPEN_DB);
    });

    expect(result.current.settings).toBe(before);
  });

  it("keeps working when storage refuses the write", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    const { result } = renderHook(() => useAudioSettings());

    act(() => result.current.setTransmissionThreshold("off"));

    expect(result.current.settings.transmissionThreshold).toBe("off");
  });
});

// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { INITIAL_GATE_STATE } from "../lib/audioLevels";
import { asAnalyser, fakeAnalyser, LOUD } from "../test/fakeAnalyser";
import type { VoiceTransmissionThreshold } from "../types";
import { useMicTelemetry } from "./useMicTelemetry";

const TICK_MS = 80;

function setup({
  analyser = fakeAnalyser() as ReturnType<typeof fakeAnalyser> | null,
  isMuted = false,
  threshold = "medium" as VoiceTransmissionThreshold,
  manualDb = -20,
  isTransmitting = true,
  gate = { ...INITIAL_GATE_STATE },
} = {}) {
  const gateRef = { current: gate };
  const view = renderHook(() => useMicTelemetry(analyser && asAnalyser(analyser), isMuted, threshold, manualDb, isTransmitting, gateRef));
  return { analyser, gateRef, ...view };
}

const tick = () => act(() => vi.advanceTimersByTime(TICK_MS));

beforeEach(() => vi.useFakeTimers());

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useMicTelemetry", () => {
  it("reads the live level", () => {
    const analyser = fakeAnalyser();
    analyser.amplitude = LOUD;
    const { result } = setup({ analyser });

    tick();

    expect(result.current.levelDb).toBeCloseTo(-6, 0);
  });

  it("shows no level while muted, and stops reading", () => {
    const analyser = fakeAnalyser();
    const read = vi.spyOn(analyser, "getByteTimeDomainData");
    const { result } = setup({ analyser, isMuted: true });

    tick();

    expect(result.current.levelDb).toBe(-100);
    expect(result.current.isMuted).toBe(true);
    expect(read).not.toHaveBeenCalled();
  });

  it("reports no input without an analyser, even if the gate says transmitting", () => {
    const { result } = setup({ analyser: null, isTransmitting: true });

    expect(result.current.hasInput).toBe(false);
    expect(result.current.isTransmitting).toBe(false);
  });

  it("takes transmitting from the real gate instead of recomputing it", () => {
    const analyser = fakeAnalyser();
    analyser.amplitude = LOUD;
    const { result } = setup({ analyser, isTransmitting: false });

    tick();

    expect(result.current.isTransmitting).toBe(false);
  });

  it("shows the preset's open threshold", () => {
    expect(setup({ threshold: "low" }).result.current.thresholdDb).toBe(-42);
  });

  it("shows the manual threshold", () => {
    expect(setup({ threshold: "manual", manualDb: -25 }).result.current.thresholdDb).toBe(-25);
  });

  it("has no threshold when off", () => {
    expect(setup({ threshold: "off" }).result.current.thresholdDb).toBeNull();
  });

  it("shows the gate's noise floor once the gate has measured one", () => {
    const { result } = setup({ gate: { ...INITIAL_GATE_STATE, noiseFloorDb: -55 } });

    tick();

    expect(result.current.noiseFloorDb).toBe(-55);
  });

  it("falls back to its own floor before the gate has measured", () => {
    const analyser = fakeAnalyser();
    analyser.amplitude = 4; // about -30 dB, clamped to the floor's -35 dB ceiling
    const { result } = setup({ analyser });

    tick();

    expect(result.current.noiseFloorDb).toBe(-35);
  });

  it("measures its own floor when the threshold is off, ignoring a stale gate value", () => {
    const analyser = fakeAnalyser();
    analyser.amplitude = 4;
    const { result } = setup({ analyser, threshold: "off", gate: { ...INITIAL_GATE_STATE, noiseFloorDb: -55 } });

    tick();

    expect(result.current.noiseFloorDb).toBe(-35);
  });

  it("stops reading on unmount", () => {
    const analyser = fakeAnalyser();
    const read = vi.spyOn(analyser, "getByteTimeDomainData");
    const { unmount } = setup({ analyser });

    unmount();
    vi.advanceTimersByTime(TICK_MS * 3);

    expect(read).not.toHaveBeenCalled();
  });
});

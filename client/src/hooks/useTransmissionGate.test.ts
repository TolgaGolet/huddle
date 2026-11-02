// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { createWorkerInterval } from "../lib/workerTimer";
import { asAnalyser, fakeAnalyser, LOUD, SILENT } from "../test/fakeAnalyser";
import type { VoiceTransmissionThreshold } from "../types";
import { useTransmissionGate } from "./useTransmissionGate";

vi.mock("../lib/workerTimer", () => ({ createWorkerInterval: vi.fn() }));

const stopWorker = vi.fn();
let tickCallback: (() => void) | null;

/** Advances the clock too: a gate that opens at time 0 reads as closed, which a real clock never hits. */
function tick(times = 1) {
  act(() => {
    for (let i = 0; i < times; i++) {
      vi.advanceTimersByTime(25);
      tickCallback!();
    }
  });
}

interface Props {
  localAnalyser: AnalyserNode | null;
  outboundStream: MediaStream | null;
  threshold: VoiceTransmissionThreshold;
  manualThresholdDb: number;
  isMuted: boolean;
}

function setup(overrides: Partial<Props> = {}) {
  const analyser = fakeAnalyser();
  const track = { enabled: true };
  const stream = { getAudioTracks: () => [track] } as unknown as MediaStream;
  const initialProps: Props = { localAnalyser: asAnalyser(analyser), outboundStream: stream, threshold: "medium", manualThresholdDb: -36, isMuted: false, ...overrides };
  const view = renderHook((props: Props) => useTransmissionGate(props), { initialProps });
  return { analyser, track, stream, initialProps, ...view };
}

beforeEach(() => {
  vi.useFakeTimers();
  tickCallback = null;
  stopWorker.mockReset();
  vi.mocked(createWorkerInterval).mockReset().mockImplementation((callback) => {
    tickCallback = callback;
    return stopWorker;
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("threshold off", () => {
  it("transmits whenever unmuted, without polling the level", () => {
    const { result, track } = setup({ threshold: "off" });

    expect(createWorkerInterval).not.toHaveBeenCalled();
    expect(result.current.isTransmitting).toBe(true);
    expect(track.enabled).toBe(true);
  });

  it("stops transmitting when muted", () => {
    const { result, track } = setup({ threshold: "off", isMuted: true });

    expect(result.current.isTransmitting).toBe(false);
    expect(track.enabled).toBe(false);
  });
});

describe("gate", () => {
  it("closes the outgoing track on silence", () => {
    const { result, analyser, track } = setup();
    analyser.amplitude = SILENT;

    tick();

    expect(track.enabled).toBe(false);
    expect(result.current.isTransmitting).toBe(false);
  });

  it("opens on sustained speech, so a single click doesn't get through", () => {
    const { result, analyser, track } = setup();
    tick();

    analyser.amplitude = LOUD;
    tick();
    expect(track.enabled).toBe(false);

    tick();
    expect(track.enabled).toBe(true);
    expect(result.current.isTransmitting).toBe(true);
  });

  it("holds through a short pause, then closes after the release window", () => {
    const { analyser, track } = setup();
    analyser.amplitude = LOUD;
    tick(2);
    expect(track.enabled).toBe(true);

    analyser.amplitude = SILENT;
    vi.advanceTimersByTime(400);
    tick();
    expect(track.enabled).toBe(true);

    vi.advanceTimersByTime(200);
    tick();
    expect(track.enabled).toBe(false);
  });

  it("applies a changed threshold from the next tick", () => {
    const { analyser, track, rerender, initialProps } = setup({ threshold: "low" });
    tick(); // silence, so the noise floor is low and the threshold alone decides
    const quietSpeech = 2; // about -36 dB: above "low" (-42), below "very-high" (-24)
    analyser.amplitude = quietSpeech;
    tick(2);
    expect(track.enabled).toBe(true);

    rerender({ ...initialProps, threshold: "very-high" });
    vi.advanceTimersByTime(600);
    tick();

    expect(track.enabled).toBe(false);
  });

  it("uses the manual threshold in manual mode", () => {
    const { analyser, track } = setup({ threshold: "manual", manualThresholdDb: -10 });
    tick();
    analyser.amplitude = 16; // -18 dB: under this manual threshold, over the "medium" preset

    tick(2);
    expect(track.enabled).toBe(false);

    analyser.amplitude = 64; // -6 dB
    tick(2);
    expect(track.enabled).toBe(true);
  });

  it("stops polling on unmount", () => {
    const { unmount } = setup();

    unmount();

    expect(stopWorker).toHaveBeenCalled();
  });

  it("leaves the track alone without an outgoing stream", () => {
    const { result } = setup({ outboundStream: null });

    expect(result.current.isTransmitting).toBe(true);
  });
});

describe("failing open", () => {
  // A closed gate here would silently disable the track: one-way audio.
  it("stays open when there is no analyser to measure with", () => {
    const { result, track } = setup({ localAnalyser: null });

    expect(createWorkerInterval).not.toHaveBeenCalled();
    expect(track.enabled).toBe(true);
    expect(result.current.isTransmitting).toBe(true);
  });

  it("stays open while the audio context is suspended, which reads as silence", () => {
    const analyser = fakeAnalyser("suspended");
    const { track } = setup({ localAnalyser: asAnalyser(analyser) });

    tick(3);

    expect(track.enabled).toBe(true);
  });

  it("resumes gating once the context runs again", () => {
    const analyser = fakeAnalyser("suspended");
    const { track } = setup({ localAnalyser: asAnalyser(analyser) });
    tick();

    analyser.context.state = "running";
    tick();

    expect(track.enabled).toBe(false);
  });

  it("opens the gate if the context suspends mid-session", () => {
    const { analyser, track } = setup();
    tick();
    expect(track.enabled).toBe(false);

    analyser.context.state = "interrupted";
    tick();

    expect(track.enabled).toBe(true);
  });
});

describe("mute", () => {
  it("disables the track whatever the gate says, and doesn't poll", () => {
    const { result, track } = setup({ isMuted: true });

    expect(track.enabled).toBe(false);
    expect(result.current.isTransmitting).toBe(false);
    expect(createWorkerInterval).not.toHaveBeenCalled();
  });

  it("stops polling when muted mid-call", () => {
    const { rerender, initialProps } = setup();

    rerender({ ...initialProps, isMuted: true });

    expect(stopWorker).toHaveBeenCalled();
  });

  it("comes back from mute closed, so a muted-over noise doesn't leak out", () => {
    const { result, analyser, track, rerender, initialProps } = setup();
    analyser.amplitude = LOUD;
    tick(2);
    expect(track.enabled).toBe(true);

    rerender({ ...initialProps, isMuted: true });
    rerender({ ...initialProps, isMuted: false });

    expect(track.enabled).toBe(false);
    expect(result.current.isTransmitting).toBe(false);
  });

  it("needs fresh speech to open after an unmute", () => {
    const { analyser, track, rerender, initialProps } = setup();
    analyser.amplitude = LOUD;
    tick(2);
    rerender({ ...initialProps, isMuted: true });
    rerender({ ...initialProps, isMuted: false });

    tick();
    expect(track.enabled).toBe(false);

    tick();
    expect(track.enabled).toBe(true);
  });
});

describe("gate state", () => {
  it("exposes the measured noise floor for the settings meter", () => {
    const { result, analyser } = setup();
    analyser.amplitude = 1; // about -42 dB
    expect(result.current.gateStateRef.current.noiseFloorDb).toBeNull();

    tick();

    expect(result.current.gateStateRef.current.noiseFloorDb).toBeCloseTo(-42.1, 0);
  });
});

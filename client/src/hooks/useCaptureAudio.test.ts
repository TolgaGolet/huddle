// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useCaptureAudio } from "./useCaptureAudio";

const mocks = vi.hoisted(() => {
  class FakeEngine {
    static all: FakeEngine[] = [];
    health: ((needsGesture: boolean) => void) | null = null;
    analyser = { engine: true };
    setInputStream = vi.fn(async () => {});
    getAnalyser = () => this.analyser;
    resume = vi.fn(async () => {});
    destroy = vi.fn();
    onHealth = (listener: (needsGesture: boolean) => void) => {
      this.health = listener;
      return () => {};
    };
    constructor() {
      FakeEngine.all.push(this);
    }
  }
  return { FakeEngine };
});

vi.mock("../lib/audioEngine", () => ({ AudioEngine: mocks.FakeEngine }));

const { FakeEngine } = mocks;
const stream = {} as MediaStream;

beforeEach(() => {
  FakeEngine.all = [];
});

afterEach(cleanup);

describe("useCaptureAudio", () => {
  it("creates no audio engine until there's a stream", () => {
    const { result } = renderHook(() => useCaptureAudio());

    expect(FakeEngine.all).toEqual([]);
    expect(result.current.localAnalyser).toBeNull();
  });

  // The outgoing track must stay the native one: this hook only taps it.
  it("returns the stream unchanged and exposes the analyser", async () => {
    const { result } = renderHook(() => useCaptureAudio());

    let returned: MediaStream | undefined;
    await act(async () => {
      returned = await result.current.processStream(stream);
    });

    expect(returned).toBe(stream);
    expect(FakeEngine.all[0].setInputStream).toHaveBeenCalledWith(stream);
    expect(result.current.localAnalyser).toBe(FakeEngine.all[0].analyser);
  });

  it("reuses the engine for a new device", async () => {
    const { result } = renderHook(() => useCaptureAudio());

    await act(async () => {
      await result.current.processStream(stream);
      await result.current.processStream(stream);
    });

    expect(FakeEngine.all).toHaveLength(1);
  });

  it("forwards the engine's request for a gesture", async () => {
    const { result } = renderHook(() => useCaptureAudio());
    await act(async () => {
      await result.current.processStream(stream);
    });

    act(() => FakeEngine.all[0].health!(true));

    expect(result.current.needsAudioGesture).toBe(true);
  });

  it("resumes through the engine", async () => {
    const { result } = renderHook(() => useCaptureAudio());
    await act(async () => {
      await result.current.processStream(stream);
    });

    await result.current.resumeAudio();

    expect(FakeEngine.all[0].resume).toHaveBeenCalled();
  });

  it("has nothing to resume before there's an engine", async () => {
    const { result } = renderHook(() => useCaptureAudio());

    await expect(result.current.resumeAudio()).resolves.toBeUndefined();
  });

  it("destroys the engine and resets on cleanup, and starts fresh afterwards", async () => {
    const { result } = renderHook(() => useCaptureAudio());
    await act(async () => {
      await result.current.processStream(stream);
    });
    act(() => FakeEngine.all[0].health!(true));

    act(() => result.current.cleanup());

    expect(FakeEngine.all[0].destroy).toHaveBeenCalled();
    expect(result.current.localAnalyser).toBeNull();
    expect(result.current.needsAudioGesture).toBe(false);

    await act(async () => {
      await result.current.processStream(stream);
    });
    expect(FakeEngine.all).toHaveLength(2);
  });
});

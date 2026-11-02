// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { useMediaDevices, watchDeviceChanges } from "./useMediaDevices";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("watchDeviceChanges", () => {
  // Regression: this threw on plain HTTP, leaving a blank page.
  it("does nothing on an insecure origin, where mediaDevices is undefined", () => {
    vi.stubGlobal("navigator", {});

    expect(() => watchDeviceChanges(() => {})()).not.toThrow();
  });

  it("subscribes and unsubscribes the handler", () => {
    const mediaDevices = { addEventListener: vi.fn(), removeEventListener: vi.fn() };
    vi.stubGlobal("navigator", { mediaDevices });
    const onChange = () => {};

    const stop = watchDeviceChanges(onChange);
    expect(mediaDevices.addEventListener).toHaveBeenCalledWith("devicechange", onChange);

    stop();
    expect(mediaDevices.removeEventListener).toHaveBeenCalledWith("devicechange", onChange);
  });
});

describe("useMediaDevices", () => {
  const mic = (deviceId: string) => ({ kind: "audioinput", deviceId }) as MediaDeviceInfo;
  const speaker = { kind: "audiooutput", deviceId: "speaker" } as MediaDeviceInfo;

  function stubDevices(enumerateDevices: () => Promise<MediaDeviceInfo[]>) {
    let onChange: (() => void) | undefined;
    vi.stubGlobal("navigator", {
      mediaDevices: {
        enumerateDevices,
        addEventListener: (_event: string, handler: () => void) => (onChange = handler),
        removeEventListener: vi.fn(),
      },
    });
    return { change: () => onChange?.() };
  }

  it("lists microphones only and selects the first", async () => {
    stubDevices(async () => [speaker, mic("a"), mic("b")]);
    const { result } = renderHook(() => useMediaDevices());

    await waitFor(() => expect(result.current.audioInputs).toHaveLength(2));

    expect(result.current.selectedDeviceId).toBe("a");
  });

  it("selects nothing when there are no microphones", async () => {
    const enumerate = vi.fn(async () => [speaker]);
    stubDevices(enumerate);
    const { result } = renderHook(() => useMediaDevices());

    await waitFor(() => expect(enumerate).toHaveBeenCalled());

    expect(result.current.selectedDeviceId).toBe("");
  });

  it("keeps the user's choice when the list changes", async () => {
    let devices = [mic("a"), mic("b")];
    const { change } = stubDevices(async () => devices);
    const { result } = renderHook(() => useMediaDevices());
    await waitFor(() => expect(result.current.audioInputs).toHaveLength(2));
    act(() => result.current.setSelectedDeviceId("b"));

    devices = [mic("a"), mic("b"), mic("c")];
    change();

    await waitFor(() => expect(result.current.audioInputs).toHaveLength(3));
    expect(result.current.selectedDeviceId).toBe("b");
  });

  it("logs a failed listing and stays empty", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    stubDevices(() => Promise.reject(new Error("no")));
    const { result } = renderHook(() => useMediaDevices());

    await waitFor(() => expect(warn).toHaveBeenCalled());

    expect(result.current.audioInputs).toEqual([]);
  });
});

// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { useMicrophone } from "./useMicrophone";

class FakeTrack {
  kind = "audio";
  enabled = true;
  readyState = "live";
  stop = vi.fn();
  onended: (() => void) | null = null;
  clone = () => new FakeTrack();
  addEventListener = vi.fn();
  removeEventListener = vi.fn();
  getSettings = () => ({ deviceId: "usb", noiseSuppression: true });
}

class FakeStream {
  constructor(private tracks: FakeTrack[] = [new FakeTrack()]) {}
  getTracks = () => this.tracks;
  getAudioTracks = () => this.tracks;
}

const namedError = (name: string) => Object.assign(new Error(name), { name });

function stubMedia(getUserMedia: unknown) {
  Object.defineProperty(navigator, "mediaDevices", { value: getUserMedia ? { getUserMedia } : undefined, configurable: true });
}

function setup(getUserMedia: unknown) {
  stubMedia(getUserMedia);
  const options = {
    isMuted: false,
    noiseCancellation: true,
    processStream: vi.fn(async (raw: MediaStream) => raw),
    onDevice: vi.fn(),
    onRelease: vi.fn(),
  };
  return { options, ...renderHook(() => useMicrophone(options)) };
}

beforeEach(() => {
  vi.stubGlobal("MediaStream", FakeStream);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "debug").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useMicrophone", () => {
  it("acquires on mount, reports the device and publishes a stream", async () => {
    const getUserMedia = vi.fn(async () => new FakeStream());
    const { result, options } = setup(getUserMedia);

    await waitFor(() => expect(result.current.stream).not.toBeNull());

    expect(options.processStream).toHaveBeenCalledOnce();
    expect(options.onDevice).toHaveBeenCalledWith("usb");
    expect(result.current.error).toBeNull();
  });

  it("reports a denied microphone", async () => {
    const { result } = setup(vi.fn().mockRejectedValue(namedError("NotAllowedError")));

    await waitFor(() => expect(result.current.error).toBe("denied"));

    expect(result.current.stream).toBeNull();
  });

  // Regression guard: mediaDevices is undefined on plain HTTP, and this must end in
  // the mic banner rather than an unhandled error.
  it("reports an error rather than throwing when the browser hides mediaDevices", async () => {
    const { result } = setup(null);

    await waitFor(() => expect(result.current.error).not.toBeNull());
  });

  it("recovers through retry, showing progress meanwhile", async () => {
    const getUserMedia = vi.fn().mockRejectedValueOnce(namedError("NotFoundError"));
    const { result } = setup(getUserMedia);
    await waitFor(() => expect(result.current.error).toBe("not-found"));
    let finish!: (stream: FakeStream) => void;
    getUserMedia.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));

    let retried!: Promise<void>;
    act(() => {
      retried = result.current.retry();
    });
    expect(result.current.retrying).toBe(true);

    await act(async () => {
      finish(new FakeStream());
      await retried;
    });

    expect(result.current.retrying).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.stream).not.toBeNull();
  });

  it("ignores a second retry while one is running", async () => {
    const getUserMedia = vi.fn().mockRejectedValueOnce(namedError("NotFoundError"));
    const { result } = setup(getUserMedia);
    await waitFor(() => expect(result.current.error).toBe("not-found"));
    let finish!: (stream: FakeStream) => void;
    getUserMedia.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    let retried!: Promise<void>;
    act(() => {
      retried = result.current.retry();
    });
    const calls = getUserMedia.mock.calls.length;

    await act(async () => {
      await result.current.retry();
    });
    expect(getUserMedia).toHaveBeenCalledTimes(calls);

    await act(async () => {
      finish(new FakeStream());
      await retried;
    });
  });

  it("asks for the exact device on a switch", async () => {
    const getUserMedia = vi.fn(async (_c: MediaStreamConstraints) => new FakeStream());
    const { result } = setup(getUserMedia);
    await waitFor(() => expect(result.current.stream).not.toBeNull());

    await act(async () => {
      result.current.setDevice("headset");
      await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(2));
    });

    expect(getUserMedia.mock.calls[1][0].audio).toMatchObject({ deviceId: { exact: "headset" } });
  });

  it("clears a dismissed error", async () => {
    const { result } = setup(vi.fn().mockRejectedValue(namedError("NotFoundError")));
    await waitFor(() => expect(result.current.error).toBe("not-found"));

    act(() => result.current.dismissError());

    expect(result.current.error).toBeNull();
  });

  it("stops the capture and runs the release callback on unmount", async () => {
    const raw = new FakeStream();
    const { result, options, unmount } = setup(vi.fn(async () => raw));
    await waitFor(() => expect(result.current.stream).not.toBeNull());

    unmount();

    expect(raw.getTracks()[0].stop).toHaveBeenCalled();
    expect(options.onRelease).toHaveBeenCalledOnce();
  });
});

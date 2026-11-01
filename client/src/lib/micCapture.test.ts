import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MicCapture } from "./micCapture";
import type { MicError } from "./micError";

class FakeTrack {
  enabled = true;
  readyState = "live";
  stop = vi.fn(() => {
    this.readyState = "ended";
  });
  private endedListeners: (() => void)[] = [];

  constructor(private readonly deviceId = "device") {}

  clone() {
    return new FakeTrack(this.deviceId);
  }
  getSettings() {
    return { deviceId: this.deviceId };
  }
  addEventListener(_type: "ended", listener: () => void) {
    this.endedListeners.push(listener);
  }
  /** What the browser does on unplug: `ended` fires, unlike with stop(). */
  end() {
    this.readyState = "ended";
    this.endedListeners.forEach((listener) => listener());
  }
}

class FakeStream {
  constructor(private readonly tracks: FakeTrack[]) {}
  getTracks() {
    return this.tracks;
  }
  getAudioTracks() {
    return this.tracks;
  }
}

function fakeCapture(deviceId = "device") {
  const track = new FakeTrack(deviceId);
  return { track, stream: new FakeStream([track]) as unknown as MediaStream };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const namedError = (name: string) => Object.assign(new Error(name), { name });

function setup(getUserMedia = vi.fn<(c: MediaStreamConstraints) => Promise<MediaStream>>()) {
  const streams: MediaStream[] = [];
  const errors: (MicError | null)[] = [];
  const devices: string[] = [];
  const mic = new MicCapture({
    getUserMedia,
    processStream: async (raw) => raw,
    isMuted: () => false,
    noiseCancellation: () => true,
    onStream: (stream) => streams.push(stream),
    onError: (error) => errors.push(error),
    onDevice: (deviceId) => devices.push(deviceId),
  });
  return { mic, getUserMedia, streams, errors, devices };
}

beforeEach(() => {
  vi.stubGlobal("MediaStream", FakeStream);
  vi.spyOn(console, "debug").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("MicCapture", () => {
  it("publishes an outbound clone, leaving the raw track for the analyser", async () => {
    const { mic, getUserMedia, streams, devices } = setup();
    const { track, stream } = fakeCapture("usb");
    getUserMedia.mockResolvedValue(stream);

    expect(await mic.acquire()).toBe(true);

    const outbound = streams[0].getAudioTracks()[0] as unknown as FakeTrack;
    expect(outbound).not.toBe(track);
    expect(devices).toEqual(["usb"]);
  });

  it("stops a stale acquisition's stream instead of installing it", async () => {
    const { mic, getUserMedia, streams } = setup();
    const slow = deferred<MediaStream>();
    const stale = fakeCapture();
    const fresh = fakeCapture();
    getUserMedia.mockReturnValueOnce(slow.promise).mockResolvedValueOnce(fresh.stream);

    const first = mic.acquire("a");
    await mic.acquire("b");
    slow.resolve(stale.stream);

    expect(await first).toBe(false);
    expect(stale.track.stop).toHaveBeenCalled();
    expect(fresh.track.stop).not.toHaveBeenCalled();
    expect(streams).toHaveLength(1);
  });

  it("stops the old capture only once the new one is confirmed", async () => {
    const { mic, getUserMedia } = setup();
    const old = fakeCapture();
    const next = deferred<MediaStream>();
    getUserMedia.mockResolvedValueOnce(old.stream).mockReturnValueOnce(next.promise);
    await mic.acquire();

    const switching = mic.acquire("b");
    expect(old.track.stop).not.toHaveBeenCalled();

    next.resolve(fakeCapture().stream);
    await switching;
    expect(old.track.stop).toHaveBeenCalled();
  });

  it("reports switch-failed when the previous mic is still live", async () => {
    const { mic, getUserMedia, errors } = setup();
    getUserMedia.mockResolvedValueOnce(fakeCapture().stream).mockRejectedValueOnce(namedError("NotReadableError"));
    await mic.acquire();

    expect(await mic.acquire("b")).toBe(false);

    expect(errors.at(-1)).toBe("switch-failed");
  });

  it("reports the cause when nothing is capturing", async () => {
    const { mic, getUserMedia, errors } = setup();
    getUserMedia.mockRejectedValue(namedError("NotAllowedError"));

    await mic.acquire();

    expect(errors.at(-1)).toBe("denied");
  });

  it("reacquires the default device when the track ends", async () => {
    const { mic, getUserMedia, streams } = setup();
    const first = fakeCapture();
    getUserMedia.mockResolvedValueOnce(first.stream).mockResolvedValueOnce(fakeCapture().stream);
    await mic.acquire("usb");

    first.track.end();

    await vi.waitFor(() => expect(streams).toHaveLength(2));
    expect(getUserMedia.mock.calls[1][0].audio).not.toHaveProperty("deviceId");
  });

  it("reports ended, not switch-failed, when recovery after a track end fails", async () => {
    const { mic, getUserMedia, errors } = setup();
    const first = fakeCapture();
    getUserMedia.mockResolvedValueOnce(first.stream).mockRejectedValueOnce(namedError("NotFoundError"));
    await mic.acquire();
    // The clone still reads as live here, so the failed recovery first says switch-failed.
    first.track.end();

    await vi.waitFor(() => expect(errors.at(-1)).toBe("ended"));
  });

  it("retries the device that failed, or the default if it has gone away", async () => {
    const { mic, getUserMedia } = setup();
    getUserMedia.mockRejectedValueOnce(namedError("NotReadableError"));
    await mic.acquire("usb");
    getUserMedia.mockRejectedValueOnce(namedError("NotFoundError"));

    await mic.retry();
    expect(getUserMedia.mock.calls[1][0].audio).toMatchObject({ deviceId: { exact: "usb" } });

    getUserMedia.mockResolvedValueOnce(fakeCapture().stream);
    await mic.retry();
    expect(getUserMedia.mock.calls[2][0].audio).not.toHaveProperty("deviceId");
  });

  it("doesn't reopen the mic when disposed during an acquisition", async () => {
    const { mic, getUserMedia, streams } = setup();
    const pending = deferred<MediaStream>();
    const late = fakeCapture();
    getUserMedia.mockReturnValue(pending.promise);

    const acquiring = mic.acquire();
    mic.dispose();
    pending.resolve(late.stream);

    expect(await acquiring).toBe(false);
    expect(late.track.stop).toHaveBeenCalled();
    expect(streams).toEqual([]);
  });

  // StrictMode runs the mount effect's cleanup and then the effect again.
  it("can acquire again after dispose", async () => {
    const { mic, getUserMedia, streams } = setup();
    getUserMedia.mockResolvedValue(fakeCapture().stream);

    mic.dispose();

    expect(await mic.acquire()).toBe(true);
    expect(streams).toHaveLength(1);
  });

  it("releases both the raw capture and the outbound clone", async () => {
    const { mic, getUserMedia, streams } = setup();
    const { track, stream } = fakeCapture();
    getUserMedia.mockResolvedValue(stream);
    await mic.acquire();

    mic.dispose();

    expect(track.stop).toHaveBeenCalled();
    expect((streams[0].getAudioTracks()[0] as unknown as FakeTrack).stop).toHaveBeenCalled();
  });

  it("reacquires with the new setting when the browser ignores the constraint", async () => {
    const { mic, getUserMedia } = setup();
    getUserMedia.mockResolvedValue(fakeCapture().stream);
    await mic.acquire();

    // FakeTrack has no applyConstraints, like a browser that can't change it live.
    await mic.setNoiseCancellation(false, "usb");

    await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(2));
    expect(getUserMedia.mock.calls[1][0].audio).toMatchObject({ noiseSuppression: false, deviceId: { exact: "usb" } });
  });
});

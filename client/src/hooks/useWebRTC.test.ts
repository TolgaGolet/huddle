// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { asAppSocket, emitsOf, fakeSocket, type FakeSocket } from "../test/fakeSocket";
import type { AppSocket } from "../types";
import { MIC_SETTLE_TIMEOUT_MS, useWebRTC } from "./useWebRTC";

// PeerSession (negotiation) and RemoteAudioManager have their own tests. This covers
// what the hook adds: which session gets what, and what React state comes out.
const mocks = vi.hoisted(() => {
  class FakeSession {
    static all: FakeSession[] = [];
    dispose = vi.fn();
    handleOffer = vi.fn(async () => {});
    handleAnswer = vi.fn(async () => {});
    addCandidate = vi.fn(async () => {});
    attachLocalTrack = vi.fn();
    addScreenTrack = vi.fn();
    removeScreenTrack = vi.fn();
    sampleStats = vi.fn(async () => {});
    constructor(
      public peerId: string,
      public pc: unknown,
      public host: {
        onTrack: (e: unknown) => void;
        onConnectionState: (s: string) => void;
        requestRecreate: () => void;
        getLocalStream: () => unknown;
        emit: (event: string, ...args: unknown[]) => void;
      },
      public options: { screenTrack: unknown; earlyCandidates?: unknown[] },
    ) {
      FakeSession.all.push(this);
    }
  }

  class FakeAudio {
    static all: FakeAudio[] = [];
    analysers = new Map<string, unknown>();
    healthListener: ((blocked: boolean) => void) | null = null;
    addStream = vi.fn((id: string) => void this.analysers.set(id, { peer: id }));
    removeStream = vi.fn((id: string) => void this.analysers.delete(id));
    getAnalysers = () => this.analysers;
    setVolume = vi.fn();
    destroy = vi.fn();
    resumePlayback = vi.fn(async () => true);
    onHealth = (listener: (blocked: boolean) => void) => {
      this.healthListener = listener;
      return () => {
        this.healthListener = null;
      };
    };
    constructor() {
      FakeAudio.all.push(this);
    }
  }

  return { FakeSession, FakeAudio };
});

vi.mock("../lib/peerSession", () => ({ PeerSession: mocks.FakeSession }));
vi.mock("../lib/audioEngine", () => ({ RemoteAudioManager: mocks.FakeAudio }));

const { FakeSession, FakeAudio } = mocks;

const sessionsFor = (id: string) => FakeSession.all.filter((s) => s.peerId === id);
const sessionFor = (id: string) => sessionsFor(id).at(-1)!;
const roster = (...ids: string[]) => ({ participants: ids.map((id) => ({ id })), screenSharer: null });

class FakeStream {
  constructor(public tracks: unknown[] = []) {}
  getAudioTracks = () => this.tracks;
  getVideoTracks = () => this.tracks;
}

function fakeTrack(kind: string) {
  return { kind, stop: vi.fn(), onended: null as (() => void) | null };
}

let socket: FakeSocket;

type Props = { socket: AppSocket | null; localStream: MediaStream | null; micSettled?: boolean };

function setup(overrides: { onScreenShareStopped?: () => void; onSignalingReady?: () => void; localStream?: MediaStream | null; micSettled?: boolean } = {}) {
  return renderHook(
    ({ micSettled = true, ...props }: Props) =>
      useWebRTC({ ...props, micSettled, onScreenShareStopped: overrides.onScreenShareStopped, onSignalingReady: overrides.onSignalingReady }),
    {
      initialProps: {
        socket: asAppSocket(socket) as AppSocket | null,
        localStream: overrides.localStream ?? null,
        micSettled: overrides.micSettled,
      } as Props,
    },
  );
}

async function fire(event: string, data?: unknown) {
  await act(async () => {
    await Promise.all(socket.fire(event, data));
  });
}

function stubDisplayMedia(result: unknown) {
  const getDisplayMedia = result instanceof Error ? vi.fn().mockRejectedValue(result) : vi.fn().mockResolvedValue(result);
  Object.defineProperty(navigator, "mediaDevices", { value: { getDisplayMedia }, configurable: true });
  return getDisplayMedia;
}

/** Starts a share under the socket's current id; returns its track and stream. */
async function startShare(result: { current: ReturnType<typeof useWebRTC> }) {
  const track = fakeTrack("video");
  const stream = new FakeStream([track]);
  stubDisplayMedia(stream);
  let ok: boolean | undefined;
  await act(async () => {
    ok = await result.current.startScreenShare();
  });
  return { track, stream, ok };
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  FakeSession.all = [];
  FakeAudio.all = [];
  socket = fakeSocket("self");
  vi.stubGlobal("RTCPeerConnection", class {});
  vi.stubGlobal("MediaStream", FakeStream);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("signaling setup", () => {
  it("signals ready only after every listener is installed", () => {
    const seen: number[] = [];
    setup({ onSignalingReady: () => seen.push(socket.listening("room-joined") + socket.listening("offer") + socket.listening("ice-candidate")) });

    expect(seen).toEqual([3]);
  });

  it("does nothing without a socket", () => {
    const onSignalingReady = vi.fn();
    renderHook(() => useWebRTC({ socket: null, localStream: null, micSettled: true, onSignalingReady }));

    expect(onSignalingReady).not.toHaveBeenCalled();
  });

  it("removes its listeners and closes every peer when the socket goes", async () => {
    const { rerender } = setup();
    await fire("room-joined", roster("a"));

    rerender({ socket: null, localStream: null });

    expect(socket.listening("offer")).toBe(0);
    expect(sessionFor("a").dispose).toHaveBeenCalled();
  });
});

describe("peers", () => {
  it("offers to everyone in the roster, once each", async () => {
    setup();

    await fire("room-joined", roster("a", "b"));
    await fire("room-joined", roster("a", "b"));

    expect(FakeSession.all.map((s) => s.peerId)).toEqual(["a", "b"]);
  });

  it("answers an offer on a new session, with our own id for the polite check", async () => {
    setup();
    const offer = { type: "offer", sdp: "o" };

    await fire("offer", { from: "a", offer });

    expect(sessionFor("a").handleOffer).toHaveBeenCalledWith(offer, "self");
  });

  it("leaves no orphan peer for an offer that arrives while disconnected", async () => {
    socket.id = undefined;
    setup();

    await fire("offer", { from: "a", offer: {} });

    expect(FakeSession.all).toEqual([]);
  });

  it("survives a failed offer", async () => {
    setup();
    await fire("room-joined", roster("a"));
    sessionFor("a").handleOffer.mockRejectedValueOnce(new Error("bad sdp"));

    await expect(fire("offer", { from: "a", offer: {} })).resolves.toBeUndefined();
  });

  it("routes an answer to its peer and ignores one from nobody", async () => {
    setup();
    await fire("room-joined", roster("a"));
    const answer = { type: "answer" };

    await fire("answer", { from: "a", answer });
    await fire("answer", { from: "ghost", answer });

    expect(sessionFor("a").handleAnswer).toHaveBeenCalledWith(answer);
  });

  it("hands candidates that beat the session to the session once it exists", async () => {
    setup();
    const candidate = { candidate: "c1" };

    await fire("ice-candidate", { from: "a", candidate });
    await fire("offer", { from: "a", offer: {} });

    expect(sessionFor("a").options.earlyCandidates).toEqual([candidate]);
    expect(sessionFor("a").addCandidate).not.toHaveBeenCalled();
  });

  it("passes later candidates straight to the session", async () => {
    setup();
    await fire("room-joined", roster("a"));
    const candidate = { candidate: "c1" };

    await fire("ice-candidate", { from: "a", candidate });

    expect(sessionFor("a").addCandidate).toHaveBeenCalledWith(candidate);
  });

  it("forgets a departed peer's early candidates", async () => {
    setup();
    await fire("ice-candidate", { from: "a", candidate: {} });

    await fire("participant-left", { id: "a" });
    await fire("offer", { from: "a", offer: {} });

    expect(sessionFor("a").options.earlyCandidates).toBeUndefined();
  });

  it("closes a peer who left and clears all of its state", async () => {
    const { result } = setup();
    await fire("room-joined", roster("a"));
    const session = sessionFor("a");
    act(() => {
      session.host.onTrack({ track: fakeTrack("audio"), streams: [new FakeStream()] });
      session.host.onTrack({ track: fakeTrack("video"), streams: [new FakeStream()] });
      session.host.onConnectionState("connected");
    });

    await fire("participant-left", { id: "a" });

    expect(session.dispose).toHaveBeenCalled();
    expect(result.current.remoteAnalysers.size).toBe(0);
    expect(result.current.screenStreams.size).toBe(0);
    expect(result.current.peerConnectionStates.size).toBe(0);
  });

  it("closes every peer when our own transport drops", async () => {
    setup();
    await fire("room-joined", roster("a", "b"));

    await fire("disconnect");

    expect(sessionFor("a").dispose).toHaveBeenCalled();
    expect(sessionFor("b").dispose).toHaveBeenCalled();
  });

  it("rebuilds a peer when its session asks", async () => {
    setup();
    await fire("room-joined", roster("a"));
    const first = sessionFor("a");

    act(() => first.host.requestRecreate());

    expect(first.dispose).toHaveBeenCalled();
    expect(sessionsFor("a")).toHaveLength(2);
  });

  it("samples stats on every session periodically", async () => {
    vi.useFakeTimers();
    setup();
    await fire("room-joined", roster("a"));

    vi.advanceTimersByTime(5000);

    expect(sessionFor("a").sampleStats).toHaveBeenCalledOnce();
  });

  it("gives sessions the mic stream that's current when they read it", async () => {
    const stream = new FakeStream() as unknown as MediaStream;
    const { rerender } = setup();
    await fire("room-joined", roster("a"));

    rerender({ socket: asAppSocket(socket), localStream: stream });

    expect(sessionFor("a").host.getLocalStream()).toBe(stream);
  });

  it("attaches a new mic track to every session", async () => {
    const { rerender } = setup();
    await fire("room-joined", roster("a", "b"));
    const track = fakeTrack("audio");
    const stream = new FakeStream([track]) as unknown as MediaStream;

    rerender({ socket: asAppSocket(socket), localStream: stream });

    expect(sessionFor("a").attachLocalTrack).toHaveBeenCalledWith(track, stream);
    expect(sessionFor("b").attachLocalTrack).toHaveBeenCalledWith(track, stream);
  });

  it("ignores a mic stream with no audio track", async () => {
    const { rerender } = setup();
    await fire("room-joined", roster("a"));

    rerender({ socket: asAppSocket(socket), localStream: new FakeStream() as unknown as MediaStream });

    expect(sessionFor("a").attachLocalTrack).not.toHaveBeenCalled();
  });
});

// Regression: a Firefox joiner that offered before its mic gathered restricted ICE
// candidates, failed to connect and stayed unheard after the ICE restart.
describe("waiting for the mic before the first offers", () => {
  const settle = (rerender: (p: Props) => void) =>
    act(() => rerender({ socket: asAppSocket(socket), localStream: null, micSettled: true }));

  it("holds the roster until the mic settles", async () => {
    const { rerender } = setup({ micSettled: false });
    await fire("room-joined", roster("a", "b"));
    expect(FakeSession.all).toHaveLength(0);

    settle(rerender);

    expect(FakeSession.all.map((s) => s.peerId)).toEqual(["a", "b"]);
  });

  it("offers anyway after a timeout, so an unanswered prompt still connects", async () => {
    vi.useFakeTimers();
    const { rerender } = setup({ micSettled: false });
    await fire("room-joined", roster("a"));

    act(() => void vi.advanceTimersByTime(MIC_SETTLE_TIMEOUT_MS));
    expect(sessionsFor("a")).toHaveLength(1);

    settle(rerender);
    expect(sessionsFor("a")).toHaveLength(1);
  });

  it("skips someone who left while waiting", async () => {
    const { rerender } = setup({ micSettled: false });
    await fire("room-joined", roster("a", "b"));
    await fire("participant-left", { id: "a" });

    settle(rerender);

    expect(FakeSession.all.map((s) => s.peerId)).toEqual(["b"]);
  });

  it("forgets the roster when our transport drops", async () => {
    vi.useFakeTimers();
    const { rerender } = setup({ micSettled: false });
    await fire("room-joined", roster("a"));
    await fire("disconnect");

    settle(rerender);
    act(() => void vi.advanceTimersByTime(MIC_SETTLE_TIMEOUT_MS));

    expect(FakeSession.all).toHaveLength(0);
  });

  // Regression: a re-acquire (noise-suppression toggle) briefly nulls the stream,
  // so a rejoin in that window held its offers for up to MIC_SETTLE_TIMEOUT_MS.
  it("stays settled once the mic has settled", async () => {
    const { rerender } = setup({ micSettled: true });
    act(() => rerender({ socket: asAppSocket(socket), localStream: null, micSettled: false }));

    await fire("room-joined", roster("a"));

    expect(sessionsFor("a")).toHaveLength(1);
  });

  it("still answers offers while waiting", async () => {
    setup({ micSettled: false });

    await fire("offer", { from: "c", offer: {} });

    expect(sessionFor("c").handleOffer).toHaveBeenCalled();
  });
});

describe("remote media", () => {
  it("plays remote audio and exposes its analyser", async () => {
    const { result } = setup();
    await fire("room-joined", roster("a"));
    const stream = new FakeStream();

    act(() => sessionFor("a").host.onTrack({ track: fakeTrack("audio"), streams: [stream] }));

    expect(FakeAudio.all[0].addStream).toHaveBeenCalledWith("a", stream);
    expect(result.current.remoteAnalysers.has("a")).toBe(true);
  });

  // Regression: a track attached by replaceTrack arrives with no stream, and dropping
  // it caused permanent one-way audio.
  it("wraps a track that arrives without a stream", async () => {
    setup();
    await fire("room-joined", roster("a"));
    const track = fakeTrack("audio");

    act(() => sessionFor("a").host.onTrack({ track, streams: [] }));

    const wrapped = FakeAudio.all[0].addStream.mock.calls[0] as unknown as [string, FakeStream];
    expect(wrapped[1].tracks).toEqual([track]);
  });

  it("shows a remote screen until its track ends", async () => {
    const { result } = setup();
    await fire("room-joined", roster("a"));
    const track = fakeTrack("video");
    const stream = new FakeStream();

    act(() => sessionFor("a").host.onTrack({ track, streams: [stream] }));
    expect(result.current.screenStreams.get("a")).toBe(stream);

    act(() => track.onended!());
    expect(result.current.screenStreams.has("a")).toBe(false);
  });

  it("removes a remote screen when its sharer announces the stop", async () => {
    const { result } = setup();
    await fire("room-joined", roster("a"));
    act(() => sessionFor("a").host.onTrack({ track: fakeTrack("video"), streams: [new FakeStream()] }));

    await fire("screen-share-stopped", { id: "a" });

    expect(result.current.screenStreams.size).toBe(0);
  });

  it("tracks each peer's connection state, keeping the map on a repeat", async () => {
    const { result } = setup();
    await fire("room-joined", roster("a"));

    act(() => sessionFor("a").host.onConnectionState("connecting"));
    const states = result.current.peerConnectionStates;
    expect(states.get("a")).toBe("connecting");

    act(() => sessionFor("a").host.onConnectionState("connecting"));
    expect(result.current.peerConnectionStates).toBe(states);
  });

  it("forwards a peer's volume", () => {
    const { result } = setup();

    result.current.setRemoteVolume("a", 0.5);

    expect(FakeAudio.all[0].setVolume).toHaveBeenCalledWith("a", 0.5);
  });
});

describe("blocked playback", () => {
  it("surfaces the block and clears it after a successful resume", async () => {
    const { result } = setup();
    act(() => FakeAudio.all[0].healthListener!(true));
    expect(result.current.remotePlaybackBlocked).toBe(true);

    await act(() => result.current.resumeRemotePlayback());

    expect(result.current.remotePlaybackBlocked).toBe(false);
  });

  it("keeps the banner when the resume didn't work", async () => {
    const { result } = setup();
    act(() => FakeAudio.all[0].healthListener!(true));
    FakeAudio.all[0].resumePlayback.mockResolvedValueOnce(false);

    await act(() => result.current.resumeRemotePlayback());

    expect(result.current.remotePlaybackBlocked).toBe(true);
  });

  it("releases the audio manager on unmount", () => {
    const { unmount } = setup();

    unmount();

    expect(FakeAudio.all[0].destroy).toHaveBeenCalled();
  });
});

describe("local screen share", () => {
  it("adds the track to every peer, shows it locally and announces it", async () => {
    const { result } = setup();
    await fire("room-joined", roster("a", "b"));

    const { track, stream, ok } = await startShare(result);

    expect(ok).toBe(true);
    expect(sessionFor("a").addScreenTrack).toHaveBeenCalledWith(track, stream);
    expect(sessionFor("b").addScreenTrack).toHaveBeenCalledWith(track, stream);
    expect(result.current.screenStreams.get("self")).toBe(stream);
    expect(emitsOf(socket, "screen-share-started")).toHaveLength(1);
  });

  it("includes the share in a session created while sharing", async () => {
    const { result } = setup();
    const { track } = await startShare(result);

    await fire("offer", { from: "late", offer: {} });

    expect(sessionFor("late").options.screenTrack).toBe(track);
  });

  it("reports failure quietly when the user cancels the picker", async () => {
    const { result } = setup();
    stubDisplayMedia(Object.assign(new Error("x"), { name: "NotAllowedError" }));

    await act(async () => {
      expect(await result.current.startScreenShare()).toBe(false);
    });

    expect(console.warn).not.toHaveBeenCalled();
    expect(emitsOf(socket, "screen-share-started")).toEqual([]);
  });

  it("logs any other failure", async () => {
    const { result } = setup();
    stubDisplayMedia(Object.assign(new Error("x"), { name: "NotReadableError" }));

    await act(async () => {
      expect(await result.current.startScreenShare()).toBe(false);
    });

    expect(console.warn).toHaveBeenCalled();
  });

  it("stops the track, removes it from peers, and tells the room and the caller", async () => {
    const onScreenShareStopped = vi.fn();
    const { result } = setup({ onScreenShareStopped });
    await fire("room-joined", roster("a"));
    const { track } = await startShare(result);

    act(() => result.current.stopScreenShare());

    expect(track.stop).toHaveBeenCalled();
    expect(sessionFor("a").removeScreenTrack).toHaveBeenCalled();
    expect(result.current.screenStreams.size).toBe(0);
    expect(emitsOf(socket, "screen-share-stopped")).toHaveLength(1);
    expect(onScreenShareStopped).toHaveBeenCalledOnce();
  });

  it("stops when the browser ends the capture", async () => {
    const onScreenShareStopped = vi.fn();
    const { result } = setup({ onScreenShareStopped });
    const { track } = await startShare(result);

    act(() => track.onended!());

    expect(onScreenShareStopped).toHaveBeenCalledOnce();
  });

  it("re-announces a share across a reconnect, under the new socket id", async () => {
    const { result } = setup();
    const { track, stream } = await startShare(result);
    await fire("disconnect");
    socket.emit.mockClear();
    socket.id = "self-2";

    await fire("room-joined", roster());

    expect(result.current.screenStreams.get("self-2")).toBe(stream);
    expect(result.current.screenStreams.has("self")).toBe(false);
    expect(emitsOf(socket, "screen-share-started")).toHaveLength(1);
    expect(track.stop).not.toHaveBeenCalled();
  });

  it("ends a share if someone else started sharing during the reconnect", async () => {
    const onScreenShareStopped = vi.fn();
    const { result } = setup({ onScreenShareStopped });
    const { track } = await startShare(result);
    await fire("disconnect");
    socket.id = "self-2";
    socket.emit.mockClear();

    await fire("room-joined", { participants: [], screenSharer: "other" });

    expect(track.stop).toHaveBeenCalled();
    expect(onScreenShareStopped).toHaveBeenCalledOnce();
    expect(emitsOf(socket, "screen-share-started")).toEqual([]);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MIC_RESTART_GRACE_MS, PeerSession, type PeerSessionHost } from "./peerSession";

class FakePeerConnection {
  signalingState: RTCSignalingState = "stable";
  connectionState: RTCPeerConnectionState = "new";
  remoteDescription: RTCSessionDescriptionInit | null = null;
  localDescription: RTCSessionDescriptionInit | null = null;
  onicecandidate: unknown = null;
  ontrack: unknown = null;
  onconnectionstatechange: (() => void) | null = null;
  onnegotiationneeded: (() => Promise<void>) | null = null;
  transceivers: unknown[] = [];
  stats = new Map<string, unknown>();
  private listeners: (() => void)[] = [];

  close = vi.fn();
  restartIce = vi.fn();
  addTrack = vi.fn(() => ({ id: "sender" }));
  removeTrack = vi.fn();
  addTransceiver = vi.fn();
  addIceCandidate = vi.fn(async (_c: unknown) => {});
  getSenders = () => [];
  getTransceivers = () => this.transceivers;
  getStats = vi.fn(async () => this.stats);
  addEventListener = (_type: string, fn: () => void) => this.listeners.push(fn);

  setLocalDescription = vi.fn(async (d?: RTCSessionDescriptionInit) => {
    if (d?.type === "rollback") {
      this.signalingState = "stable";
    } else if (this.signalingState === "have-remote-offer") {
      this.localDescription = { type: "answer" };
      this.signalingState = "stable";
    } else {
      this.localDescription = { type: "offer" };
      this.signalingState = "have-local-offer";
    }
  });

  setRemoteDescription = vi.fn(async (d: RTCSessionDescriptionInit) => {
    this.remoteDescription = d;
    this.signalingState = d.type === "offer" ? "have-remote-offer" : "stable";
  });

  fireConnectionState(state: RTCPeerConnectionState) {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }

  fireSignalingStateChange(state: RTCSignalingState) {
    this.signalingState = state;
    const listeners = this.listeners;
    this.listeners = [];
    for (const fn of listeners) fn();
  }
}

const OFFER: RTCSessionDescriptionInit = { type: "offer", sdp: "o" };
const ANSWER: RTCSessionDescriptionInit = { type: "answer", sdp: "a" };
const POLITE_SELF = "z"; // > "b"
const IMPOLITE_SELF = "a"; // < "b"

function setup(opts?: ConstructorParameters<typeof PeerSession>[3]) {
  const pc = new FakePeerConnection();
  const track = { kind: "audio", enabled: true, readyState: "live" };
  const host = {
    emit: vi.fn(),
    getLocalStream: vi.fn(() => ({ getAudioTracks: () => [track] }) as unknown as MediaStream),
    onTrack: vi.fn(),
    onConnectionState: vi.fn(),
    requestRecreate: vi.fn(),
  } satisfies PeerSessionHost;
  const session = new PeerSession("b", pc as unknown as RTCPeerConnection, host, opts);
  return { pc, host, session, track };
}

function emitted(host: { emit: ReturnType<typeof vi.fn> }, event: string) {
  return host.emit.mock.calls.filter(([e]) => e === event);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "debug").mockImplementation(() => {});
  vi.stubGlobal(
    "RTCIceCandidate",
    class {
      constructor(init: RTCIceCandidateInit) {
        Object.assign(this, init);
      }
    },
  );
  vi.stubGlobal(
    "MediaStream",
    class {
      constructor(public tracks: unknown[]) {}
    },
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("retry candidates", () => {
  it("keeps only the newest candidates across repeated failures", async () => {
    const { pc, session } = setup();
    pc.remoteDescription = OFFER;
    pc.addIceCandidate.mockRejectedValue(new Error("stale"));
    for (let i = 0; i < 150; i++) await session.addCandidate({ candidate: `c${i}` });
    pc.addIceCandidate.mockClear();
    pc.addIceCandidate.mockResolvedValue(undefined);

    await session.handleOffer(OFFER, POLITE_SELF);

    const retried = pc.addIceCandidate.mock.calls.map(([c]) => (c as RTCIceCandidateInit).candidate);
    expect(retried).toHaveLength(100);
    expect(retried[0]).toBe("c50");
    expect(retried.at(-1)).toBe("c149");
  });
});

describe("negotiation", () => {
  it("accepts a non-colliding offer and emits the answer", async () => {
    const { pc, host, session } = setup();
    await session.handleOffer(OFFER, POLITE_SELF);
    expect(pc.setRemoteDescription).toHaveBeenCalledWith(OFFER);
    expect(emitted(host, "answer")).toEqual([["answer", { to: "b", answer: { type: "answer" } }]]);
  });

  it("rolls back on collision when polite", async () => {
    const { pc, host, session } = setup();
    pc.signalingState = "have-local-offer";
    await session.handleOffer(OFFER, POLITE_SELF);
    expect(pc.setLocalDescription).toHaveBeenCalledWith({ type: "rollback" });
    expect(emitted(host, "answer")).toHaveLength(1);
  });

  it("ignores a colliding offer when impolite and restarts ICE if its offer goes unanswered", async () => {
    const { pc, host, session } = setup();
    pc.signalingState = "have-local-offer";
    await session.handleOffer(OFFER, IMPOLITE_SELF);
    expect(pc.setRemoteDescription).not.toHaveBeenCalled();
    expect(emitted(host, "answer")).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(4999);
    expect(pc.restartIce).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(pc.restartIce).toHaveBeenCalledTimes(1);
  });

  it("skips the ignored-offer recovery once its offer was answered", async () => {
    const { pc, session } = setup();
    pc.signalingState = "have-local-offer";
    await session.handleOffer(OFFER, IMPOLITE_SELF);
    await session.handleAnswer(ANSWER);
    await vi.advanceTimersByTimeAsync(5000);
    expect(pc.restartIce).not.toHaveBeenCalled();
  });

  it("never interleaves SDP work", async () => {
    const { pc, session } = setup();
    let release = () => {};
    pc.setRemoteDescription.mockImplementationOnce(async (d) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      pc.signalingState = "have-remote-offer";
      pc.remoteDescription = d;
    });

    const offer = session.handleOffer(OFFER, POLITE_SELF);
    await vi.advanceTimersByTimeAsync(0);
    pc.signalingState = "have-local-offer"; // would let the answer apply if it jumped the queue
    const answer = session.handleAnswer(ANSWER);
    await vi.advanceTimersByTimeAsync(0);
    expect(pc.setRemoteDescription).toHaveBeenCalledTimes(1);

    release();
    await offer;
    await answer;
    // The answer ran only after the offer finished, and found the peer stable.
    expect(pc.setRemoteDescription).toHaveBeenCalledTimes(1);
  });

  it("ignores an answer when already stable", async () => {
    const { pc, session } = setup();
    await session.handleAnswer(ANSWER);
    expect(pc.setRemoteDescription).not.toHaveBeenCalled();
  });

  it("re-arms a skipped negotiation until the peer is stable", async () => {
    const { pc, host } = setup();
    pc.signalingState = "have-remote-offer";
    await pc.onnegotiationneeded?.();
    expect(emitted(host, "offer")).toHaveLength(0);

    pc.fireSignalingStateChange("stable");
    await vi.advanceTimersByTimeAsync(0);
    expect(emitted(host, "offer")).toHaveLength(1);
  });
});

describe("candidates", () => {
  it("buffers candidates until there is a remote description", async () => {
    const { pc, session } = setup();
    await session.addCandidate({ candidate: "c1" });
    expect(pc.addIceCandidate).not.toHaveBeenCalled();

    await session.handleOffer(OFFER, POLITE_SELF);
    expect(pc.addIceCandidate).toHaveBeenCalledWith(expect.objectContaining({ candidate: "c1" }));
  });

  it("applies candidates that arrived before the session existed", async () => {
    const { pc, session } = setup({ earlyCandidates: [{ candidate: "early" }] });
    await session.handleOffer(OFFER, POLITE_SELF);
    expect(pc.addIceCandidate).toHaveBeenCalledWith(expect.objectContaining({ candidate: "early" }));
  });

  it("keeps a candidate that failed to apply and retries it on the next flush", async () => {
    const { pc, session } = setup();
    await session.handleOffer(OFFER, POLITE_SELF);
    pc.addIceCandidate.mockRejectedValueOnce(new Error("stale"));
    await session.addCandidate({ candidate: "retry" });
    expect(pc.addIceCandidate).toHaveBeenCalledTimes(1);

    await session.handleOffer(OFFER, POLITE_SELF);
    expect(pc.addIceCandidate).toHaveBeenCalledTimes(2);
    expect(pc.addIceCandidate).toHaveBeenLastCalledWith(expect.objectContaining({ candidate: "retry" }));
  });
});

describe("ICE recovery", () => {
  it("backs off 2s, 4s, 8s, then asks to be recreated", async () => {
    const { pc, host } = setup();
    for (const [i, delay] of [2000, 4000, 8000].entries()) {
      pc.fireConnectionState("failed");
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(pc.restartIce).toHaveBeenCalledTimes(i);
      await vi.advanceTimersByTimeAsync(1);
      expect(pc.restartIce).toHaveBeenCalledTimes(i + 1);
    }
    expect(host.requestRecreate).not.toHaveBeenCalled();

    pc.fireConnectionState("failed");
    expect(host.requestRecreate).toHaveBeenCalledTimes(1);
  });

  it("resets the failure ladder once connected", async () => {
    const { pc, host } = setup();
    for (let i = 0; i < 3; i++) {
      pc.fireConnectionState("failed");
      await vi.advanceTimersByTimeAsync(8000);
    }
    pc.fireConnectionState("connected");
    pc.fireConnectionState("failed");
    expect(host.requestRecreate).not.toHaveBeenCalled();
  });

  it("reports state changes to the host", () => {
    const { pc, host } = setup();
    pc.fireConnectionState("connecting");
    expect(host.onConnectionState).toHaveBeenCalledWith("connecting");
  });

  it("restarts ICE once after a prolonged disconnection", async () => {
    const { pc, session } = setup();
    pc.fireConnectionState("disconnected");
    await vi.advanceTimersByTimeAsync(8000);
    await session.sampleStats();
    expect(pc.restartIce).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await session.sampleStats();
    await session.sampleStats();
    expect(pc.restartIce).toHaveBeenCalledTimes(1);
  });
});

describe("audio recovery", () => {
  function connected(setupResult: ReturnType<typeof setup>) {
    const { pc, session } = setupResult;
    const sender = { track: null, replaceTrack: vi.fn(async () => {}) };
    const transceiver = {
      direction: "recvonly",
      currentDirection: "sendrecv",
      receiver: { track: { kind: "audio" } },
      sender,
    };
    pc.transceivers = [transceiver];
    pc.connectionState = "connected";
    const inbound = { type: "inbound-rtp", kind: "audio", bytesReceived: 100, packetsReceived: 10 };
    const outbound = { type: "outbound-rtp", kind: "audio", bytesSent: 100, packetsSent: 10 };
    pc.stats.set("in", inbound);
    pc.stats.set("out", outbound);
    // A full stall window of flat inbound while outbound keeps flowing.
    const stallInbound = async () => {
      outbound.bytesSent += 10;
      await session.sampleStats();
      await vi.advanceTimersByTimeAsync(15000);
      outbound.bytesSent += 10;
      await session.sampleStats();
    };
    return { transceiver, sender, inbound, stallInbound };
  }

  it("re-syncs the transceiver and restarts ICE on a stalled direction", async () => {
    const s = setup();
    const { transceiver, sender, stallInbound } = connected(s);
    await stallInbound();
    expect(transceiver.direction).toBe("sendrecv");
    expect(sender.replaceTrack).toHaveBeenCalledWith(s.track);
    expect(s.pc.restartIce).toHaveBeenCalledTimes(1);
    expect(s.host.requestRecreate).not.toHaveBeenCalled();
  });

  it("asks to be recreated on the third stall in a direction", async () => {
    const s = setup();
    const { stallInbound } = connected(s);
    await stallInbound();
    await stallInbound();
    expect(s.host.requestRecreate).not.toHaveBeenCalled();
    await stallInbound();
    expect(s.host.requestRecreate).toHaveBeenCalledTimes(1);
  });

  it("clears the ladder when the direction progresses again", async () => {
    const s = setup();
    const { inbound, stallInbound } = connected(s);
    await stallInbound();
    await stallInbound();

    await s.session.sampleStats();
    inbound.bytesReceived += 10;
    await s.session.sampleStats();

    await stallInbound();
    await stallInbound();
    expect(s.host.requestRecreate).not.toHaveBeenCalled();
  });

  it("never recovers on stats the browser does not expose", async () => {
    const s = setup();
    connected(s);
    s.pc.stats.clear();
    await s.session.sampleStats();
    await vi.advanceTimersByTimeAsync(60000);
    await s.session.sampleStats();
    expect(s.pc.restartIce).not.toHaveBeenCalled();
  });
});

describe("dispose", () => {
  it("closes the connection", () => {
    const { pc, session } = setup();
    session.dispose();
    expect(pc.close).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending ICE-restart backoff", async () => {
    const { pc, session } = setup();
    pc.fireConnectionState("failed");
    session.dispose();
    await vi.advanceTimersByTimeAsync(8000);
    expect(pc.restartIce).not.toHaveBeenCalled();
  });

  it("cancels the ignored-offer recovery", async () => {
    const { pc, session } = setup();
    pc.signalingState = "have-local-offer";
    await session.handleOffer(OFFER, IMPOLITE_SELF);
    session.dispose();
    await vi.advanceTimersByTimeAsync(5000);
    expect(pc.restartIce).not.toHaveBeenCalled();
  });

  it("drops SDP work queued before disposal", async () => {
    const { pc, host, session } = setup();
    const offer = session.handleOffer(OFFER, POLITE_SELF);
    session.dispose();
    await offer;
    expect(pc.setRemoteDescription).not.toHaveBeenCalled();
    expect(emitted(host, "answer")).toHaveLength(0);
  });

  it("does not act on stats that resolve after disposal", async () => {
    const { pc, host, session } = setup();
    pc.connectionState = "connected";
    pc.transceivers = [
      { direction: "sendrecv", currentDirection: "sendrecv", receiver: { track: { kind: "audio" } }, sender: { track: null } },
    ];
    pc.stats.set("in", { type: "inbound-rtp", kind: "audio", bytesReceived: 1, packetsReceived: 1 });
    await session.sampleStats();
    await vi.advanceTimersByTimeAsync(15000);

    const sample = session.sampleStats();
    session.dispose();
    await sample;
    expect(pc.restartIce).not.toHaveBeenCalled();
    expect(host.requestRecreate).not.toHaveBeenCalled();
  });
});

describe("audio m-line at creation", () => {
  it("adds the mic track when it is ready", () => {
    const { pc, track } = setup();

    expect(pc.addTrack).toHaveBeenCalledWith(track, expect.anything());
    expect(pc.addTransceiver).not.toHaveBeenCalled();
  });

  it("adds an empty sendrecv transceiver when it isn't, so audio can attach later", () => {
    const pc = new FakePeerConnection();
    const host = {
      emit: vi.fn(),
      getLocalStream: vi.fn(() => null),
      onTrack: vi.fn(),
      onConnectionState: vi.fn(),
      requestRecreate: vi.fn(),
    } satisfies PeerSessionHost;

    new PeerSession("b", pc as unknown as RTCPeerConnection, host);

    expect(pc.addTransceiver).toHaveBeenCalledWith("audio", { direction: "sendrecv" });
    expect(pc.addTrack).not.toHaveBeenCalled();
  });

  it("adds an in-progress screen share to a new peer", () => {
    const screenTrack = { kind: "video" } as unknown as MediaStreamTrack;
    const { pc } = setup({ screenTrack });

    expect(pc.addTrack).toHaveBeenCalledWith(screenTrack, expect.anything());
  });
});

describe("browser events", () => {
  it("relays local candidates to the peer", () => {
    const { pc, host } = setup();
    const candidate = { toJSON: () => ({ candidate: "c" }) };

    (pc.onicecandidate as (e: unknown) => void)({ candidate });

    expect(emitted(host, "ice-candidate")).toEqual([["ice-candidate", { to: "b", candidate: { candidate: "c" } }]]);
  });

  it("doesn't relay the end-of-candidates event", () => {
    const { pc, host } = setup();

    (pc.onicecandidate as (e: unknown) => void)({ candidate: null });

    expect(emitted(host, "ice-candidate")).toEqual([]);
  });

  it("hands remote tracks to the host", () => {
    const { pc, host } = setup();
    const event = { track: { kind: "audio" } };

    (pc.ontrack as (e: unknown) => void)(event);

    expect(host.onTrack).toHaveBeenCalledWith(event);
  });
});

describe("attachLocalTrack", () => {
  const newTrack = { kind: "audio" } as unknown as MediaStreamTrack;
  const stream = {} as MediaStream;
  const emptyAudioTransceiver = (direction = "sendrecv") => ({
    direction,
    sender: { track: null, replaceTrack: vi.fn(async () => {}) },
    receiver: { track: { kind: "audio" } },
  });

  // Regression: an empty transceiver's sender has no track to match on, which fell
  // through to addTrack, added a second m-line and left the first one dead.
  it("fills an empty audio transceiver instead of adding a second m-line", () => {
    const { pc, session } = setup();
    const transceiver = emptyAudioTransceiver();
    pc.transceivers = [transceiver];
    pc.addTrack.mockClear();

    session.attachLocalTrack(newTrack, stream);

    expect(transceiver.sender.replaceTrack).toHaveBeenCalledWith(newTrack);
    expect(pc.addTrack).not.toHaveBeenCalled();
  });

  // Regression: Firefox negotiated before the mic (restricted ICE candidates), ICE
  // failed, and the joiner stayed unheard after the restart. Gather again soon.
  it("restarts ICE when a sender negotiated before the mic still isn't connected after a grace period", () => {
    const { pc, session } = setup();
    pc.transceivers = [emptyAudioTransceiver()];
    pc.localDescription = { type: "offer" };
    pc.connectionState = "connecting";

    session.attachLocalTrack(newTrack, stream);
    vi.advanceTimersByTime(MIC_RESTART_GRACE_MS - 1);
    expect(pc.restartIce).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

    expect(pc.restartIce).toHaveBeenCalledOnce();
  });

  // Regression: the restart ran at once in every browser, disrupting connections about to succeed.
  it("leaves a connection that succeeds within the grace period alone", () => {
    const { pc, session } = setup();
    pc.transceivers = [emptyAudioTransceiver()];
    pc.localDescription = { type: "offer" };
    pc.connectionState = "connecting";

    session.attachLocalTrack(newTrack, stream);
    pc.connectionState = "connected";
    vi.advanceTimersByTime(MIC_RESTART_GRACE_MS);

    expect(pc.restartIce).not.toHaveBeenCalled();
  });

  it("doesn't restart ICE for a connected peer, an unnegotiated one, or a device change", () => {
    const connected = setup();
    connected.pc.transceivers = [emptyAudioTransceiver()];
    connected.pc.localDescription = { type: "offer" };
    connected.pc.connectionState = "connected";
    connected.session.attachLocalTrack(newTrack, stream);

    const fresh = setup();
    fresh.pc.transceivers = [emptyAudioTransceiver()];
    fresh.session.attachLocalTrack(newTrack, stream);

    const deviceChange = setup();
    const sender = { track: { kind: "audio" }, replaceTrack: vi.fn(async () => {}) };
    deviceChange.pc.getSenders = (() => [sender]) as unknown as typeof deviceChange.pc.getSenders;
    deviceChange.pc.localDescription = { type: "offer" };
    deviceChange.pc.connectionState = "connecting";
    deviceChange.session.attachLocalTrack(newTrack, stream);
    vi.advanceTimersByTime(MIC_RESTART_GRACE_MS);

    expect(connected.pc.restartIce).not.toHaveBeenCalled();
    expect(fresh.pc.restartIce).not.toHaveBeenCalled();
    expect(deviceChange.pc.restartIce).not.toHaveBeenCalled();
  });

  it("restores sendrecv on a transceiver left in another direction", () => {
    const { pc, session } = setup();
    const transceiver = emptyAudioTransceiver("recvonly");
    pc.transceivers = [transceiver];

    session.attachLocalTrack(newTrack, stream);

    expect(transceiver.direction).toBe("sendrecv");
  });

  it("replaces the track on an existing audio sender when the device changes", () => {
    const { pc, session } = setup();
    const sender = { track: { kind: "audio" }, replaceTrack: vi.fn(async () => {}) };
    pc.getSenders = (() => [sender]) as unknown as typeof pc.getSenders;
    pc.addTrack.mockClear();

    session.attachLocalTrack(newTrack, stream);

    expect(sender.replaceTrack).toHaveBeenCalledWith(newTrack);
    expect(pc.addTrack).not.toHaveBeenCalled();
  });

  it("doesn't mistake the screen-share sender for the audio one", () => {
    const { pc, session } = setup();
    const screenSender = { track: { kind: "video" }, replaceTrack: vi.fn(async () => {}) };
    pc.getSenders = (() => [screenSender]) as unknown as typeof pc.getSenders;
    pc.addTrack.mockClear();

    session.attachLocalTrack(newTrack, stream);

    expect(screenSender.replaceTrack).not.toHaveBeenCalled();
    expect(pc.addTrack).toHaveBeenCalledWith(newTrack, stream);
  });

  it("adds the track when there is nothing to reuse", () => {
    const { pc, session } = setup();
    pc.addTrack.mockClear();

    session.attachLocalTrack(newTrack, stream);

    expect(pc.addTrack).toHaveBeenCalledWith(newTrack, stream);
  });

  it("survives a failure from either path", async () => {
    const { pc, session } = setup();
    pc.addTrack.mockImplementationOnce(() => {
      throw new Error("closed");
    });
    expect(() => session.attachLocalTrack(newTrack, stream)).not.toThrow();

    const transceiver = emptyAudioTransceiver();
    transceiver.sender.replaceTrack.mockRejectedValueOnce(new Error("bad"));
    pc.transceivers = [transceiver];
    session.attachLocalTrack(newTrack, stream);
    await vi.advanceTimersByTimeAsync(0);

    expect(console.warn).toHaveBeenCalled();
  });

  it("does nothing once the connection has closed", () => {
    const { pc, session } = setup();
    pc.connectionState = "closed";
    pc.addTrack.mockClear();

    session.attachLocalTrack(newTrack, stream);

    expect(pc.addTrack).not.toHaveBeenCalled();
  });
});

describe("screen track", () => {
  const screenTrack = { kind: "video" } as unknown as MediaStreamTrack;

  it("removes the sender it added, once", () => {
    const { pc, session } = setup();
    session.addScreenTrack(screenTrack, {} as MediaStream);
    const sender = pc.addTrack.mock.results.at(-1)!.value;

    session.removeScreenTrack();
    session.removeScreenTrack();

    expect(pc.removeTrack).toHaveBeenCalledTimes(1);
    expect(pc.removeTrack).toHaveBeenCalledWith(sender);
  });

  it("has nothing to remove when no share was added", () => {
    const { pc, session } = setup();

    session.removeScreenTrack();

    expect(pc.removeTrack).not.toHaveBeenCalled();
  });

  it("survives a sender that is already gone", () => {
    const { pc, session } = setup();
    session.addScreenTrack(screenTrack, {} as MediaStream);
    pc.removeTrack.mockImplementationOnce(() => {
      throw new Error("gone");
    });

    expect(() => session.removeScreenTrack()).not.toThrow();
  });
});

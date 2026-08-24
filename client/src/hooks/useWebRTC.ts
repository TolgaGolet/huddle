import { useEffect, useRef, useCallback, useState } from "react";
import type { Socket } from "socket.io-client";
import { RemoteAudioManager } from "../lib/audioEngine";
import { huddleLog, huddleWarn, huddleDebugEnabled } from "../lib/huddleLog";

// ICE servers. STUN-only by default, which works for most home/office NATs.
// For symmetric NATs, carrier-grade NAT, or strict corporate firewalls, set
// `VITE_ICE_SERVERS` (JSON `RTCConfiguration.iceServers` array) at build time
// to include TURN servers, e.g.:
//   VITE_ICE_SERVERS='[{"urls":"turn:turn.example.com:3478","username":"...","credential":"..."}]'
// Without TURN, users behind restrictive NATs can establish signaling but not
// media, which presents as "connected but no audio" and is unrelated to the
// negotiation races fixed here.
const ICE_SERVERS: RTCConfiguration = (() => {
  const env = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;
  const raw = env?.VITE_ICE_SERVERS;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as RTCIceServer[];
      if (Array.isArray(parsed) && parsed.length > 0) {
        return { iceServers: parsed };
      }
    } catch {
      // Fall through to default on malformed env.
    }
  }
  return {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
    ],
  };
})();

interface UseWebRTCOptions {
  socket: Socket | null;
  localStream: MediaStream | null;
  onScreenShareStopped?: () => void;
  /**
   * Invoked once (per socket) after the WebRTC signaling listeners
   * (`room-joined`, `offer`, `answer`, `ice-candidate`, participant/screen
   * events) have been registered on the active socket. The caller may use this
   * to trigger the room join, ensuring no `room-joined`/offer/ICE event can
   * arrive before these handlers exist.
   */
  onSignalingReady?: () => void;
}

export function useWebRTC({ socket, localStream, onScreenShareStopped, onSignalingReady }: UseWebRTCOptions) {
  const peersRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const remoteAudioRef = useRef(new RemoteAudioManager());
  const localStreamRef = useRef<MediaStream | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const onScreenShareStoppedRef = useRef(onScreenShareStopped);
  const onSignalingReadyRef = useRef(onSignalingReady);
  const [remoteAnalysers, setRemoteAnalysers] = useState<Map<string, AnalyserNode>>(new Map());
  const [screenStreams, setScreenStreams] = useState<Map<string, MediaStream>>(new Map());
  const screenTrackRef = useRef<MediaStreamTrack | null>(null);
  const screenSendersRef = useRef<Map<string, RTCRtpSender>>(new Map());
  const makingOfferRef = useRef<Map<string, boolean>>(new Map());
  const pendingCandidatesRef = useRef<Map<string, RTCIceCandidateInit[]>>(new Map());
  // Serializes SDP operations per peer (setLocalDescription/setRemoteDescription
  // and answer creation) so concurrent offers cannot interleave.
  const sdpLockRef = useRef<Map<string, Promise<unknown>>>(new Map());

  // ICE recovery state. `restartIce()` only schedules a new negotiation; the
  // actual offer/answer exchange happens through `onnegotiationneeded`. We
  // guard against re-entrant restarts and track how long a peer has been
  // disconnected so we can escalate after a bounded timeout.
  const iceRestartRef = useRef<Map<string, boolean>>(new Map());
  const disconnectedSinceRef = useRef<Map<string, number>>(new Map());
  const statsTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Per-peer last-seen audio activity counters, used by the recovery watchdog
  // to detect a connected-but-silent pair (stuck audio m-line).
  const lastAudioBytesRef = useRef<Map<string, { in: number; out: number; at: number }>>(new Map());
  const silentSinceRef = useRef<Map<string, number>>(new Map());

  localStreamRef.current = localStream;
  socketRef.current = socket;
  onScreenShareStoppedRef.current = onScreenShareStopped;
  onSignalingReadyRef.current = onSignalingReady;

  const removePeer = useCallback((peerId: string) => {
    const pc = peersRef.current.get(peerId);
    if (pc) {
      pc.close();
      peersRef.current.delete(peerId);
    }
    makingOfferRef.current.delete(peerId);
    pendingCandidatesRef.current.delete(peerId);
    sdpLockRef.current.delete(peerId);
    iceRestartRef.current.delete(peerId);
    disconnectedSinceRef.current.delete(peerId);
    lastAudioBytesRef.current.delete(peerId);
    silentSinceRef.current.delete(peerId);
    remoteAudioRef.current.removeStream(peerId);
    screenSendersRef.current.delete(peerId);
    setRemoteAnalysers(new Map(remoteAudioRef.current.getAnalysers()));
    setScreenStreams((prev) => {
      const next = new Map(prev);
      next.delete(peerId);
      return next;
    });
  }, []);

  // Serialize SDP mutations per peer. `onnegotiationneeded`, `handleOffer`, and
  // `handleAnswer` all touch local/remote descriptions; letting them interleave
  // (e.g. an answer landing while a polite rollback is in flight) is what leaves
  // a peer stuck in `have-local-offer`/`have-remote-offer` with no audio.
  const withSdpLock = useCallback(<T,>(peerId: string, fn: () => Promise<T>): Promise<T> => {
    const prev = sdpLockRef.current.get(peerId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    sdpLockRef.current.set(peerId, next.catch(() => undefined));
    return next;
  }, []);

  const resetAllPeers = useCallback(() => {
    for (const [id] of peersRef.current) {
      removePeer(id);
    }
    // `removePeer` mutates the map during iteration; clear any stragglers.
    if (peersRef.current.size) peersRef.current.clear();
    pendingCandidatesRef.current.clear();
    makingOfferRef.current.clear();
    sdpLockRef.current.clear();
    iceRestartRef.current.clear();
    disconnectedSinceRef.current.clear();
    screenSendersRef.current.clear();
    lastAudioBytesRef.current.clear();
    silentSinceRef.current.clear();
  }, [removePeer]);

  const createPeer = useCallback(
    (peerId: string, _initiator: boolean) => {
      const sock = socketRef.current;
      if (!sock) return null;

      if (peersRef.current.has(peerId)) {
        return peersRef.current.get(peerId)!;
      }

      const pc = new RTCPeerConnection(ICE_SERVERS);
      peersRef.current.set(peerId, pc);

      const stream = localStreamRef.current;
      // Deterministic audio m-line: if we have a mic track, add it as a
      // `sendrecv` transceiver BEFORE the first setLocalDescription so the
      // initial offer always carries audio. If the mic is not ready yet,
      // create an explicit `sendrecv` (recv-capable) audio transceiver so the
      // remote side still negotiates an audio m-line we can later attach a
      // track to via replaceTrack — avoiding a stuck/absent audio m-line.
      const audioTrack = stream?.getAudioTracks()[0];
      if (audioTrack) {
        pc.addTrack(audioTrack, stream);
      } else {
        pc.addTransceiver("audio", { direction: "sendrecv" });
      }
      huddleLog("peer", { event: "create", peerId, addedAudio: !!audioTrack });

      if (screenTrackRef.current) {
        const screenStream = new MediaStream([screenTrackRef.current]);
        const sender = pc.addTrack(screenTrackRef.current, screenStream);
        screenSendersRef.current.set(peerId, sender);
      }

      pc.onicecandidate = (e) => {
        if (e.candidate) {
          sock.emit("ice-candidate", { to: peerId, candidate: e.candidate.toJSON() });
        }
      };

      pc.ontrack = (e) => {
        const s = e.streams[0];
        if (!s) return;

        if (e.track.kind === "audio") {
          remoteAudioRef.current.addStream(peerId, s);
          setRemoteAnalysers(new Map(remoteAudioRef.current.getAnalysers()));
        } else if (e.track.kind === "video") {
          setScreenStreams((prev) => new Map(prev).set(peerId, s));
          e.track.onended = () => {
            setScreenStreams((prev) => {
              const next = new Map(prev);
              next.delete(peerId);
              return next;
            });
          };
        }
      };

      pc.onconnectionstatechange = () => {
        const state = pc.connectionState;
        huddleLog("connection", { peerId, state });
        if (state === "failed") {
          // Hard failure: restart ICE immediately (guarded against re-entry).
          if (!iceRestartRef.current.get(peerId)) {
            iceRestartRef.current.set(peerId, true);
            try {
              pc.restartIce();
            } catch {
              /* restart may throw if negotiation is in flight */
            }
            // Clear the flag once negotiation completes (see onnegotiationneeded).
            setTimeout(() => iceRestartRef.current.set(peerId, false), 2000);
          }
          disconnectedSinceRef.current.delete(peerId);
        } else if (state === "disconnected") {
          // Track when we became disconnected so the stats sampler can
          // escalate to an ICE restart after a bounded timeout.
          if (!disconnectedSinceRef.current.has(peerId)) {
            disconnectedSinceRef.current.set(peerId, Date.now());
          }
        } else {
          // connected / connecting / closed / new
          disconnectedSinceRef.current.delete(peerId);
        }
      };

      pc.onnegotiationneeded = async () => {
        // Serialize against in-flight SDP mutations on this peer.
        await withSdpLock(peerId, async () => {
          try {
            // Idempotency/state guard: never create a local offer while the
            // signaling state is mid-negotiation (e.g. have-remote-offer after
            // a rollback). Doing so throws InvalidStateError and can leave the
            // audio m-line unnegotiated.
            if (pc.signalingState !== "stable") {
              huddleLog("negotiate", { peerId, event: "skip-offer", signalingState: pc.signalingState });
              return;
            }
            makingOfferRef.current.set(peerId, true);
            await pc.setLocalDescription();
            huddleLog("negotiate", {
              peerId,
              event: "offer",
              signalingState: pc.signalingState,
              hasAudioSender: pc.getSenders().some((s) => s.track?.kind === "audio"),
            });
            sock.emit("offer", { to: peerId, offer: pc.localDescription });
          } catch (err) {
            huddleWarn("negotiate", { peerId, event: "offer-error", error: String(err) });
          } finally {
            makingOfferRef.current.set(peerId, false);
          }
        });
      };

      return pc;
    },
    [removePeer, withSdpLock],
  );

  useEffect(() => {
    if (!socket) return;
    const myId = socket.id;

    const flushCandidates = async (peerId: string) => {
      const pc = peersRef.current.get(peerId);
      const candidates = pendingCandidatesRef.current.get(peerId);
      if (!pc || !candidates) return;
      pendingCandidatesRef.current.delete(peerId);
      for (const c of candidates) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(c));
        } catch { /* stale candidate */ }
      }
    };

    const handleOffer = async ({ from, offer }: { from: string; offer: RTCSessionDescriptionInit }) => {
      await withSdpLock(from, async () => {
        try {
          let pc = peersRef.current.get(from);
          if (!pc) {
            pc = createPeer(from, false) ?? undefined;
          }
          if (!pc) return;

          const isPolite = myId! > from;
          const offerCollision = makingOfferRef.current.get(from) || pc.signalingState !== "stable";

          if (offerCollision) {
            if (!isPolite) {
              // Impolite side: keep our offer, ignore the conflicting inbound offer
              // and any candidates that belong to it.
              huddleLog("negotiate", { from, event: "ignore-offer", isPolite, signalingState: pc.signalingState });
              return;
            }
            // Polite side: roll back our local offer so we can accept theirs.
            try {
              await pc.setLocalDescription({ type: "rollback" });
            } catch (err) {
              // Rollback can fail if state is already stable/closed; continue best-effort.
              huddleWarn("negotiate", { from, event: "rollback-failed", error: String(err) });
            }
          }

          await pc.setRemoteDescription(offer);
          await flushCandidates(from);
          await pc.setLocalDescription();
          huddleLog("negotiate", {
            from,
            event: "answer",
            signalingState: pc.signalingState,
            hasAudioSender: pc.getSenders().some((s) => s.track?.kind === "audio"),
          });
          socket.emit("answer", { to: from, answer: pc.localDescription });
        } catch (err) {
          console.error("Error handling offer from", from, ":", err);
        }
      });
    };

    const handleAnswer = async ({ from, answer }: { from: string; answer: RTCSessionDescriptionInit }) => {
      await withSdpLock(from, async () => {
        try {
          const pc = peersRef.current.get(from);
          if (!pc) return;
          if (pc.signalingState === "stable") {
            huddleLog("negotiate", { from, event: "answer-ignored-stable" });
            return;
          }
          await pc.setRemoteDescription(answer);
          await flushCandidates(from);
          huddleLog("negotiate", { from, event: "answer-applied", signalingState: pc.signalingState });
        } catch (err) {
          huddleWarn("negotiate", { from, event: "answer-error", error: String(err) });
        }
      });
    };

    const handleIceCandidate = async ({ from, candidate }: { from: string; candidate: RTCIceCandidateInit }) => {
      const pc = peersRef.current.get(from);
      if (!pc || !pc.remoteDescription) {
        if (!pendingCandidatesRef.current.has(from)) {
          pendingCandidatesRef.current.set(from, []);
        }
        pendingCandidatesRef.current.get(from)!.push(candidate);
        return;
      }
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch {
        // Ignore candidates that arrive after rollback
      }
    };

    const handleParticipantJoined = (_data: { id: string }) => {
      // The newly joined client creates the peer and the initial offer for each
      // existing participant in `handleRoomJoined`. Existing participants only
      // receive this UI notification and then the newcomer's `offer`, which
      // lazily creates the answering peer in `handleOffer`. This eliminates
      // the initial-offer glare where both sides negotiated at once.
    };

    const handleParticipantLeft = ({ id }: { id: string }) => {
      removePeer(id);
    };

    const handleRoomJoined = ({ participants }: { participants: { id: string }[] }) => {
      // The joining client is the sole initial offerer for every existing
      // participant in the roster. Existing clients will answer our offer.
      const micReady = !!localStreamRef.current;
      huddleLog("room-joined", {
        rosterSize: participants.length,
        micReady,
        roster: participants.map((p) => p.id),
      });
      for (const p of participants) {
        // Always create the peer immediately so receive-audio, video, and
        // screen share work even before (or without) a microphone. The audio
        // m-line is deterministic regardless of mic readiness: `createPeer`
        // adds a `sendrecv` audio transceiver whether or not a track exists,
        // and the track is attached later via `replaceTrack` (no second
        // renegotiation required).
        createPeer(p.id, true);
      }
    };

    const handleScreenShareStopped = ({ id }: { id: string }) => {
      setScreenStreams((prev) => {
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
    };

    // When our own socket transport drops, the server has already removed our
    // stale socket id from the room and broadcast `participant-left` to others.
    // Our existing `RTCPeerConnection`s are bound to those now-gone ids and to
    // transport state that will not survive the reconnect, so close everything
    // and let the fresh `room-joined` (after rejoin) recreate connections.
    const handleLocalDisconnect = () => {
      resetAllPeers();
    };

    socket.on("offer", handleOffer);
    socket.on("answer", handleAnswer);
    socket.on("ice-candidate", handleIceCandidate);
    socket.on("participant-joined", handleParticipantJoined);
    socket.on("participant-left", handleParticipantLeft);
    socket.on("room-joined", handleRoomJoined);
    socket.on("screen-share-stopped", handleScreenShareStopped);
    socket.on("disconnect", handleLocalDisconnect);

    // Signal readiness once all signaling handlers are installed so the caller
    // can safely emit `join-room` without racing `room-joined`/offer/ICE.
    onSignalingReadyRef.current?.();

    return () => {
      socket.off("offer", handleOffer);
      socket.off("answer", handleAnswer);
      socket.off("ice-candidate", handleIceCandidate);
      socket.off("participant-joined", handleParticipantJoined);
      socket.off("participant-left", handleParticipantLeft);
      socket.off("room-joined", handleRoomJoined);
      socket.off("screen-share-stopped", handleScreenShareStopped);
      socket.off("disconnect", handleLocalDisconnect);
      for (const [id] of peersRef.current) {
        removePeer(id);
      }
    };
  }, [socket, createPeer, removePeer, withSdpLock, resetAllPeers]);

  useEffect(() => {
    const mgr = remoteAudioRef.current;
    return () => mgr.destroy();
  }, []);

  useEffect(() => {
    if (!localStream) return;
    const newTrack = localStream.getAudioTracks()[0];
    if (!newTrack) return;

    for (const [peerId, pc] of peersRef.current) {
      if (pc.connectionState === "closed") continue;
      const audioSenders = pc.getSenders().filter((s) => s.track?.kind === "audio");
      if (audioSenders.length > 0) {
        // If the sender already has a track (set by the previous effect), replace it.
        // If it was created empty (addTransceiver without a track), replaceTrack
        // succeeds without renegotiation.
        huddleLog("audio", { peerId, event: "replaceTrack" });
        audioSenders[0].replaceTrack(newTrack).catch((err) => {
          huddleWarn("audio", { peerId, event: "replaceTrack-error", error: String(err) });
        });
      } else {
        try {
          pc.addTrack(newTrack, localStream);
          huddleLog("audio", { peerId, event: "addTrack" });
        } catch (err) {
          huddleWarn("audio", { peerId, event: "addTrack-error", error: String(err) });
        }
      }
    }
  }, [localStream]);

  const stopScreenShare = useCallback(() => {
    if (screenTrackRef.current) {
      screenTrackRef.current.stop();
      screenTrackRef.current = null;
    }

    for (const [peerId, sender] of screenSendersRef.current) {
      const pc = peersRef.current.get(peerId);
      if (pc) {
        try { pc.removeTrack(sender); } catch { /* already removed */ }
      }
    }
    screenSendersRef.current.clear();

    const localId = socketRef.current?.id;
    if (localId) {
      setScreenStreams((prev) => {
        const next = new Map(prev);
        next.delete(localId);
        return next;
      });
    }

    socketRef.current?.emit("screen-share-stopped");
    onScreenShareStoppedRef.current?.();
  }, []);

  const startScreenShare = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      const track = stream.getVideoTracks()[0];
      screenTrackRef.current = track;

      for (const [peerId, pc] of peersRef.current) {
        const sender = pc.addTrack(track, stream);
        screenSendersRef.current.set(peerId, sender);
      }

      const localId = socketRef.current?.id;
      if (localId) {
        setScreenStreams((prev) => new Map(prev).set(localId, stream));
      }

      track.onended = () => {
        stopScreenShare();
      };

      socketRef.current?.emit("screen-share-started");
      return true;
    } catch {
      return false;
    }
  }, [stopScreenShare]);

  const setRemoteVolume = useCallback((peerId: string, volume: number) => {
    remoteAudioRef.current.setVolume(peerId, volume);
  }, []);

  /**
   * Periodically sample WebRTC stats for each peer and escalate ICE recovery
   * when a peer stays disconnected beyond a bounded timeout. All stat fields
   * are feature-detected because support differs across Chromium, Firefox,
   * and Safari. Samples are logged to the console as structured diagnostics;
   * no media content is captured.
   */
  useEffect(() => {
    const DISCONNECT_ESCALATION_MS = 8000;
    const SAMPLE_INTERVAL_MS = 5000;

    const sampleStats = async (peerId: string, pc: RTCPeerConnection) => {
      // Escalate prolonged disconnection to an ICE restart.
      const since = disconnectedSinceRef.current.get(peerId);
      if (since !== undefined && Date.now() - since > DISCONNECT_ESCALATION_MS) {
        if (!iceRestartRef.current.get(peerId)) {
          iceRestartRef.current.set(peerId, true);
          try {
            pc.restartIce();
          } catch {
            /* negotiation may be in flight */
          }
          setTimeout(() => iceRestartRef.current.set(peerId, false), 2000);
        }
        return;
      }

      if (pc.connectionState !== "connected") return;

      let report: RTCStatsReport;
      try {
        report = await pc.getStats();
      } catch {
        return;
      }

      const diag: Record<string, unknown> = { peerId, state: pc.connectionState };
      let inBytes = 0;
      let outBytes = 0;
      let inPackets = 0;
      let outPackets = 0;
      let inLost = 0;
      report.forEach((s) => {
        if (s.type === "outbound-rtp" && (s as RTCOutboundRtpStreamStats).kind === "audio") {
          const r = s as RTCOutboundRtpStreamStats & Record<string, unknown>;
          outBytes = r.bytesSent ?? 0;
          outPackets = r.packetsSent ?? 0;
          diag.outbound = {
            packetsSent: r.packetsSent,
            bytesSent: r.bytesSent,
          };
        } else if (s.type === "inbound-rtp" && (s as RTCInboundRtpStreamStats).kind === "audio") {
          const r = s as RTCInboundRtpStreamStats & Record<string, unknown>;
          inBytes = r.bytesReceived ?? 0;
          inPackets = r.packetsReceived ?? 0;
          inLost = r.packetsLost ?? 0;
          diag.inbound = {
            packetsReceived: r.packetsReceived,
            packetsLost: r.packetsLost,
            jitter: r.jitter,
            bytesReceived: r.bytesReceived,
            concealmentEvents: r.concealmentEvents,
            concealedSamples: r.concealedSamples,
            totalAudioEnergy: r.totalAudioEnergy,
            audioLevel: r.audioLevel,
          };
        } else if (s.type === "candidate-pair" && (s as RTCIceCandidatePairStats).nominated) {
          const r = s as RTCIceCandidatePairStats & Record<string, unknown>;
          diag.transport = {
            currentRoundTripTime: r.currentRoundTripTime,
            bytesSent: r.bytesSent,
            bytesReceived: r.bytesReceived,
          };
        } else if (s.type === "remote-inbound-rtp" && (s as RTCInboundRtpStreamStats).kind === "audio") {
          const r = s as RTCInboundRtpStreamStats & Record<string, unknown>;
          diag.remoteInbound = {
            roundTripTime: r.roundTripTime,
            packetsLost: r.packetsLost,
            jitter: r.jitter,
            fractionLost: r.fractionLost,
          };
        }
      });

      // --- Recovery watchdog: detect a connected-but-silent pair ---------
      // A stuck audio m-line keeps `connectionState === "connected"` (the ICE
      // transport and any video m-line still work) while audio is dead in both
      // directions. Track per-peer audio byte counters over time; if a peer
      // stays connected with no audio progress for a bounded window, force a
      // full renegotiation of that peer's audio (restartIce + re-sync track).
      const now = Date.now();
      const prev = lastAudioBytesRef.current.get(peerId);
      const progressed = !prev || inBytes > prev.in || outBytes > prev.out;
      lastAudioBytesRef.current.set(peerId, { in: inBytes, out: outBytes, at: now });
      if (!progressed && !silentSinceRef.current.has(peerId)) {
        silentSinceRef.current.set(peerId, now);
      } else if (progressed) {
        silentSinceRef.current.delete(peerId);
      }

      const SILENT_RENEGOTIATE_MS = 15000;
      const silentSince = silentSinceRef.current.get(peerId);
      if (silentSince !== undefined && now - silentSince > SILENT_RENEGOTIATE_MS) {
        silentSinceRef.current.delete(peerId);
        lastAudioBytesRef.current.delete(peerId);
        huddleWarn("watchdog", {
          peerId,
          event: "silent-pair-renegotiate",
          inBytes,
          outBytes,
          inPackets,
          outPackets,
          inLost,
        });
        try {
          // Ensure every audio transceiver is sendrecv and carrying our track,
          // then force a fresh negotiation via ICE restart.
          const track = localStreamRef.current?.getAudioTracks()[0];
          for (const tx of pc.getTransceivers()) {
            if (tx.receiver.track.kind === "audio") {
              if (tx.direction !== "sendrecv") {
                try { tx.direction = "sendrecv"; } catch { /* ignore */ }
              }
              if (track && !tx.sender.track) {
                tx.sender.replaceTrack(track).catch(() => {
                  /* ignore — restartIce will retry */
                });
              }
            }
          }
          pc.restartIce();
        } catch (err) {
          huddleWarn("watchdog", { peerId, event: "renegotiate-error", error: String(err) });
        }
      }

      // Structured diagnostic log. In development (or when HUDDLE debug is
      // enabled) log every sample; in production emit a reduced-rate summary
      // line so silent-pair diagnosis is possible from shipped logs.
      const isDev =
        (import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV === true;
      if (isDev || huddleDebugEnabled()) {
        console.debug("[huddle:webrtc-stats]", diag);
      }
    };

    statsTimerRef.current = setInterval(() => {
      for (const [peerId, pc] of peersRef.current) {
        void sampleStats(peerId, pc);
      }
    }, SAMPLE_INTERVAL_MS);

    return () => {
      if (statsTimerRef.current) {
        clearInterval(statsTimerRef.current);
        statsTimerRef.current = null;
      }
    };
  }, []);

  return {
    remoteAnalysers,
    screenStreams,
    startScreenShare,
    stopScreenShare,
    setRemoteVolume,
  };
}

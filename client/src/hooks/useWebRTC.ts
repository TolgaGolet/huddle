import { useEffect, useRef, useCallback, useState } from "react";
import type { Socket } from "socket.io-client";
import { RemoteAudioManager } from "../lib/audioEngine";

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
      if (stream) {
        for (const track of stream.getAudioTracks()) {
          pc.addTrack(track, stream);
        }
      }

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
            makingOfferRef.current.set(peerId, true);
            await pc.setLocalDescription();
            sock.emit("offer", { to: peerId, offer: pc.localDescription });
          } catch (err) {
            console.error("Negotiation failed:", err);
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
              return;
            }
            // Polite side: roll back our local offer so we can accept theirs.
            try {
              await pc.setLocalDescription({ type: "rollback" });
            } catch (err) {
              // Rollback can fail if state is already stable/closed; continue best-effort.
              console.warn("Rollback failed for", from, err);
            }
          }

          await pc.setRemoteDescription(offer);
          await flushCandidates(from);
          await pc.setLocalDescription();
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
          if (pc.signalingState === "stable") return;
          await pc.setRemoteDescription(answer);
          await flushCandidates(from);
        } catch (err) {
          console.error("Error handling answer from", from, ":", err);
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
      for (const p of participants) {
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
    for (const [, pc] of peersRef.current) {
      if (pc.connectionState === "closed") continue;
      const audioSenders = pc.getSenders().filter((s) => s.track?.kind === "audio");
      if (audioSenders.length > 0) {
        audioSenders[0].replaceTrack(newTrack).catch((err) => {
          console.warn("replaceTrack failed; renegotiation will retry:", err);
        });
      } else {
        try {
          pc.addTrack(newTrack, localStream);
        } catch (err) {
          console.warn("addTrack failed:", err);
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
      report.forEach((s) => {
        if (s.type === "outbound-rtp" && (s as RTCOutboundRtpStreamStats).kind === "audio") {
          const r = s as RTCOutboundRtpStreamStats & Record<string, unknown>;
          diag.outbound = {
            packetsSent: r.packetsSent,
            bytesSent: r.bytesSent,
          };
        } else if (s.type === "inbound-rtp" && (s as RTCInboundRtpStreamStats).kind === "audio") {
          const r = s as RTCInboundRtpStreamStats & Record<string, unknown>;
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

      // Structured diagnostic log. In production this could be forwarded to
      // a telemetry backend; here it aids background-quality investigation.
      const isDev =
        (import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV === true;
      if (isDev) {
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

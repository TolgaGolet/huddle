import { useEffect, useRef, useCallback, useState } from "react";
import type { Socket } from "socket.io-client";
import { RemoteAudioManager } from "../lib/audioEngine";
import { DirectionalAudioWatchdog, type Direction } from "../lib/audioWatchdog";
import { huddleLog, huddleWarn } from "../lib/huddleLog";

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
  // True when the remote-playback AudioContext is suspended (autoplay block /
  // OS interruption) — surfaced so the UI can offer a gesture-based recovery.
  const [remotePlaybackBlocked, setRemotePlaybackBlocked] = useState(false);
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
  // Directional audio-stall watchdog. Tracks inbound and outbound RTP progress
  // INDEPENDENTLY so a flowing direction can never mask a stalled one (the old
  // `inBytes > prev.in || outBytes > prev.out` check let one-way audio persist
  // forever). Pure logic lives in `lib/audioWatchdog.ts` and is unit-tested.
  const audioWatchdogRef = useRef(new DirectionalAudioWatchdog());
  // Monotonic generation per peer. Async callbacks (ICE-restart timers, stats
  // sampling, SDP work) capture the generation when they are scheduled and bail
  // out if the peer has since been removed/recreated, so a stale timer can never
  // restart or mutate a replacement peer connection.
  const peerGenRef = useRef<Map<string, number>>(new Map());
  // Recovery escalation bookkeeping per direction (bounded retries → recreate).
  const audioRecoveryRef = useRef<Map<string, { in: number; out: number }>>(new Map());
  // Ref-stable handle to the one-way-audio recovery routine so the long-lived
  // stats sampler (mounted once) always calls the latest closure.
  const recoverOneWayAudioRef = useRef<
    (peerId: string, pc: RTCPeerConnection, dir: Direction, flatForMs: number) => void
  >(() => {});
  // Consecutive failed ICE restarts per peer, for exponential backoff and the
  // peer-recreation fallback (automates the manual "rejoin fixes it" fix).
  const restartFailuresRef = useRef<Map<string, number>>(new Map());
  // Pending ICE candidates that failed to apply (e.g. arrived during an ICE
  // restart while the old remote description was still set). They are retried
  // once the peer returns to a stable signaling state.
  const retryCandidatesRef = useRef<Map<string, RTCIceCandidateInit[]>>(new Map());
  // Per-peer connection state exposed to the UI ("Connecting…" indicator).
  const [peerConnectionStates, setPeerConnectionStates] = useState<Map<string, RTCPeerConnectionState>>(new Map());

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
    audioWatchdogRef.current.reset(peerId);
    audioRecoveryRef.current.delete(peerId);
    // Invalidate any in-flight async callbacks bound to this peer instance.
    peerGenRef.current.set(peerId, (peerGenRef.current.get(peerId) ?? 0) + 1);
    restartFailuresRef.current.delete(peerId);
    retryCandidatesRef.current.delete(peerId);
    setPeerConnectionStates((prev) => {
      if (!prev.has(peerId)) return prev;
      const next = new Map(prev);
      next.delete(peerId);
      return next;
    });
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
    audioWatchdogRef.current.resetAll();
    audioRecoveryRef.current.clear();
    restartFailuresRef.current.clear();
    retryCandidatesRef.current.clear();
    setPeerConnectionStates(new Map());
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
      // Capture the generation for THIS peer instance. Every async callback
      // scheduled below re-checks it before touching the connection, so work
      // queued for a removed/recreated peer can never affect its replacement.
      const peerGen = (peerGenRef.current.get(peerId) ?? 0) + 1;
      peerGenRef.current.set(peerId, peerGen);
      const isCurrentPeer = () =>
        peersRef.current.get(peerId) === pc && peerGenRef.current.get(peerId) === peerGen;

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
        // When the remote peer attached its microphone via replaceTrack on a
        // trackless transceiver (mic wasn't ready when the peer was created),
        // the negotiated m-line carries no msid and `e.streams` is EMPTY.
        // Wrap the receiver's track in a local MediaStream so audio still
        // flows — dropping the track here caused permanent one-way audio.
        const s = e.streams[0] ?? new MediaStream([e.track]);

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
        setPeerConnectionStates((prev) => {
          if (prev.get(peerId) === state) return prev;
          const next = new Map(prev);
          next.set(peerId, state);
          return next;
        });
        if (state === "connected") {
          // A successful connection resets the restart-failure ladder.
          restartFailuresRef.current.delete(peerId);
          disconnectedSinceRef.current.delete(peerId);
          return;
        }
        if (state === "failed") {
          disconnectedSinceRef.current.delete(peerId);
          // Hard failure: restart ICE with exponential backoff. After
          // MAX_RESTARTS consecutive failures, tear the peer down and
          // recreate it from scratch (a fresh RTCPeerConnection + offer),
          // which is exactly the manual "rejoin" fix users resorted to.
          const MAX_RESTARTS = 3;
          const failures = (restartFailuresRef.current.get(peerId) ?? 0) + 1;
          restartFailuresRef.current.set(peerId, failures);
          if (failures > MAX_RESTARTS) {
            huddleWarn("connection", { peerId, event: "recreate-peer", failures });
            removePeer(peerId);
            const fresh = createPeer(peerId, true);
            if (fresh) {
              // `createPeer` added the audio m-line, so onnegotiationneeded
              // has already fired and the offer is on its way.
              restartFailuresRef.current.set(peerId, 0);
            }
            return;
          }
          if (iceRestartRef.current.get(peerId)) return;
          iceRestartRef.current.set(peerId, true);
          // Backoff: 2s, 4s, 8s (capped).
          const delay = Math.min(2000 * 2 ** (failures - 1), 8000);
          setTimeout(() => {
            // The peer may have been removed/recreated while we backed off.
            if (!isCurrentPeer()) return;
            iceRestartRef.current.set(peerId, false);
            if (pc.connectionState === "failed") {
              try {
                pc.restartIce();
              } catch {
                /* restart may throw if negotiation is in flight */
              }
            }
          }, delay);
          return;
        }
        if (state === "disconnected") {
          // Track when we became disconnected so the stats sampler can
          // escalate to an ICE restart after a bounded timeout.
          if (!disconnectedSinceRef.current.has(peerId)) {
            disconnectedSinceRef.current.set(peerId, Date.now());
          }
          return;
        }
        // connecting / new / closed
        disconnectedSinceRef.current.delete(peerId);
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
              // Re-arm: retry the offer once the peer returns to stable, so a
              // skipped negotiation is never silently lost.
              pc.addEventListener(
                "signalingstatechange",
                () => {
                  if (pc.signalingState === "stable" && pc.connectionState !== "closed") {
                    pc.onnegotiationneeded?.(new Event("negotiationneeded"));
                  }
                },
                { once: true },
              );
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
        } catch {
          // Stale generation (e.g. ICE restart raced the flush): keep it for
          // the post-stable retry instead of dropping it forever.
          bufferRetryCandidate(peerId, c);
        }
      }
    };

    // Candidates that failed to apply (typically new-generation candidates
    // arriving while the old remote description was still set during an ICE
    // restart). Retried once the peer is stable — losing these was the root
    // cause of the endless `failed` restart loop.
    const bufferRetryCandidate = (peerId: string, candidate: RTCIceCandidateInit) => {
      const list = retryCandidatesRef.current.get(peerId) ?? [];
      list.push(candidate);
      retryCandidatesRef.current.set(peerId, list);
    };

    const flushRetryCandidates = async (peerId: string) => {
      const pc = peersRef.current.get(peerId);
      const candidates = retryCandidatesRef.current.get(peerId);
      if (!pc || !candidates || candidates.length === 0) return;
      retryCandidatesRef.current.delete(peerId);
      for (const c of candidates) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(c));
        } catch {
          // Still stale — re-buffer for the next stable transition.
          bufferRetryCandidate(peerId, c);
        }
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
              // Recovery: if our own offer is never answered (the remote may
              // have given up), force a renegotiation after a grace period so
              // the peer cannot dead-end in `have-local-offer` forever.
              const gen = peerGenRef.current.get(from) ?? 0;
              setTimeout(() => {
                const current = peersRef.current.get(from);
                if (
                  current &&
                  peerGenRef.current.get(from) === gen &&
                  current.signalingState === "have-local-offer" &&
                  current.connectionState !== "connected"
                ) {
                  huddleWarn("negotiate", { peerId: from, event: "ignore-offer-recovery" });
                  try {
                    current.restartIce();
                  } catch {
                    /* negotiation may be in flight */
                  }
                }
              }, 5000);
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
          await flushRetryCandidates(from);
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
          await flushRetryCandidates(from);
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
        // The candidate belongs to a newer ICE generation than the currently
        // applied remote description (e.g. mid-restart). Buffer it and retry
        // once signaling is stable — never drop it permanently.
        bufferRetryCandidate(from, candidate);
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
    // Surface remote-playback autoplay blocks to the UI (the manager's
    // onHealth/resumePlayback were previously dead code — a suspended remote
    // AudioContext meant permanent one-way audio with no recovery path).
    const offHealth = mgr.onHealth((blocked) => setRemotePlaybackBlocked(blocked));
    return () => {
      offHealth();
      mgr.destroy();
    };
  }, []);

  /** User-gesture recovery for a suspended remote-playback AudioContext. */
  const resumeRemotePlayback = useCallback(async () => {
    const ok = await remoteAudioRef.current.resumePlayback();
    if (ok) setRemotePlaybackBlocked(false);
  }, []);

  /**
   * Recover a single stalled audio direction. Kept separate from the stats
   * sampler so the escalation policy is testable and the sampler stays focused
   * on measurement.
   *
   * Escalation is bounded to avoid recovery storms and infinite recreate loops:
   *   1. Re-sync the audio transceiver (force `sendrecv`, re-attach our track).
   *   2. `restartIce()` to force a fresh negotiation / candidate run.
   *   3. After `MAX_AUDIO_RECOVERIES` stalled windows in the same direction,
   *      tear the peer down and recreate it — the automated equivalent of the
   *      manual "rejoin fixes it" workaround.
   * The per-direction counter resets whenever that direction shows progress.
   */
  const recoverOneWayAudio = useCallback(
    (peerId: string, pc: RTCPeerConnection, dir: Direction, flatForMs: number) => {
      const MAX_AUDIO_RECOVERIES = 2;
      const counts = audioRecoveryRef.current.get(peerId) ?? { in: 0, out: 0 };
      counts[dir] += 1;
      audioRecoveryRef.current.set(peerId, counts);
      const attempt = counts[dir];

      huddleWarn("watchdog", {
        peerId,
        event: "one-way-audio",
        dir,
        flatForMs,
        attempt,
      });

      if (attempt > MAX_AUDIO_RECOVERIES) {
        huddleWarn("watchdog", { peerId, event: "recreate-peer", dir, attempt });
        audioRecoveryRef.current.delete(peerId);
        removePeer(peerId);
        const fresh = createPeer(peerId, true);
        if (fresh) {
          restartFailuresRef.current.set(peerId, 0);
        }
        return;
      }

      try {
        // Re-sync the audio transceiver: ensure it is bidirectional and that our
        // live microphone track is attached (a trackless sender sends nothing).
        const track = localStreamRef.current?.getAudioTracks()[0] ?? null;
        for (const tx of pc.getTransceivers()) {
          if (tx.receiver.track?.kind !== "audio") continue;
          if (tx.direction !== "sendrecv") {
            try {
              tx.direction = "sendrecv";
            } catch {
              /* ignore */
            }
          }
          if (track && tx.sender.track !== track) {
            tx.sender.replaceTrack(track).catch(() => {
              /* restartIce below will retry */
            });
          }
        }
        // Force a fresh negotiation / candidate run for the broken path.
        audioWatchdogRef.current.rebaseline(peerId, dir);
        pc.restartIce();
      } catch (err) {
        huddleWarn("watchdog", { peerId, event: "renegotiate-error", dir, error: String(err) });
      }
    },
    [createPeer, removePeer],
  );
  recoverOneWayAudioRef.current = recoverOneWayAudio;

  useEffect(() => {
    if (!localStream) return;
    const newTrack = localStream.getAudioTracks()[0];
    if (!newTrack) return;

    for (const [peerId, pc] of peersRef.current) {
      if (pc.connectionState === "closed") continue;
      // Prefer replacing the track on an existing audio transceiver. A
      // transceiver created without a track (mic not ready at peer creation)
      // has a sender with NO track, so matching on `s.track?.kind` misses it
      // — that bug fell through to `addTrack`, creating a DUPLICATE audio
      // m-line and a renegotiation instead of the intended seamless
      // replaceTrack, leaving the remote side with a dead first m-line.
      const audioTransceiver = pc
        .getTransceivers()
        .find((t) => t.receiver.track?.kind === "audio" && !t.sender.track);
      const audioSender =
        audioTransceiver?.sender ??
        pc.getSenders().find((s) => s.track?.kind === "audio");
      if (audioSender) {
        if (audioTransceiver && audioTransceiver.direction !== "sendrecv") {
          try { audioTransceiver.direction = "sendrecv"; } catch { /* ignore */ }
        }
        // If the sender already has a track (set by the previous effect), replace it.
        // If it was created empty (addTransceiver without a track), replaceTrack
        // succeeds without renegotiation.
        huddleLog("audio", { peerId, event: "replaceTrack" });
        audioSender.replaceTrack(newTrack).catch((err) => {
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
      // Whether the browser actually exposed each audio RTP stat. A missing
      // stat (common cross-browser difference) must be distinguished from a
      // genuine zero, otherwise a browser without `bytesReceived` would look
      // permanently stalled and trigger spurious recovery.
      let hasInbound = false;
      let hasOutbound = false;
      report.forEach((s) => {
        if (s.type === "outbound-rtp" && (s as RTCOutboundRtpStreamStats).kind === "audio") {
          const r = s as RTCOutboundRtpStreamStats & Record<string, unknown>;
          hasOutbound = true;
          outBytes = r.bytesSent ?? 0;
          outPackets = r.packetsSent ?? 0;
          diag.outbound = {
            packetsSent: r.packetsSent,
            bytesSent: r.bytesSent,
          };
        } else if (s.type === "inbound-rtp" && (s as RTCInboundRtpStreamStats).kind === "audio") {
          const r = s as RTCInboundRtpStreamStats & Record<string, unknown>;
          hasInbound = true;
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

      // --- Recovery watchdog: detect audio broken in ONE direction ----------
      // Inbound and outbound RTP progress are tracked INDEPENDENTLY. A stuck or
      // one-way audio path keeps `connectionState === "connected"` (the ICE
      // transport is alive) while audio dies in one direction. The old check
      // (`inBytes > prev.in || outBytes > prev.out`) treated progress in EITHER
      // direction as healthy, so one-way audio was masked forever.
      //
      // `DirectionalAudioWatchdog` decides per direction, tolerating counter
      // resets (ICE restarts) and browser stat gaps (missing stats are
      // "unknown", never recovered). Outbound is only watched while the local
      // track is live and enabled, so a muted / gate-closed sender is treated
      // as intentional silence rather than a stall.
      const now = Date.now();
      const outboundTrack = localStreamRef.current?.getAudioTracks()[0] ?? null;
      const audioTransceiver = pc.getTransceivers().find((t) => t.receiver.track?.kind === "audio");
      const negotiatedDirection = audioTransceiver?.currentDirection ?? audioTransceiver?.direction;
      const decision = audioWatchdogRef.current.observe(peerId, {
        in: { bytes: hasInbound ? inBytes : null, packets: hasInbound ? inPackets : null },
        out: { bytes: hasOutbound ? outBytes : null, packets: hasOutbound ? outPackets : null },
        expectsInbound: negotiatedDirection === "sendrecv" || negotiatedDirection === "recvonly",
        expectsOutbound: negotiatedDirection === "sendrecv" || negotiatedDirection === "sendonly",
        outboundTrackActive: !!outboundTrack && outboundTrack.enabled && outboundTrack.readyState === "live",
        now,
      });

      for (const dir of ["in", "out"] as const) {
        const d = decision[dir];
        if (d.status === "stalled" && d.shouldRecover) {
          recoverOneWayAudioRef.current(peerId, pc, dir, d.flatForMs);
        } else if (d.status === "progressing") {
          // This direction recovered — clear its escalation ladder.
          const counts = audioRecoveryRef.current.get(peerId);
          if (counts && counts[dir] > 0) {
            counts[dir] = 0;
          }
        }
      }
      diag.watchdog = {
        in: decision.in.status,
        out: decision.out.status,
        negotiatedDirection,
        outboundTrackActive: !!outboundTrack && outboundTrack.enabled && outboundTrack.readyState === "live",
        inLost,
      };

      // Structured diagnostic log. In development (or when HUDDLE debug is
      // enabled) log every sample; in production emit a reduced-rate summary
      // line so silent-pair diagnosis is possible from shipped logs.
      //
      // Firefox: `console.debug` output is shown by default in the console
      // (unlike Chrome, which hides debug-level messages unless "Verbose" is
      // selected), so the 5s sampler floods the Firefox console. Skip the
      // periodic stats log entirely in Firefox; the event-driven watchdog /
      // negotiation logs remain active everywhere.
      const isDev =
        (import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV === true;
      const isFirefox =
        typeof navigator !== "undefined" && /firefox/i.test(navigator.userAgent);
      if (isDev && !isFirefox) {
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
    peerConnectionStates,
    remotePlaybackBlocked,
    resumeRemotePlayback,
    startScreenShare,
    stopScreenShare,
    setRemoteVolume,
  };
}

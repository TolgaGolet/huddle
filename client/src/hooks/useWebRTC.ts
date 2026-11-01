import { useEffect, useRef, useCallback, useState } from "react";
import type { Socket } from "socket.io-client";
import type { AppSocket } from "../types";
import { RemoteAudioManager } from "../lib/audioEngine";
import { errorName, huddleLog, huddleWarn } from "../lib/huddleLog";
import { parseIceServers } from "../lib/iceServers";
import { PeerSession } from "../lib/peerSession";
import { rekeyStream, withoutStream } from "../lib/screenStreams";

// ICE servers. STUN-only by default, which works for most home/office NATs.
// For symmetric NATs, carrier-grade NAT, or strict corporate firewalls, set
// `VITE_ICE_SERVERS` (JSON `RTCConfiguration.iceServers` array) at build time
// to include TURN servers, e.g.:
//   VITE_ICE_SERVERS='[{"urls":"turn:turn.example.com:3478","username":"...","credential":"..."}]'
// Without TURN, users behind restrictive NATs can establish signaling but not
// media, which presents as "connected but no audio" and is unrelated to the
// negotiation races fixed here.
const ICE_SERVERS: RTCConfiguration = (() => {
  const raw = import.meta.env.VITE_ICE_SERVERS;
  if (raw) {
    const iceServers = parseIceServers(raw);
    if (iceServers) return { iceServers };
    // vite.config.ts fails the build on this, so it takes an unusual build to get here.
    huddleWarn("connection", { event: "ice-servers-invalid" });
  }
  return {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
    ],
  };
})();

const STATS_SAMPLE_INTERVAL_MS = 5000;

interface UseWebRTCOptions {
  socket: AppSocket | null;
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
  // All per-peer negotiation and recovery state lives on the session.
  const sessionsRef = useRef<Map<string, PeerSession>>(new Map());
  // Candidates that arrive while no session exists for the peer; a session
  // can't hold these, so the next one created for that peer takes them over.
  const earlyCandidatesRef = useRef<Map<string, RTCIceCandidateInit[]>>(new Map());
  const remoteAudioRef = useRef(new RemoteAudioManager());
  const localStreamRef = useRef<MediaStream | null>(null);
  const socketRef = useRef<AppSocket | null>(null);
  const onScreenShareStoppedRef = useRef(onScreenShareStopped);
  const onSignalingReadyRef = useRef(onSignalingReady);
  const [remoteAnalysers, setRemoteAnalysers] = useState<Map<string, AnalyserNode>>(new Map());
  const [screenStreams, setScreenStreams] = useState<Map<string, MediaStream>>(new Map());
  // True when the remote-playback AudioContext is suspended (autoplay block /
  // OS interruption) — surfaced so the UI can offer a gesture-based recovery.
  const [remotePlaybackBlocked, setRemotePlaybackBlocked] = useState(false);
  const screenTrackRef = useRef<MediaStreamTrack | null>(null);
  // The key of our own share in `screenStreams`; the live socket id changes on reconnect.
  const localShareIdRef = useRef<string | null>(null);
  // Per-peer connection state exposed to the UI ("Connecting…" indicator).
  const [peerConnectionStates, setPeerConnectionStates] = useState<Map<string, RTCPeerConnectionState>>(new Map());

  localStreamRef.current = localStream;
  socketRef.current = socket;
  onScreenShareStoppedRef.current = onScreenShareStopped;
  onSignalingReadyRef.current = onSignalingReady;

  const removePeer = useCallback((peerId: string) => {
    const session = sessionsRef.current.get(peerId);
    if (session) {
      session.dispose();
      sessionsRef.current.delete(peerId);
    }
    earlyCandidatesRef.current.delete(peerId);
    setPeerConnectionStates((prev) => {
      if (!prev.has(peerId)) return prev;
      const next = new Map(prev);
      next.delete(peerId);
      return next;
    });
    remoteAudioRef.current.removeStream(peerId);
    setRemoteAnalysers(new Map(remoteAudioRef.current.getAnalysers()));
    setScreenStreams((prev) => withoutStream(prev, peerId));
  }, []);

  const resetAllPeers = useCallback(() => {
    for (const [id] of sessionsRef.current) {
      removePeer(id);
    }
    earlyCandidatesRef.current.clear();
  }, [removePeer]);

  const stopScreenShare = useCallback(() => {
    if (screenTrackRef.current) {
      screenTrackRef.current.stop();
      screenTrackRef.current = null;
    }

    for (const session of sessionsRef.current.values()) {
      session.removeScreenTrack();
    }

    const localId = localShareIdRef.current;
    localShareIdRef.current = null;
    if (localId) {
      setScreenStreams((prev) => withoutStream(prev, localId));
    }

    socketRef.current?.emit("screen-share-stopped");
    onScreenShareStoppedRef.current?.();
  }, []);

  const createPeer = useCallback(
    (peerId: string) => {
      const sock = socketRef.current;
      if (!sock) return null;

      const existing = sessionsRef.current.get(peerId);
      if (existing) return existing;

      const earlyCandidates = earlyCandidatesRef.current.get(peerId);
      earlyCandidatesRef.current.delete(peerId);

      const session = new PeerSession(
        peerId,
        new RTCPeerConnection(ICE_SERVERS),
        {
          // PeerSessionHost.emit already ties each event to its payload.
          emit: (event, ...args) => (sock as unknown as Socket).emit(event, ...args),
          getLocalStream: () => localStreamRef.current,
          onTrack: (e) => {
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
              e.track.onended = () => setScreenStreams((prev) => withoutStream(prev, peerId));
            }
          },
          onConnectionState: (state) => {
            setPeerConnectionStates((prev) => {
              if (prev.get(peerId) === state) return prev;
              const next = new Map(prev);
              next.set(peerId, state);
              return next;
            });
          },
          requestRecreate: () => {
            removePeer(peerId);
            // The new session adds the audio m-line, so onnegotiationneeded
            // fires and the offer is on its way.
            createPeer(peerId);
          },
        },
        { screenTrack: screenTrackRef.current, earlyCandidates },
      );
      sessionsRef.current.set(peerId, session);
      return session;
    },
    [removePeer],
  );

  useEffect(() => {
    if (!socket) return;

    const handleOffer = async ({ from, offer }: { from: string; offer: RTCSessionDescriptionInit }) => {
      try {
        // Read the live id: it is undefined before "connect" and changes on reconnect.
        // Check it before createPeer so a stale offer never leaves an orphan peer.
        const selfId = socket.id;
        if (!selfId) return; // not connected; the offer will be re-sent after rejoin

        const session = createPeer(from);
        await session?.handleOffer(offer, selfId);
      } catch (err) {
        huddleWarn("negotiate", { from, event: "offer-handling-error", error: errorName(err) });
      }
    };

    const handleAnswer = async ({ from, answer }: { from: string; answer: RTCSessionDescriptionInit }) => {
      await sessionsRef.current.get(from)?.handleAnswer(answer);
    };

    const handleIceCandidate = async ({ from, candidate }: { from: string; candidate: RTCIceCandidateInit }) => {
      const session = sessionsRef.current.get(from);
      if (!session) {
        const early = earlyCandidatesRef.current.get(from) ?? [];
        early.push(candidate);
        earlyCandidatesRef.current.set(from, early);
        return;
      }
      await session.addCandidate(candidate);
    };

    const handleParticipantLeft = ({ id }: { id: string }) => {
      removePeer(id);
    };

    const handleRoomJoined = ({ participants, screenSharer }: { participants: { id: string }[]; screenSharer: string | null }) => {
      // A share survives a reconnect, but the server forgot it with the old
      // socket. Announce it again, unless someone else started sharing meanwhile.
      if (screenTrackRef.current) {
        const previousId = localShareIdRef.current;
        if (screenSharer || !previousId || !socket.id) {
          stopScreenShare();
        } else {
          const id = socket.id;
          localShareIdRef.current = id;
          setScreenStreams((prev) => rekeyStream(prev, previousId, id));
          socket.emit("screen-share-started");
        }
      }

      // The joining client is the sole initial offerer for every existing
      // participant in the roster. Existing clients answer the offer, which
      // lazily creates their answering peer in `handleOffer`. This eliminates
      // the initial-offer glare where both sides negotiated at once.
      const micReady = !!localStreamRef.current;
      huddleLog("socket", {
        event: "room-joined-roster",
        rosterSize: participants.length,
        micReady,
        roster: participants.map((p) => p.id),
      });
      for (const p of participants) {
        // Always create the peer immediately so receive-audio, video, and
        // screen share work even before (or without) a microphone. The audio
        // m-line is deterministic regardless of mic readiness: `PeerSession`
        // adds a `sendrecv` audio transceiver whether or not a track exists,
        // and the track is attached later via `replaceTrack` (no second
        // renegotiation required).
        createPeer(p.id);
      }
    };

    const handleScreenShareStopped = ({ id }: { id: string }) => {
      setScreenStreams((prev) => withoutStream(prev, id));
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
      socket.off("participant-left", handleParticipantLeft);
      socket.off("room-joined", handleRoomJoined);
      socket.off("screen-share-stopped", handleScreenShareStopped);
      socket.off("disconnect", handleLocalDisconnect);
      // eslint-disable-next-line react-hooks/exhaustive-deps -- must see peers created after this effect ran.
      for (const [id] of sessionsRef.current) {
        removePeer(id);
      }
    };
  }, [socket, createPeer, removePeer, resetAllPeers, stopScreenShare]);

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

  useEffect(() => {
    if (!localStream) return;
    const newTrack = localStream.getAudioTracks()[0];
    if (!newTrack) return;

    for (const session of sessionsRef.current.values()) {
      session.attachLocalTrack(newTrack, localStream);
    }
  }, [localStream]);

  const startScreenShare = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      const track = stream.getVideoTracks()[0];
      screenTrackRef.current = track;

      for (const session of sessionsRef.current.values()) {
        session.addScreenTrack(track, stream);
      }

      const localId = socketRef.current?.id;
      if (localId) {
        localShareIdRef.current = localId;
        setScreenStreams((prev) => new Map(prev).set(localId, stream));
      }

      track.onended = () => {
        stopScreenShare();
      };

      socketRef.current?.emit("screen-share-started");
      return true;
    } catch (err) {
      // NotAllowedError is the user cancelling the picker.
      if (errorName(err) !== "NotAllowedError") huddleWarn("capture", { event: "screen-share-failed", error: errorName(err) });
      return false;
    }
  }, [stopScreenShare]);

  const setRemoteVolume = useCallback((peerId: string, volume: number) => {
    remoteAudioRef.current.setVolume(peerId, volume);
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      for (const session of sessionsRef.current.values()) {
        void session.sampleStats();
      }
    }, STATS_SAMPLE_INTERVAL_MS);

    return () => clearInterval(timer);
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

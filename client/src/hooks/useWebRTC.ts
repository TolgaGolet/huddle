import { useEffect, useRef, useCallback, useState } from "react";
import type { Socket } from "socket.io-client";
import { RemoteAudioManager } from "../lib/audioEngine";

const ICE_SERVERS: RTCConfiguration = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ],
};

interface UseWebRTCOptions {
  socket: Socket | null;
  localStream: MediaStream | null;
  onScreenShareStopped?: () => void;
}

export function useWebRTC({ socket, localStream, onScreenShareStopped }: UseWebRTCOptions) {
  const peersRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const remoteAudioRef = useRef<RemoteAudioManager>(new RemoteAudioManager());
  const localStreamRef = useRef<MediaStream | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const onScreenShareStoppedRef = useRef(onScreenShareStopped);
  const [remoteStreams, setRemoteStreams] = useState<Map<string, MediaStream>>(new Map());
  const [remoteAnalysers, setRemoteAnalysers] = useState<Map<string, AnalyserNode>>(new Map());
  const [screenStreams, setScreenStreams] = useState<Map<string, MediaStream>>(new Map());
  const screenTrackRef = useRef<MediaStreamTrack | null>(null);
  const screenSendersRef = useRef<Map<string, RTCRtpSender>>(new Map());
  const makingOfferRef = useRef<Map<string, boolean>>(new Map());

  localStreamRef.current = localStream;
  socketRef.current = socket;
  onScreenShareStoppedRef.current = onScreenShareStopped;

  const removePeer = useCallback((peerId: string) => {
    const pc = peersRef.current.get(peerId);
    if (pc) {
      pc.close();
      peersRef.current.delete(peerId);
    }
    makingOfferRef.current.delete(peerId);
    remoteAudioRef.current.removeStream(peerId);
    screenSendersRef.current.delete(peerId);
    setRemoteStreams((prev) => {
      const next = new Map(prev);
      next.delete(peerId);
      return next;
    });
    setRemoteAnalysers(new Map(remoteAudioRef.current.getAnalysers()));
    setScreenStreams((prev) => {
      const next = new Map(prev);
      next.delete(peerId);
      return next;
    });
  }, []);

  const createPeer = useCallback(
    (peerId: string, initiator: boolean) => {
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
          setRemoteStreams((prev) => new Map(prev).set(peerId, s));
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
        if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
          removePeer(peerId);
        }
      };

      pc.onnegotiationneeded = async () => {
        try {
          makingOfferRef.current.set(peerId, true);
          const offer = await pc.createOffer();
          if (pc.signalingState !== "stable") return;
          await pc.setLocalDescription(offer);
          sock.emit("offer", { to: peerId, offer: pc.localDescription });
        } catch (err) {
          console.error("Negotiation failed:", err);
        } finally {
          makingOfferRef.current.set(peerId, false);
        }
      };

      if (initiator) {
        // onnegotiationneeded fires automatically after addTrack
      }

      return pc;
    },
    [removePeer],
  );

  useEffect(() => {
    if (!socket) return;
    const myId = socket.id;

    const handleOffer = async ({ from, offer }: { from: string; offer: RTCSessionDescriptionInit }) => {
      let pc = peersRef.current.get(from);
      if (!pc) {
        pc = createPeer(from, false) ?? undefined;
      }
      if (!pc) return;

      const isPolite = myId! > from;
      const offerCollision = makingOfferRef.current.get(from) || pc.signalingState !== "stable";

      if (offerCollision && !isPolite) return;

      if (offerCollision) {
        await Promise.all([
          pc.setLocalDescription({ type: "rollback" }),
          pc.setRemoteDescription(new RTCSessionDescription(offer)),
        ]);
      } else {
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
      }

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit("answer", { to: from, answer: pc.localDescription });
    };

    const handleAnswer = async ({ from, answer }: { from: string; answer: RTCSessionDescriptionInit }) => {
      const pc = peersRef.current.get(from);
      if (!pc) return;
      if (pc.signalingState === "stable") return;
      await pc.setRemoteDescription(new RTCSessionDescription(answer));
    };

    const handleIceCandidate = async ({ from, candidate }: { from: string; candidate: RTCIceCandidateInit }) => {
      const pc = peersRef.current.get(from);
      if (!pc) return;
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch {
        // Ignore candidates that arrive after rollback
      }
    };

    const handleParticipantJoined = ({ id }: { id: string }) => {
      createPeer(id, true);
    };

    const handleParticipantLeft = ({ id }: { id: string }) => {
      removePeer(id);
    };

    const handleRoomJoined = ({ participants }: { participants: { id: string }[] }) => {
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

    socket.on("offer", handleOffer);
    socket.on("answer", handleAnswer);
    socket.on("ice-candidate", handleIceCandidate);
    socket.on("participant-joined", handleParticipantJoined);
    socket.on("participant-left", handleParticipantLeft);
    socket.on("room-joined", handleRoomJoined);
    socket.on("screen-share-stopped", handleScreenShareStopped);

    return () => {
      socket.off("offer", handleOffer);
      socket.off("answer", handleAnswer);
      socket.off("ice-candidate", handleIceCandidate);
      socket.off("participant-joined", handleParticipantJoined);
      socket.off("participant-left", handleParticipantLeft);
      socket.off("room-joined", handleRoomJoined);
      socket.off("screen-share-stopped", handleScreenShareStopped);
      for (const [id] of peersRef.current) {
        removePeer(id);
      }
    };
  }, [socket, createPeer, removePeer]);

  useEffect(() => {
    if (!localStream) return;
    for (const [, pc] of peersRef.current) {
      const audioSenders = pc.getSenders().filter((s) => s.track?.kind === "audio");
      const newTrack = localStream.getAudioTracks()[0];
      if (!newTrack) continue;

      if (audioSenders.length > 0) {
        audioSenders[0].replaceTrack(newTrack);
      } else {
        pc.addTrack(newTrack, localStream);
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

  return {
    remoteStreams,
    remoteAnalysers,
    screenStreams,
    startScreenShare,
    stopScreenShare,
    setRemoteVolume,
  };
}

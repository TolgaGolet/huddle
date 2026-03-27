import { useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import type { Participant, ChatMessage } from "../types";
import { playJoinSound, playLeaveSound } from "../lib/notificationSounds";

interface UseSocketOptions {
  roomId: string;
  name: string;
  password?: string;
}

interface UseSocketReturn {
  socket: Socket | null;
  participants: Participant[];
  chatHistory: ChatMessage[];
  connected: boolean;
  joinError: string | null;
  currentScreenSharer: string | null;
}

const MAX_CLIENT_CHAT = 200;

export function useSocket({ roomId, name, password }: UseSocketOptions): UseSocketReturn {
  const socketRef = useRef<Socket | null>(null);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);
  const [connected, setConnected] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [currentScreenSharer, setCurrentScreenSharer] = useState<string | null>(null);

  useEffect(() => {
    if (!roomId || !name) return;

    let socket: Socket | null = null;

    // Defer socket creation by one macrotask. React StrictMode (development)
    // runs effect cleanup immediately after the first run before re-mounting.
    // Creating a WebSocket and calling close() while it is still in the
    // CONNECTING state produces a browser-level error that cannot be caught in
    // JS. Deferring with setTimeout means the cleanup can clearTimeout before
    // the socket is ever opened, so no WebSocket is created on the discarded
    // StrictMode run. In production StrictMode is inactive, so the 0ms delay
    // has no observable effect.
    const timer = setTimeout(() => {
      socket = io({ transports: ["websocket"] });
      socketRef.current = socket;

      const onConnect = () => {
        setConnected(true);
        socket!.emit("join-room", { roomId, name, password });
      };

      const onDisconnect = () => setConnected(false);

      const onError = (data: { message: string }) => {
        setJoinError(data.message);
        socket!.disconnect();
      };

      const onRoomJoined = (data: { participants: Participant[]; chatHistory: ChatMessage[]; screenSharer: string | null }) => {
        setParticipants(data.participants);
        setChatHistory(data.chatHistory.slice(-MAX_CLIENT_CHAT));
        setCurrentScreenSharer(data.screenSharer);
      };

      const onParticipantJoined = (p: Participant) => {
        setParticipants((prev) => [...prev.filter((x) => x.id !== p.id), p]);
        playJoinSound();
      };

      const onParticipantLeft = ({ id }: { id: string }) => {
        setParticipants((prev) => prev.filter((p) => p.id !== id));
        setCurrentScreenSharer((prev) => (prev === id ? null : prev));
        playLeaveSound();
      };

      const onParticipantMuted = ({ id, isMuted }: { id: string; isMuted: boolean }) => {
        setParticipants((prev) =>
          prev.map((p) => (p.id === id ? { ...p, isMuted } : p)),
        );
      };

      const onScreenShareStarted = ({ id }: { id: string }) => {
        setCurrentScreenSharer(id);
      };

      const onScreenShareStopped = ({ id }: { id: string }) => {
        setCurrentScreenSharer((prev) => (prev === id ? null : prev));
      };

      const onChatMessage = (msg: ChatMessage) => {
        setChatHistory((prev) => {
          const next = [...prev, msg];
          return next.length > MAX_CLIENT_CHAT ? next.slice(-MAX_CLIENT_CHAT) : next;
        });
      };

      socket.on("connect", onConnect);
      socket.on("disconnect", onDisconnect);
      socket.on("error", onError);
      socket.on("room-joined", onRoomJoined);
      socket.on("participant-joined", onParticipantJoined);
      socket.on("participant-left", onParticipantLeft);
      socket.on("participant-muted", onParticipantMuted);
      socket.on("screen-share-started", onScreenShareStarted);
      socket.on("screen-share-stopped", onScreenShareStopped);
      socket.on("chat-message", onChatMessage);
    }, 0);

    return () => {
      clearTimeout(timer);
      if (socket) {
        socket.removeAllListeners();
        socket.disconnect();
        socketRef.current = null;
      }
    };
  }, [roomId, name, password]);

  return { socket: socketRef.current, participants, chatHistory, connected, joinError, currentScreenSharer };
}

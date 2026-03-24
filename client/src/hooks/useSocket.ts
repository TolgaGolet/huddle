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

export function useSocket({ roomId, name, password }: UseSocketOptions): UseSocketReturn {
  const socketRef = useRef<Socket | null>(null);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);
  const [connected, setConnected] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [currentScreenSharer, setCurrentScreenSharer] = useState<string | null>(null);

  useEffect(() => {
    if (!roomId || !name) return;

    const socket = io();
    socketRef.current = socket;

    socket.on("connect", () => {
      setConnected(true);
      socket.emit("join-room", { roomId, name, password });
    });

    socket.on("disconnect", () => setConnected(false));

    socket.on("error", (data: { message: string }) => {
      setJoinError(data.message);
      socket.disconnect();
    });

    socket.on("room-joined", (data: { participants: Participant[]; chatHistory: ChatMessage[]; screenSharer: string | null }) => {
      setParticipants(data.participants);
      setChatHistory(data.chatHistory);
      setCurrentScreenSharer(data.screenSharer);
    });

    socket.on("participant-joined", (p: Participant) => {
      setParticipants((prev) => [...prev.filter((x) => x.id !== p.id), p]);
      playJoinSound();
    });

    socket.on("participant-left", ({ id }: { id: string }) => {
      setParticipants((prev) => prev.filter((p) => p.id !== id));
      setCurrentScreenSharer((prev) => (prev === id ? null : prev));
      playLeaveSound();
    });

    socket.on("participant-muted", ({ id, isMuted }: { id: string; isMuted: boolean }) => {
      setParticipants((prev) =>
        prev.map((p) => (p.id === id ? { ...p, isMuted } : p)),
      );
    });

    socket.on("screen-share-started", ({ id }: { id: string }) => {
      setCurrentScreenSharer(id);
    });

    socket.on("screen-share-stopped", ({ id }: { id: string }) => {
      setCurrentScreenSharer((prev) => (prev === id ? null : prev));
    });

    socket.on("chat-message", (msg: ChatMessage) => {
      setChatHistory((prev) => [...prev, msg]);
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [roomId, name, password]);

  return { socket: socketRef.current, participants, chatHistory, connected, joinError, currentScreenSharer };
}

import { useEffect, useRef, useState, useCallback } from "react";
import { io, type Socket } from "socket.io-client";
import type { Participant, ChatMessage, ChatEntry, PollMessage } from "../types";
import { playJoinSound, playLeaveSound, playDisconnectSound, playReconnectSound } from "../lib/notificationSounds";
import { huddleLog } from "../lib/huddleLog";

interface UseSocketOptions {
  roomId: string;
  name: string;
  password?: string;
}

export interface UseSocketReturn {
  socket: Socket | null;
  participants: Participant[];
  chatHistory: ChatEntry[];
  connected: boolean;
  joinError: string | null;
  currentScreenSharer: string | null;
  joinRoom: () => void;
}

const MAX_CLIENT_CHAT = 200;

export function useSocket({ roomId, name, password }: UseSocketOptions): UseSocketReturn {
  const socketRef = useRef<Socket | null>(null);
  const [socket, setSocket] = useState<Socket | null>(null);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [chatHistory, setChatHistory] = useState<ChatEntry[]>([]);
  const [connected, setConnected] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  // True once we have ever connected; used to distinguish the initial
  // connection (silent) from a recovery after a drop (play a cue).
  const wasConnectedRef = useRef(false);
  const [currentScreenSharer, setCurrentScreenSharer] = useState<string | null>(null);

  // Room-join coordination: `joinRoom()` is invoked by the caller only after
  // the WebRTC signaling listeners have been installed, so the server cannot
  // emit `room-joined`/`offer`/`ice-candidate` before this client is ready to
  // handle them. We also re-join automatically after a transport reconnect so
  // a dropped socket does not leave the user stranded in the room.
  const joinArgsRef = useRef({ roomId, name, password });
  joinArgsRef.current = { roomId, name, password };
  const joinedRef = useRef(false);
  const wantsJoinRef = useRef(false);

  const joinRoom = useCallback(() => {
    wantsJoinRef.current = true;
    const sock = socketRef.current;
    if (!sock || !sock.connected || joinedRef.current) return;
    joinedRef.current = true;
    const { roomId: rid, name: nm, password: pw } = joinArgsRef.current;
    huddleLog("socket", { event: "join-room-emit", roomId: rid });
    sock.emit("join-room", { roomId: rid, name: nm, password: pw });
  }, []);

  useEffect(() => {
    if (!roomId || !name) return;

    let socket: Socket | null = null;

    // Defer socket creation by one macrotask so React StrictMode cleanup
    // can cancel before a WebSocket is actually opened.
    const timer = setTimeout(() => {
      socket = io({
        transports: ["websocket"],
        // Resilient reconnection: long-running sessions are routinely
        // interrupted by network changes, laptop sleep, or NAT rebinding.
        // Retrying for up to ~5 minutes with capped backoff lets the client
        // survive transient drops instead of appearing as a "random kick".
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        // Server pings us every 25s and allows 60s (2 missed pings) before
        // considering the transport dead. This tolerates brief CPU stalls and
        // background-tab throttling without dropping the connection.
        timeout: 20000,
      });
      socketRef.current = socket;
      setSocket(socket);

      const onConnect = () => {
        setConnected(true);
        // Play a restoration cue only when recovering from a drop, so the
        // initial connection is silent and the user is not overloaded with
        // sounds they cannot attribute to an event.
        if (wasConnectedRef.current) {
          playReconnectSound();
        }
        wasConnectedRef.current = true;
        // Mark as not-joined so a reconnect re-issues the join using the
        // latest readiness signal from the caller (see `joinRoom`).
        joinedRef.current = false;
        if (wantsJoinRef.current) {
          joinRoom();
        }
      };

      const onDisconnect = (reason: Socket.DisconnectReason) => {
        // Only alert on *unintentional* disconnects. Manual disconnects
        // (leaving the room, joining errors) and server shutdowns are
        // deliberate; io client disconnect, ping timeout, transport close,
        // and transport errors are the "app kicked me" cases the user must
        // be made aware of.
        const unintentional =
          reason === "io client disconnect" ? false : reason !== "io server disconnect";
        if (unintentional) {
          playDisconnectSound();
        }
        setConnected(false);
        // Allow `joinRoom` to rejoin on the next connect once the caller
        // reinstalls signaling listeners.
        joinedRef.current = false;
      };

      const onError = (data: { message: string }) => {
        huddleLog("socket", { event: "join-error", message: data.message });
        setJoinError(data.message);
        socket!.disconnect();
      };

      const onRoomJoined = (data: { participants: Participant[]; chatHistory: ChatEntry[]; screenSharer: string | null }) => {
        huddleLog("socket", { event: "room-joined-received", participantCount: data.participants.length });
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

      const onChatReactionUpdate = ({ messageId, reactions }: { messageId: string; reactions: Record<string, string[]> }) => {
        setChatHistory((prev) =>
          prev.map((entry) =>
            entry.id === messageId && !("type" in entry)
              ? { ...entry, reactions }
              : entry,
          ),
        );
      };

      const onPollCreate = (poll: PollMessage) => {
        setChatHistory((prev) => {
          const next = [...prev, poll];
          return next.length > MAX_CLIENT_CHAT ? next.slice(-MAX_CLIENT_CHAT) : next;
        });
      };

      const onPollUpdate = (poll: PollMessage) => {
        setChatHistory((prev) =>
          prev.map((entry) => (entry.id === poll.id ? poll : entry)),
        );
      };

      const onChatMessageEdit = ({ messageId, text }: { messageId: string; text: string }) => {
        setChatHistory((prev) =>
          prev.map((entry) =>
            entry.id === messageId && !("type" in entry)
              ? { ...entry, text, edited: true }
              : entry,
          ),
        );
      };

      const onChatMessageDelete = ({ messageId }: { messageId: string }) => {
        setChatHistory((prev) => prev.filter((entry) => entry.id !== messageId));
      };

      const onChatPinUpdate = ({ pinnedMessageId, chatHistory: history }: { pinnedMessageId: string | null; chatHistory: ChatEntry[] }) => {
        setChatHistory(history.slice(-MAX_CLIENT_CHAT).map((entry) =>
          ({ ...entry, pinned: entry.id === pinnedMessageId }),
        ));
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
      socket.on("chat-reaction-update", onChatReactionUpdate);
      socket.on("chat-message-edit", onChatMessageEdit);
      socket.on("chat-message-delete", onChatMessageDelete);
      socket.on("chat-pin-update", onChatPinUpdate);
      socket.on("poll-create", onPollCreate);
      socket.on("poll-update", onPollUpdate);
    }, 0);

    return () => {
      clearTimeout(timer);
      wantsJoinRef.current = false;
      joinedRef.current = false;
      if (socket) {
        socket.removeAllListeners();
        socket.disconnect();
        socketRef.current = null;
        setSocket(null);
      }
    };
  }, [roomId, name, password, joinRoom]);

  return { socket, participants, chatHistory, connected, joinError, currentScreenSharer, joinRoom };
}

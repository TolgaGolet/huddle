import { useEffect, useRef, useState, useCallback } from "react";
import { io, type Socket } from "socket.io-client";
import type { Participant, ChatMessage, ChatEntry, PollMessage } from "../types";
import { playJoinSound, playLeaveSound, playMessageSound, playDisconnectedSound } from "../lib/notificationSounds";
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
  typingUsers: string[];
  notifyTyping: () => void;
  joinRoom: () => void;
}

const MAX_CLIENT_CHAT = 200;

/**
 * Errors that can occur transiently during an automatic rejoin after a
 * network blip (the server may briefly still hold our stale participant
 * entry, or the room may be in its empty-room grace window). These are
 * retried with backoff instead of kicking the user out of the room.
 */
const TRANSIENT_JOIN_ERRORS = new Set(["Name already taken in this room", "Room not found"]);
const JOIN_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 15000];

export function useSocket({ roomId, name, password }: UseSocketOptions): UseSocketReturn {
  const socketRef = useRef<Socket | null>(null);
  const [socket, setSocket] = useState<Socket | null>(null);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [chatHistory, setChatHistory] = useState<ChatEntry[]>([]);
  const [connected, setConnected] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [currentScreenSharer, setCurrentScreenSharer] = useState<string | null>(null);
  // Names of other participants currently typing (most recent first).
  const [typingUsers, setTypingUsers] = useState<string[]>([]);

  const notifyTyping = useCallback(() => {
    socketRef.current?.emit("typing");
  }, []);

  // Room-join coordination: `joinRoom()` is invoked by the caller only after
  // the WebRTC signaling listeners have been installed, so the server cannot
  // emit `room-joined`/`offer`/`ice-candidate` before this client is ready to
  // handle them. We also re-join automatically after a transport reconnect so
  // a dropped socket does not leave the user stranded in the room.
  const joinArgsRef = useRef({ roomId, name, password });
  joinArgsRef.current = { roomId, name, password };
  const joinedRef = useRef(false);
  const wantsJoinRef = useRef(false);
  // Retry bookkeeping for transient join errors (see TRANSIENT_JOIN_ERRORS).
  const joinRetryRef = useRef(0);
  const joinRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const joinRoom = useCallback(() => {
    wantsJoinRef.current = true;
    const sock = socketRef.current;
    if (!sock || !sock.connected || joinedRef.current) return;
    joinedRef.current = true;
    const { roomId: rid, name: nm, password: pw } = joinArgsRef.current;
    huddleLog("socket", { event: "join-room-emit", roomId: rid });
    sock.emit("join-room", { roomId: rid, name: nm, password: pw });
  }, []);

  // Re-emit join-room after a backoff delay. Used when the server rejected a
  // rejoin with a transient error (e.g. our stale entry hadn't been evicted
  // yet); the situation typically resolves itself within a few seconds.
  const scheduleJoinRetry = useCallback(() => {
    const attempt = joinRetryRef.current;
    if (attempt >= JOIN_RETRY_DELAYS_MS.length) return false;
    const delay = JOIN_RETRY_DELAYS_MS[attempt];
    joinRetryRef.current = attempt + 1;
    if (joinRetryTimerRef.current) clearTimeout(joinRetryTimerRef.current);
    joinRetryTimerRef.current = setTimeout(() => {
      joinRetryTimerRef.current = null;
      joinedRef.current = false;
      joinRoom();
    }, delay);
    huddleLog("socket", { event: "join-retry-scheduled", attempt: attempt + 1, delayMs: delay });
    return true;
  }, [joinRoom]);

  // Live view of other participants' typing state, shared with listener
  // closures defined inside the connection effect.
  const typingMapRef = useRef<Map<string, { name: string; timer: ReturnType<typeof setTimeout>; until: number }>>(new Map());

  useEffect(() => {
    if (!roomId || !name) return;

    let socket: Socket | null = null;

    // Defer socket creation by one macrotask so React StrictMode cleanup
    // can cancel before a WebSocket is actually opened.
    const timer = setTimeout(() => {
      socket = io({ transports: ["websocket"] });
      socketRef.current = socket;
      setSocket(socket);

      const onConnect = () => {
        setConnected(true);
        // Mark as not-joined so a reconnect re-issues the join using the
        // latest readiness signal from the caller (see `joinRoom`).
        joinedRef.current = false;
        if (wantsJoinRef.current) {
          joinRoom();
        }
      };

      const onDisconnect = (reason: string) => {
        setConnected(false);
        // Allow `joinRoom` to rejoin on the next connect once the caller
        // reinstalls signaling listeners.
        joinedRef.current = false;
        // Only treat as an unexpected disconnection when we had joined the
        // room and the client did not initiate the disconnect (intentional
        // leave navigates away and disconnects with reason "client namespace
        // disconnect" / "io client disconnect").
        if (wantsJoinRef.current && reason !== "io client disconnect") {
          playDisconnectedSound();
        }
      };

      const onError = (data: { message: string }) => {
        huddleLog("socket", { event: "join-error", message: data.message });
        // Transient errors during an automatic rejoin (stale participant
        // entry not yet evicted, room inside its empty-room grace window)
        // must NOT kick the user — retry with backoff instead. Only surface
        // the error (and let RoomPage navigate away) once retries are
        // exhausted or the error is genuinely fatal (bad password, full).
        if (wantsJoinRef.current && TRANSIENT_JOIN_ERRORS.has(data.message)) {
          joinedRef.current = false;
          if (scheduleJoinRetry()) return;
          huddleLog("socket", { event: "join-retry-exhausted", message: data.message });
        }
        setJoinError(data.message);
        socket!.disconnect();
      };

      const onRoomJoined = (data: { participants: Participant[]; chatHistory: ChatEntry[]; screenSharer: string | null }) => {
        huddleLog("socket", { event: "room-joined-received", participantCount: data.participants.length });
        joinRetryRef.current = 0;
        if (joinRetryTimerRef.current) {
          clearTimeout(joinRetryTimerRef.current);
          joinRetryTimerRef.current = null;
        }
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
        const typingState = typingMapRef.current;
        const t = typingState.get(id);
        if (t) {
          clearTimeout(t.timer);
          typingState.delete(id);
          setTypingUsers((prev) => prev.filter((n) => n !== t.name));
        }
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

      const setTypingFromMap = (map: Map<string, { name: string; until: number }>) => {
        const now = Date.now();
        setTypingUsers(
          [...map.values()]
            .filter((u) => u.until > now)
            .map((u) => u.name)
            .reverse(),
        );
      };

      const onChatMessage = (msg: ChatMessage) => {
        setChatHistory((prev) => {
          const next = [...prev, msg];
          return next.length > MAX_CLIENT_CHAT ? next.slice(-MAX_CLIENT_CHAT) : next;
        });
        // Clear this sender's typing indicator and play a cue only for
        // messages from other participants (server broadcasts to all).
        const typingState = typingMapRef.current;
        if (typingState.delete(msg.senderId)) setTypingFromMap(typingState);
        if (msg.senderId !== socket!.id) playMessageSound();
      };

      const onTyping = ({ senderId, senderName }: { senderId: string; senderName: string }) => {
        if (senderId === socket!.id) return;
        const typingState = typingMapRef.current;
        const existing = typingState.get(senderId);
        if (existing) clearTimeout(existing.timer);
        // Auto-expire if the user stops typing without sending (e.g. closes
        // the tab) — matches the server's timeout plus a small grace period.
        const timer = setTimeout(() => {
          typingState.delete(senderId);
          setTypingFromMap(typingState);
        }, 5000);
        typingState.set(senderId, { name: senderName, timer, until: Date.now() + 4500 });
        setTypingFromMap(typingState);
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
      socket.on("typing", onTyping);
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
      joinRetryRef.current = 0;
      if (joinRetryTimerRef.current) {
        clearTimeout(joinRetryTimerRef.current);
        joinRetryTimerRef.current = null;
      }
      if (socket) {
        socket.removeAllListeners();
        socket.disconnect();
        socketRef.current = null;
        setSocket(null);
      }
    };
  }, [roomId, name, password, joinRoom, scheduleJoinRetry]);

  return { socket, participants, chatHistory, connected, joinError, currentScreenSharer, typingUsers, notifyTyping, joinRoom };
}

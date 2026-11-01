import { useEffect, useRef, useState, useCallback } from "react";
import { io } from "socket.io-client";
import type { AppSocket, Participant, ChatMessage, ChatEntry, PollMessage, JoinErrorCode, ReactionUser } from "../types";
import { isPollMessage, MAX_CHAT_HISTORY } from "../types";
import { appendCapped } from "../lib/chatHistory";
import { claimClientKey } from "../lib/clientKey";
import { keepImageSessionOpen } from "../lib/imageUpload";
import { playJoinSound, playLeaveSound, playMessageSound, playDisconnectedSound } from "../lib/notificationSounds";
import { errorName, huddleLog, huddleWarn } from "../lib/huddleLog";
import { joinRetryDelay, shouldRetryJoin } from "../lib/joinRetry";

interface UseSocketOptions {
  roomId: string;
  name: string;
  password?: string;
}

export interface UseSocketReturn {
  socket: AppSocket | null;
  /** Our stable identity in this room (see message senderId); null until joined. */
  userId: string | null;
  /** See ImageSessionContext. */
  imageSession: number;
  participants: Participant[];
  chatHistory: ChatEntry[];
  pinnedMessageId: string | null;
  connected: boolean;
  joinError: string | null;
  currentScreenSharer: string | null;
  typingUsers: string[];
  notifyTyping: () => void;
  joinRoom: () => void;
}

export function useSocket({ roomId, name, password }: UseSocketOptions): UseSocketReturn {
  const socketRef = useRef<AppSocket | null>(null);
  const [socket, setSocket] = useState<AppSocket | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [imageSession, setImageSession] = useState(0);
  // Read by listener closures defined inside the connection effect.
  const userIdRef = useRef<string | null>(null);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [chatHistory, setChatHistory] = useState<ChatEntry[]>([]);
  const [pinnedMessageId, setPinnedMessageId] = useState<string | null>(null);
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
  const hasJoinedRef = useRef(false);
  // Retry bookkeeping for transient join errors (see isTransientJoinError).
  const joinRetryRef = useRef(0);
  const joinRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const joinRoom = useCallback(() => {
    wantsJoinRef.current = true;
    const sock = socketRef.current;
    if (!sock || !sock.connected || joinedRef.current) return;
    joinedRef.current = true;
    void claimClientKey().then((clientKey) => {
      // The socket may have dropped during the claim; onConnect joins again.
      if (socketRef.current !== sock || !sock.connected || !joinedRef.current) return;
      const { roomId: rid, name: nm, password: pw } = joinArgsRef.current;
      huddleLog("socket", { event: "join-room-emit", roomId: rid });
      sock.emit("join-room", { roomId: rid, name: nm, password: pw, clientKey });
    });
  }, []);

  // Re-emit join-room after a backoff delay. Used when the server rejected a
  // rejoin with a transient error; the situation typically resolves itself
  // within a few seconds.
  const scheduleJoinRetry = useCallback(() => {
    const attempt = joinRetryRef.current;
    const delay = joinRetryDelay(attempt);
    if (delay === null) return false;
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

    let socket: AppSocket | null = null;
    let stopImageSession: (() => void) | undefined;
    const typingState = typingMapRef.current;

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
        stopImageSession?.();
        // Allow `joinRoom` to rejoin on the next connect once the caller
        // reinstalls signaling listeners.
        joinedRef.current = false;
        // Structured diagnostics: a transport drop tears down every peer in
        // `useWebRTC` (`resetAllPeers`), so the disconnect reason is essential
        // context for one-way-audio / "Connecting…" incidents. Socket.IO
        // reasons are coarse enums (no PII).
        huddleLog("socket", { event: "disconnect", reason });
        // Only treat as an unexpected disconnection when we had joined the
        // room and the client did not initiate the disconnect (intentional
        // leave navigates away and disconnects with reason "client namespace
        // disconnect" / "io client disconnect").
        if (wantsJoinRef.current && reason !== "io client disconnect") {
          playDisconnectedSound();
        }
      };

      // A failed WebSocket handshake (proxy idle timeout, DNS, TLS, server
      // restart) surfaces here — previously it only appeared as a browser
      // network error with no app context. Socket.IO auto-retries; we log
      // enough to correlate with the peer teardown/rejoin timeline.
      socket.on("connect_error", (err: Error) => {
        huddleWarn("socket", { event: "connect-error", error: errorName(err) });
      });

      const onError = (data: { code: JoinErrorCode; message: string }) => {
        huddleLog("socket", { event: "join-error", code: data.code });
        // Transient errors during an automatic rejoin must NOT kick the user —
        // retry with backoff instead. Only surface the error (and let RoomPage
        // navigate away) on a first join, once retries are exhausted, or when
        // it is genuinely fatal (bad password, full).
        if (wantsJoinRef.current && shouldRetryJoin(hasJoinedRef.current, data.code)) {
          joinedRef.current = false;
          if (scheduleJoinRetry()) return;
          huddleLog("socket", { event: "join-retry-exhausted", code: data.code });
        }
        setJoinError(data.message);
        socket!.disconnect();
      };

      const onRoomJoined = (data: { userId: string; participants: Participant[]; chatHistory: ChatEntry[]; pinnedMessageId: string | null; screenSharer: string | null }) => {
        huddleLog("socket", { event: "room-joined-received", participantCount: data.participants.length });
        hasJoinedRef.current = true;
        joinRetryRef.current = 0;
        if (joinRetryTimerRef.current) {
          clearTimeout(joinRetryTimerRef.current);
          joinRetryTimerRef.current = null;
        }
        userIdRef.current = data.userId;
        setUserId(data.userId);
        // Re-opened on every join: the session belongs to the room's membership.
        stopImageSession?.();
        stopImageSession = keepImageSessionOpen(roomId, socket!.id ?? "", () => setImageSession((n) => n + 1));
        setParticipants(data.participants);
        setChatHistory(data.chatHistory.slice(-MAX_CHAT_HISTORY));
        setPinnedMessageId(data.pinnedMessageId);
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
        setChatHistory((prev) => appendCapped(prev, msg));
        // Clear this sender's typing indicator and play a cue only for
        // messages from other participants (server broadcasts to all).
        // The typing map is keyed by socket id and messages carry the userId,
        // so match on the name, which is unique among live participants.
        for (const [id, typing] of typingState) {
          if (typing.name === msg.senderName) {
            clearTimeout(typing.timer);
            typingState.delete(id);
            setTypingFromMap(typingState);
          }
        }
        if (msg.senderId !== userIdRef.current) playMessageSound();
      };

      const onTyping = ({ senderId, senderName }: { senderId: string; senderName: string }) => {
        const existing = typingState.get(senderId);
        if (existing) clearTimeout(existing.timer);
        // Auto-expire if the user stops typing without sending (e.g. closes
        // the tab). The server only relays, so this is the only timeout.
        const timer = setTimeout(() => {
          typingState.delete(senderId);
          setTypingFromMap(typingState);
        }, 5000);
        typingState.set(senderId, { name: senderName, timer, until: Date.now() + 4500 });
        setTypingFromMap(typingState);
      };

      const onChatReactionUpdate = ({ messageId, reactions }: { messageId: string; reactions: Record<string, ReactionUser[]> }) => {
        setChatHistory((prev) =>
          prev.map((entry) =>
            entry.id === messageId && !isPollMessage(entry)
              ? { ...entry, reactions }
              : entry,
          ),
        );
      };

      const onPollCreate = (poll: PollMessage) => {
        setChatHistory((prev) => appendCapped(prev, poll));
      };

      const onPollUpdate = (poll: PollMessage) => {
        setChatHistory((prev) =>
          prev.map((entry) => (entry.id === poll.id ? poll : entry)),
        );
      };

      const onChatMessageEdit = ({ messageId, text }: { messageId: string; text: string }) => {
        setChatHistory((prev) =>
          prev.map((entry) =>
            entry.id === messageId && !isPollMessage(entry)
              ? { ...entry, text, edited: true }
              : entry,
          ),
        );
      };

      const onChatMessageDelete = ({ messageId }: { messageId: string }) => {
        setChatHistory((prev) => prev.filter((entry) => entry.id !== messageId));
        // The server clears the pin on delete without sending a pin update.
        setPinnedMessageId((prev) => (prev === messageId ? null : prev));
      };

      const onChatPinUpdate = ({ pinnedMessageId: id }: { pinnedMessageId: string | null }) => {
        setPinnedMessageId(id);
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
      for (const { timer: typingTimer } of typingState.values()) clearTimeout(typingTimer);
      typingState.clear();
      setTypingUsers([]);
      stopImageSession?.();
      setImageSession(0);
      if (socket) {
        socket.removeAllListeners();
        socket.disconnect();
        socketRef.current = null;
        setSocket(null);
      }
    };
  }, [roomId, name, password, joinRoom, scheduleJoinRetry]);

  return { socket, userId, imageSession, participants, chatHistory, pinnedMessageId, connected, joinError, currentScreenSharer, typingUsers, notifyTyping, joinRoom };
}

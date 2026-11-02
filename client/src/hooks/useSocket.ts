import { useEffect, useRef, useState, useCallback } from "react";
import { io } from "socket.io-client";
import type { AppSocket, Participant, JoinErrorCode, RoomClosedReason, RoomSettings, ServerToClientEvents, WaitingPerson } from "../types";
import { claimClientKey } from "../lib/clientKey";
import { keepImageSessionOpen } from "../lib/imageUpload";
import { playDisconnectedSound } from "../lib/notificationSounds";
import { subscribeRoomSounds } from "../lib/roomSounds";
import { errorName, huddleLog, huddleWarn } from "../lib/huddleLog";
import { joinRetryDelay, shouldRetryJoin } from "../lib/joinRetry";
import { closingDeadline, KICKED_NOTICE, roomClosedMessage, type RoomClosingDeadline } from "../lib/roomClosure";
import { clearRoomEntry, roomEntryFor } from "../lib/roomEntry";

interface UseSocketOptions {
  roomId: string;
  name: string;
  /** Sent with each join, so a rejoin is announced with the current state. */
  isMuted: boolean;
}

/** Why this client has to leave the room: a failed join, or a notice for the main screen. */
export type RoomExit = { error: string } | { notice: string };

export interface UseSocketReturn {
  socket: AppSocket | null;
  /** Our stable identity in this room (see message senderId); null until joined. */
  userId: string | null;
  /** Authorizes image requests for this connection; null until joined. */
  httpToken: string | null;
  /** See ImageSessionContext. */
  imageSession: number;
  participants: Participant[];
  connected: boolean;
  exit: RoomExit | null;
  currentScreenSharer: string | null;
  /** Set while the room is within a closing warning. */
  closing: RoomClosingDeadline | null;
  /** Null until joined. */
  settings: RoomSettings | null;
  /** This client is in the room's waiting room. */
  isWaiting: boolean;
  /** Who is waiting to be accepted. Owners only. */
  waitingList: WaitingPerson[];
  /** Someone an owner tried to accept while the room was full. */
  admitRefusedId: string | null;
  joinRoom: () => void;
}

export function useSocket({ roomId, name, isMuted }: UseSocketOptions): UseSocketReturn {
  const socketRef = useRef<AppSocket | null>(null);
  const [socket, setSocket] = useState<AppSocket | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [httpToken, setHttpToken] = useState<string | null>(null);
  const [imageSession, setImageSession] = useState(0);
  // Read by listener closures defined inside the connection effect.
  const userIdRef = useRef<string | null>(null);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [connected, setConnected] = useState(false);
  const [exit, setExit] = useState<RoomExit | null>(null);
  const [currentScreenSharer, setCurrentScreenSharer] = useState<string | null>(null);
  const [closing, setClosing] = useState<RoomClosingDeadline | null>(null);
  const [settings, setSettings] = useState<RoomSettings | null>(null);
  const [isWaiting, setIsWaiting] = useState(false);
  const [waitingList, setWaitingList] = useState<WaitingPerson[]>([]);
  const [admitRefusedId, setAdmitRefusedId] = useState<string | null>(null);
  // Room-join coordination: `joinRoom()` is invoked by the caller only after
  // the WebRTC signaling listeners have been installed, so the server cannot
  // emit `room-joined`/`offer`/`ice-candidate` before this client is ready to
  // handle them. We also re-join automatically after a transport reconnect so
  // a dropped socket does not leave the user stranded in the room.
  const joinArgsRef = useRef({ roomId, name, isMuted });
  joinArgsRef.current = { roomId, name, isMuted };
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
      const args = joinArgsRef.current;
      huddleLog("socket", { event: "join-room-emit", roomId: args.roomId });
      sock.emit("join-room", { ...args, ...roomEntryFor(args.roomId), clientKey });
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

  useEffect(() => {
    if (!roomId || !name) return;

    let socket: AppSocket | null = null;
    let stopImageSession: (() => void) | undefined;
    let wasWaiting = false;

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
        setHttpToken(null);
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
        clearRoomEntry();
        setExit({ error: data.message });
        socket!.disconnect();
      };

      const onRoomJoined = (data: Parameters<ServerToClientEvents["room-joined"]>[0]) => {
        huddleLog("socket", { event: "room-joined-received", participantCount: data.participants.length });
        hasJoinedRef.current = true;
        clearRoomEntry();
        setIsWaiting(false);
        // The server ignored any change while waiting, and announced the state the
        // join carried. Nothing else would send it again until it next changes.
        if (wasWaiting) socket!.emit("mute-toggle", { isMuted: joinArgsRef.current.isMuted });
        wasWaiting = false;
        setSettings(data.settings ?? null);
        joinRetryRef.current = 0;
        if (joinRetryTimerRef.current) {
          clearTimeout(joinRetryTimerRef.current);
          joinRetryTimerRef.current = null;
        }
        userIdRef.current = data.userId;
        setUserId(data.userId);
        setHttpToken(data.httpToken);
        // Re-opened on every join: the session belongs to the room's membership.
        stopImageSession?.();
        stopImageSession = keepImageSessionOpen(roomId, data.httpToken, () => setImageSession((n) => n + 1));
        setParticipants(data.participants);
        setCurrentScreenSharer(data.screenSharer);
        setClosing(closingDeadline(data.closing));
      };

      // Not a drop to recover from, so nothing may rejoin.
      const endWithNotice = (notice: string) => {
        wantsJoinRef.current = false;
        setExit({ notice });
        socket!.disconnect();
      };

      const onRoomClosed = ({ reason }: { reason: RoomClosedReason }) => {
        huddleLog("socket", { event: "room-closed", reason });
        endWithNotice(roomClosedMessage(reason));
      };

      const onParticipantJoined = (p: Participant) => {
        setParticipants((prev) => [...prev.filter((x) => x.id !== p.id), p]);
      };

      const onParticipantLeft = ({ id }: { id: string }) => {
        setParticipants((prev) => prev.filter((p) => p.id !== id));
        setCurrentScreenSharer((prev) => (prev === id ? null : prev));
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

      socket.on("connect", onConnect);
      socket.on("disconnect", onDisconnect);
      socket.on("error", onError);
      socket.on("room-joined", onRoomJoined);
      socket.on("room-closing", (notice) => setClosing(closingDeadline(notice)));
      socket.on("room-closed", onRoomClosed);
      socket.on("room-settings", setSettings);
      socket.on("kicked", () => endWithNotice(KICKED_NOTICE));
      socket.on("join-waiting", () => {
        wasWaiting = true;
        setIsWaiting(true);
      });
      socket.on("waiting-list", setWaitingList);
      socket.on("admit-refused", ({ id }) => setAdmitRefusedId(id));
      socket.on("participant-joined", onParticipantJoined);
      socket.on("participant-left", onParticipantLeft);
      socket.on("participant-muted", onParticipantMuted);
      socket.on("screen-share-started", onScreenShareStarted);
      socket.on("screen-share-stopped", onScreenShareStopped);
      subscribeRoomSounds(socket, () => userIdRef.current);
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
      stopImageSession?.();
      setHttpToken(null);
      setImageSession(0);
      if (socket) {
        socket.removeAllListeners();
        socket.disconnect();
        socketRef.current = null;
        setSocket(null);
      }
    };
  }, [roomId, name, joinRoom, scheduleJoinRetry]);

  return { socket, userId, httpToken, imageSession, participants, connected, exit, currentScreenSharer, closing, settings, isWaiting, waitingList, admitRefusedId, joinRoom };
}

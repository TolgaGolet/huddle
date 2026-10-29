import { Router } from "express";
import { nanoid } from "nanoid";
import { randomBytes } from "node:crypto";
import { MAX_PARTICIPANTS, MAX_PASSWORD_LENGTH } from "./limits.js";
import { parseCreateRoom } from "./validation.js";

export interface Participant {
  id: string;
  name: string;
  isMuted: boolean;
}

export interface ChatMessage {
  id: string;
  senderId: string;
  senderName: string;
  text: string;
  timestamp: number;
  reactions: Record<string, string[]>;
  replyTo?: {
    id: string;
    senderName: string;
    text: string;
    imageUrl?: string;
  };
  gifUrl?: string;
  imageUrls?: string[];
  encrypted?: boolean;
  edited?: boolean;
  pinned?: boolean;
}

export interface PollOption {
  id: string;
  text: string;
  voterIds: string[];
  voterNames: string[];
}

export interface PollMessage {
  id: string;
  type: "poll";
  senderId: string;
  senderName: string;
  question: string;
  options: PollOption[];
  allowMultiple: boolean;
  timestamp: number;
}

export type ChatEntry = ChatMessage | PollMessage;

export interface Room {
  id: string;
  password: string | null;
  participants: Map<string, Participant>;
  chatHistory: ChatEntry[];
  encryptionSalt: string | null;
  /** Lazily derived image-encryption key (see `roomImageKey` in imageCrypto.ts). */
  imageKey: Promise<Buffer> | null;
  pinnedMessageId: string | null;
  /** Set at creation and when the last participant leaves; the room is deleted once this age exceeds ROOM_GRACE_MS. */
  emptySince: number | null;
}

const MAX_CHAT_HISTORY = 200;

/**
 * Grace period before an empty room is deleted. When every participant's
 * socket drops at once (shared network hiccup, server blip), each client's
 * Socket.IO auto-reconnect re-joins within seconds. Deleting the room
 * immediately would make every rejoin fail with "Room not found" and kick
 * all users back to the landing page, so we keep the room alive briefly.
 */
export const ROOM_GRACE_MS = 60_000;

const rooms = new Map<string, Room>();

/** socket.id -> id of the room that socket has joined. Maintained by add/removeParticipant. */
export const socketRoomMap = new Map<string, string>();

export interface RoomCtx {
  roomId: string;
  room: Room;
  participant: Participant;
}

/** Resolve the room and participant this socket has joined, if any. */
export function resolveParticipant(socketId: string): RoomCtx | null {
  const roomId = socketRoomMap.get(socketId);
  if (!roomId) return null;
  const room = getRoom(roomId);
  const participant = room?.participants.get(socketId);
  if (!room || !participant) return null;
  return { roomId, room, participant };
}

/**
 * Reactions are keyed by client-supplied emoji, so they must not inherit
 * Object.prototype: with a plain `{}`, keys like "constructor" or "__proto__"
 * would read or replace inherited members instead of acting as plain keys.
 */
export function emptyReactions(): Record<string, string[]> {
  return Object.create(null) as Record<string, string[]>;
}

export function createRoom(password?: string): Room {
  const id = nanoid(6);
  const room: Room = {
    id,
    password: password || null,
    participants: new Map(),
    chatHistory: [],
    pinnedMessageId: null,
    encryptionSalt: password ? randomBytes(16).toString("base64url") : null,
    imageKey: null,
    // A new room is empty: if nobody ever joins, it expires like any other.
    emptySince: Date.now(),
  };
  rooms.set(id, room);
  return room;
}

export function verifyPassword(roomId: string, password?: string): boolean {
  const room = rooms.get(roomId);
  if (!room) return false;
  if (!room.password) return true;
  return room.password === password;
}

type RoomDestroyedListener = (roomId: string) => void;
const roomDestroyedListeners = new Set<RoomDestroyedListener>();

/**
 * Register cleanup for room resources (e.g. uploaded images). Fires after a
 * room is permanently deleted by any path. Returns an unsubscribe function.
 */
export function onRoomDestroyed(fn: RoomDestroyedListener): () => void {
  roomDestroyedListeners.add(fn);
  return () => roomDestroyedListeners.delete(fn);
}

function isExpired(room: Room, now: number): boolean {
  return room.participants.size === 0 && room.emptySince !== null && now - room.emptySince > ROOM_GRACE_MS;
}

// Every deletion goes through here so listeners can't be skipped.
function deleteRoom(id: string): void {
  rooms.delete(id);
  roomDestroyedListeners.forEach((fn) => fn(id));
}

export function getRoom(id: string): Room | undefined {
  const room = rooms.get(id);
  if (!room) return undefined;
  // Lazy purge: an empty room past its grace period is treated as gone.
  if (isExpired(room, Date.now())) {
    deleteRoom(id);
    return undefined;
  }
  return room;
}

/**
 * Sweep all rooms and permanently delete any that have been empty longer
 * than ROOM_GRACE_MS (backstop for the lazy purge in getRoom()).
 */
export function purgeExpiredRooms(): void {
  const now = Date.now();
  for (const [id, room] of rooms) {
    if (isExpired(room, now)) deleteRoom(id);
  }
}

export function isNameTaken(roomId: string, name: string): boolean {
  const room = rooms.get(roomId);
  if (!room) return false;
  const lower = name.toLowerCase();
  for (const p of room.participants.values()) {
    if (p.name.toLowerCase() === lower) return true;
  }
  return false;
}

export function isRoomFull(roomId: string): boolean {
  const room = rooms.get(roomId);
  if (!room) return false;
  return room.participants.size >= MAX_PARTICIPANTS;
}

export function getParticipantCount(roomId: string): number {
  const room = rooms.get(roomId);
  return room ? room.participants.size : 0;
}

export function addParticipant(roomId: string, socketId: string, name: string): Participant | null {
  const room = rooms.get(roomId);
  if (!room) return null;
  room.emptySince = null;
  const participant: Participant = { id: socketId, name, isMuted: false };
  room.participants.set(socketId, participant);
  socketRoomMap.set(socketId, roomId);
  return participant;
}

export function removeParticipant(roomId: string, socketId: string): void {
  socketRoomMap.delete(socketId);
  const room = rooms.get(roomId);
  if (!room) return;
  room.participants.delete(socketId);
  if (room.participants.size === 0) {
    // Don't delete immediately: every participant may be reconnecting after
    // a shared network blip. The room is purged (lazily via getRoom() or by
    // purgeExpiredRooms()) once ROOM_GRACE_MS elapses with no rejoin.
    room.emptySince = Date.now();
  }
}

export function setMuted(roomId: string, socketId: string, isMuted: boolean): void {
  const room = rooms.get(roomId);
  if (!room) return;
  const p = room.participants.get(socketId);
  if (p) p.isMuted = isMuted;
}

export function addChatMessage(roomId: string, msg: ChatEntry): void {
  const room = rooms.get(roomId);
  if (!room) return;
  room.chatHistory.push(msg);
  if (room.chatHistory.length > MAX_CHAT_HISTORY) {
    room.chatHistory.shift();
  }
}

export function getChatHistory(roomId: string): ChatEntry[] {
  return getRoom(roomId)?.chatHistory ?? [];
}

export function getParticipantsArray(roomId: string): Participant[] {
  const room = getRoom(roomId);
  if (!room) return [];
  return Array.from(room.participants.values());
}

export const router = Router();

router.post("/rooms", (req, res) => {
  const body = parseCreateRoom(req.body ?? {});
  if (!body) {
    // Only the password field is user-controlled; anything else is a malformed request.
    const tooLong = typeof req.body?.password === "string" && req.body.password.length > MAX_PASSWORD_LENGTH;
    res.status(400).json({ error: tooLong ? `Password must be at most ${MAX_PASSWORD_LENGTH} characters` : "Invalid request" });
    return;
  }
  const room = createRoom(body.password);
  res.json({ roomId: room.id });
});

router.get("/rooms/:id", (req, res) => {
  const room = getRoom(req.params.id);
  if (!room) {
    res.json({ exists: false, hasPassword: false, participantCount: 0, maxParticipants: MAX_PARTICIPANTS });
    return;
  }
  res.json({
    exists: true,
    hasPassword: !!room.password,
    participantCount: room.participants.size,
    maxParticipants: MAX_PARTICIPANTS,
  });
});

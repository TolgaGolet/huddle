import { Router } from "express";
import { nanoid } from "nanoid";
import { randomBytes } from "node:crypto";
import { MAX_CHAT_HISTORY, MAX_PARTICIPANTS, MAX_PASSWORD_LENGTH } from "./limits.js";
import { isPollMessage, type Participant, type ReactionUser, type ChatMessage, type PollOption, type PollMessage, type ChatEntry } from "./protocol.js";
import { parseCreateRoom } from "./validation.js";

export type { Participant, ReactionUser, ChatMessage, PollOption, PollMessage, ChatEntry };

export interface Room {
  id: string;
  password: string | null;
  participants: Map<string, Participant>;
  chatHistory: ChatEntry[];
  encryptionSalt: string | null;
  /** Lazily derived image-encryption key (see `roomImageKey` in imageCrypto.ts). */
  imageKey: Promise<Buffer> | null;
  /** Bytes of uploaded images stored or reserved, checked against MAX_ROOM_IMAGE_BYTES. */
  imageBytes: number;
  /** Size of each stored image by filename, released when its message goes. */
  imageSizes: Map<string, number>;
  /** Bytes reserved by this room's decrypting reads, checked against MAX_ROOM_INFLIGHT_READ_BYTES. */
  inFlightReadBytes: number;
  pinnedMessageId: string | null;
  /** socket.id of the participant sharing their screen. */
  screenSharerId: string | null;
  /** Set at creation and when the last participant leaves; the room is deleted once this age exceeds ROOM_GRACE_MS. */
  emptySince: number | null;
}

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

// Kept apart from Participant, which is broadcast to the whole room.
const httpTokenSockets = new Map<string, string>();
const socketHttpTokens = new Map<string, string>();

/**
 * The secret proving an HTTP request comes from this socket's owner, sent only
 * to them. It ends with their membership. Never broadcast or log it.
 */
export function httpTokenFor(socketId: string): string | undefined {
  return socketHttpTokens.get(socketId);
}

function revokeHttpToken(socketId: string): void {
  const token = socketHttpTokens.get(socketId);
  if (token) httpTokenSockets.delete(token);
  socketHttpTokens.delete(socketId);
}

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

export function resolveParticipantByHttpToken(token: string): RoomCtx | null {
  const socketId = httpTokenSockets.get(token);
  return socketId ? resolveParticipant(socketId) : null;
}

/**
 * Reactions are keyed by client-supplied emoji, so they must not inherit
 * Object.prototype: with a plain `{}`, keys like "constructor" or "__proto__"
 * would read or replace inherited members instead of acting as plain keys.
 */
export function emptyReactions(): Record<string, ReactionUser[]> {
  return Object.create(null) as Record<string, ReactionUser[]>;
}

export function createRoom(password?: string): Room {
  const id = nanoid(6);
  const room: Room = {
    id,
    password: password || null,
    participants: new Map(),
    chatHistory: [],
    pinnedMessageId: null,
    screenSharerId: null,
    encryptionSalt: password ? randomBytes(16).toString("base64url") : null,
    imageBytes: 0,
    imageSizes: new Map(),
    inFlightReadBytes: 0,
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

/** Without a `userId` the identity lasts only as long as this connection. */
export function addParticipant(roomId: string, socketId: string, name: string, userId = socketId, isMuted = false): Participant | null {
  const room = rooms.get(roomId);
  if (!room) return null;
  room.emptySince = null;
  const participant: Participant = { id: socketId, userId, name, isMuted };
  room.participants.set(socketId, participant);
  socketRoomMap.set(socketId, roomId);
  revokeHttpToken(socketId);
  const token = randomBytes(32).toString("base64url");
  httpTokenSockets.set(token, socketId);
  socketHttpTokens.set(socketId, token);
  return participant;
}

export function removeParticipant(roomId: string, socketId: string): void {
  socketRoomMap.delete(socketId);
  revokeHttpToken(socketId);
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
    removeMessage(roomId, room.chatHistory[0].id);
  }
}

type MessageRemovedListener = (room: Room, entry: ChatEntry) => void;
const messageRemovedListeners = new Set<MessageRemovedListener>();

/** Register cleanup for a removed message (e.g. its images). Returns an unsubscribe function. */
export function onMessageRemoved(fn: MessageRemovedListener): () => void {
  messageRemovedListeners.add(fn);
  return () => messageRemovedListeners.delete(fn);
}

// Every removal goes through here so the pin and listeners can't be skipped.
export function removeMessage(roomId: string, messageId: string): void {
  const room = rooms.get(roomId);
  if (!room) return;
  const index = room.chatHistory.findIndex((m) => m.id === messageId);
  if (index < 0) return;
  const [entry] = room.chatHistory.splice(index, 1);
  if (room.pinnedMessageId === messageId) room.pinnedMessageId = null;
  // A quote must not outlive its original, or deleted words reach later joiners.
  for (const m of room.chatHistory) {
    if (!isPollMessage(m) && m.replyTo?.id === messageId) delete m.replyTo;
  }
  messageRemovedListeners.forEach((fn) => fn(room, entry));
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

import { nanoid } from "nanoid";
import { randomBytes } from "node:crypto";
import { MAX_CHAT_HISTORY, MAX_PARTICIPANTS, MAX_REMEMBERED_MEMBERS } from "./limits.js";
import { isPollMessage, type RoomPermissions, type Participant, type ReactionUser, type ChatMessage, type PollOption, type PollMessage, type ChatEntry } from "./protocol.js";

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
  /** Checked against MAX_ROOMS_PER_IP. Never broadcast or log it. */
  creatorIp: string | null;
  /** Random secret returned to the creator, whose first join makes them owner. Single use. */
  ownerToken: string | null;
  /** userIds. Kept across reconnects, so an owner keeps the role if they return. */
  owners: Set<string>;
  /** When the last owner present disappeared; see promoteAfterGrace. */
  ownerlessSince: number | null;
  settings: RoomPermissions;
  /** userIds that got in, who can return without the password until they leave on purpose. */
  memberIds: Set<string>;
  /** Removed by an owner: these go to the waiting room if they come back. */
  blockedUsers: Set<string>;
  blockedIps: Set<string>;
  /** By socket.id. */
  waiting: Map<string, WaitingEntry>;
  createdAt: number;
  /** Last speech, chat or join. See roomLifetime.ts, which closes the room once this is too old. */
  lastActivityAt: number;
}

export interface WaitingEntry {
  id: string;
  name: string;
  userId: string | undefined;
  wasRemoved: boolean;
  /** Brings them into the room. False, with them still waiting, if it's full. */
  admit: () => boolean;
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

const DEFAULT_ROOM_PERMISSIONS: Readonly<RoomPermissions> = {
  pinPermission: "everyone",
  screenSharePermission: "everyone",
  waitingRoom: false,
};

export function createRoom(password?: string, creatorIp: string | null = null, permissions: Partial<RoomPermissions> = {}): Room {
  // An open room's link is its only protection, so the id must be unguessable.
  const id = nanoid(21);
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
    creatorIp,
    ownerToken: randomBytes(32).toString("base64url"),
    owners: new Set(),
    ownerlessSince: null,
    settings: { ...DEFAULT_ROOM_PERMISSIONS, ...permissions },
    memberIds: new Set(),
    blockedUsers: new Set(),
    blockedIps: new Set(),
    waiting: new Map(),
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
  };
  rooms.set(id, room);
  return room;
}

export function hasPermission(room: Room, permission: "pinPermission" | "screenSharePermission", userId: string): boolean {
  return room.settings[permission] === "everyone" || room.owners.has(userId);
}

export function rememberMember(room: Room, userId: string): void {
  room.memberIds.add(userId);
  // A Set iterates oldest first. Open rooms let anyone in, so this must stay bounded.
  if (room.memberIds.size > MAX_REMEMBERED_MEMBERS) {
    room.memberIds.delete(room.memberIds.values().next().value as string);
  }
}

export function verifyPassword(room: Room, password?: string): boolean {
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
  // People waiting are told by the lifetime sweep, which then closes the room.
  return room.waiting.size === 0 && room.participants.size === 0 && room.emptySince !== null && now - room.emptySince > ROOM_GRACE_MS;
}

// Every deletion goes through here so listeners can't be skipped.
function deleteRoom(id: string): void {
  rooms.delete(id);
  roomDestroyedListeners.forEach((fn) => fn(id));
}

export function allRooms(): IterableIterator<Room> {
  return rooms.values();
}

export function touchRoom(room: Room, now = Date.now()): void {
  room.lastActivityAt = now;
}

/** Ends a room with people in it. Telling them and disconnecting them is the caller's job. */
export function closeRoom(id: string): void {
  const room = rooms.get(id);
  if (!room) return;
  for (const socketId of room.participants.keys()) {
    socketRoomMap.delete(socketId);
    revokeHttpToken(socketId);
  }
  room.participants.clear();
  deleteRoom(id);
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

export function roomCount(): number {
  return rooms.size;
}

export function roomCountForIp(ip: string): number {
  let count = 0;
  for (const room of rooms.values()) {
    if (room.creatorIp === ip) count++;
  }
  return count;
}

/** Summed on demand: a running total could drift from the many places that change a room's bytes. */
export function totalImageBytes(): number {
  let total = 0;
  for (const room of rooms.values()) total += room.imageBytes;
  return total;
}

/** `leaving` are about to be removed, so they neither hold a name nor take up a place. */
export function isNameTaken(room: Room, name: string, leaving: Participant[]): boolean {
  const lower = name.toLowerCase();
  for (const p of room.participants.values()) {
    if (p.name.toLowerCase() === lower && !leaving.includes(p)) return true;
  }
  return false;
}

export function isRoomFull(room: Room, leaving: Participant[]): boolean {
  return room.participants.size - leaving.length >= MAX_PARTICIPANTS;
}

/** Without a `userId` the identity lasts only as long as this connection. */
export function addParticipant(room: Room, socketId: string, name: string, userId = socketId, isMuted = false): Participant {
  room.emptySince = null;
  touchRoom(room);
  const participant: Participant = { id: socketId, userId, name, isMuted };
  room.participants.set(socketId, participant);
  socketRoomMap.set(socketId, room.id);
  revokeHttpToken(socketId);
  const token = randomBytes(32).toString("base64url");
  httpTokenSockets.set(token, socketId);
  socketHttpTokens.set(socketId, token);
  return participant;
}

export function removeParticipant(roomId: string, socketId: string): void {
  socketRoomMap.delete(socketId);
  revokeHttpToken(socketId);
  const room = getRoom(roomId);
  if (!room) return;
  room.participants.delete(socketId);
  if (room.participants.size === 0) {
    // Don't delete immediately: every participant may be reconnecting after
    // a shared network blip. The room is purged (lazily via getRoom() or by
    // purgeExpiredRooms()) once ROOM_GRACE_MS elapses with no rejoin.
    room.emptySince = Date.now();
  }
}

export function setMuted(room: Room, socketId: string, isMuted: boolean): void {
  const p = room.participants.get(socketId);
  if (p) p.isMuted = isMuted;
}

export function findEntry(room: Room, id: string): ChatEntry | undefined {
  return room.chatHistory.find((m) => m.id === id);
}

export function addChatMessage(room: Room, msg: ChatEntry): void {
  room.chatHistory.push(msg);
  if (room.chatHistory.length > MAX_CHAT_HISTORY) {
    removeMessage(room, room.chatHistory[0].id);
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
export function removeMessage(room: Room, messageId: string): void {
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

export function getParticipantsArray(room: Room): Participant[] {
  return Array.from(room.participants.values());
}

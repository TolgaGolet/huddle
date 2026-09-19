import { Router } from "express";
import { nanoid } from "nanoid";
import { randomBytes } from "node:crypto";

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
  pinnedMessageId: string | null;
  /** Set when the last participant leaves; the room is deleted once this age exceeds ROOM_GRACE_MS. */
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

/**
 * Maximum participants per room. Huddle uses a peer-to-peer mesh topology
 * where each client maintains a direct WebRTC connection with every other
 * participant, so quality degrades sharply beyond a small group. This cap
 * keeps calls reliable on typical consumer hardware/connections.
 */
export const MAX_PARTICIPANTS = 6;

const rooms = new Map<string, Room>();

export function createRoom(password?: string): Room {
  const id = nanoid(6);
  const room: Room = {
    id,
    password: password || null,
    participants: new Map(),
    chatHistory: [],
    pinnedMessageId: null,
    encryptionSalt: password ? randomBytes(16).toString("base64url") : null,
    emptySince: null,
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

export function getRoom(id: string): Room | undefined {
  const room = rooms.get(id);
  if (!room) return undefined;
  // Lazy purge: an empty room past its grace period is treated as gone.
  if (
    room.participants.size === 0 &&
    room.emptySince !== null &&
    Date.now() - room.emptySince > ROOM_GRACE_MS
  ) {
    rooms.delete(id);
    return undefined;
  }
  return room;
}

/**
 * Permanently delete a room regardless of its grace period. Returns true if
 * the room existed and was deleted. Callers use this to clean up room
 * resources (e.g. uploaded images) once the room is truly gone.
 */
export function destroyRoom(id: string): boolean {
  return rooms.delete(id);
}

/**
 * Sweep all rooms and permanently delete any that have been empty longer
 * than ROOM_GRACE_MS. Returns the ids of the destroyed rooms so callers can
 * clean up associated resources (e.g. uploaded images).
 */
export function purgeExpiredRooms(): string[] {
  const now = Date.now();
  const destroyed: string[] = [];
  for (const [id, room] of rooms) {
    if (
      room.participants.size === 0 &&
      room.emptySince !== null &&
      now - room.emptySince > ROOM_GRACE_MS
    ) {
      rooms.delete(id);
      destroyed.push(id);
    }
  }
  return destroyed;
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
  return participant;
}

export function removeParticipant(roomId: string, socketId: string): void {
  const room = rooms.get(roomId);
  if (!room) return;
  room.participants.delete(socketId);
  if (room.participants.size === 0) {
    // Don't delete immediately: every participant may be reconnecting after
    // a shared network blip. The room is purged lazily via getRoom() once
    // ROOM_GRACE_MS elapses with no rejoin.
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
  const { password } = req.body as { password?: string };
  const room = createRoom(password);
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

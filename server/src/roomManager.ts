import { Router } from "express";
import { nanoid } from "nanoid";

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
  };
  gifUrl?: string;
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
}

const MAX_CHAT_HISTORY = 200;

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
  const room: Room = { id, password: password || null, participants: new Map(), chatHistory: [] };
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
  return rooms.get(id);
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
  const participant: Participant = { id: socketId, name, isMuted: false };
  room.participants.set(socketId, participant);
  return participant;
}

export function removeParticipant(roomId: string, socketId: string): void {
  const room = rooms.get(roomId);
  if (!room) return;
  room.participants.delete(socketId);
  if (room.participants.size === 0) {
    rooms.delete(roomId);
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

export function getParticipantsArray(roomId: string): Participant[] {
  const room = rooms.get(roomId);
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
  const room = rooms.get(req.params.id);
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

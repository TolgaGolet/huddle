// The wire protocol, shared by both builds like limits.ts (client/src/types/index.ts
// re-exports it). Types only, so it erases from the server's tsc output. Import
// nothing here except other shared files, so the client can compile it. These
// types are compile-time claims: any client can send anything, so server input
// still goes through the parsers in validation.ts.

import type { JoinErrorCode } from "./joinErrors.js";

export interface Participant {
  /** socket.id: routing only (signaling, mute, screen share). Changes on reconnect. */
  id: string;
  /** Identity for ownership, votes and reactions. Survives reconnects (see identity.ts). */
  userId: string;
  name: string;
  isMuted: boolean;
}

export interface ReactionUser {
  userId: string;
  name: string;
}

export interface ChatMessage {
  id: string;
  senderId: string;
  senderName: string;
  text: string;
  timestamp: number;
  reactions: Record<string, ReactionUser[]>;
  replyTo?: {
    id: string;
    senderName: string;
    text: string;
    imageUrl?: string;
  };
  gifUrl?: string;
  imageUrls?: string[];
  edited?: boolean;
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

// Structural copies of RTCSessionDescriptionInit and RTCIceCandidateInit: the
// server has no DOM lib. The server relays these without reading them.
export interface SessionDescription {
  type: "answer" | "offer" | "pranswer" | "rollback";
  sdp?: string;
}

export interface IceCandidate {
  candidate?: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

export interface ClientToServerEvents {
  "join-room": (data: { roomId: string; name: string; password?: string; clientKey?: string }) => void;
  offer: (data: { to: string; offer: SessionDescription }) => void;
  answer: (data: { to: string; answer: SessionDescription }) => void;
  "ice-candidate": (data: { to: string; candidate: IceCandidate }) => void;
  "mute-toggle": (data: { isMuted: boolean }) => void;
  "screen-share-started": () => void;
  "screen-share-stopped": () => void;
  typing: () => void;
  "chat-message": (data: Pick<ChatMessage, "text" | "replyTo" | "gifUrl" | "imageUrls">) => void;
  "chat-reaction": (data: { messageId: string; emoji: string }) => void;
  "chat-edit": (data: { messageId: string; text: string }) => void;
  "chat-delete": (data: { messageId: string }) => void;
  "chat-pin": (data: { messageId: string }) => void;
  "poll-create": (data: { question: string; options: string[]; allowMultiple: boolean }) => void;
  "poll-vote": (data: { pollId: string; optionId: string }) => void;
}

export interface ServerToClientEvents {
  error: (data: { code: JoinErrorCode; message: string }) => void;
  "rate-limited": (data: { event: string }) => void;
  "room-joined": (data: {
    userId: string;
    participants: Participant[];
    chatHistory: ChatEntry[];
    pinnedMessageId: string | null;
    screenSharer: string | null;
  }) => void;
  "participant-joined": (participant: Participant) => void;
  "participant-left": (data: { id: string }) => void;
  "participant-muted": (data: { id: string; isMuted: boolean }) => void;
  "screen-share-started": (data: { id: string }) => void;
  "screen-share-stopped": (data: { id: string }) => void;
  offer: (data: { from: string; offer: SessionDescription }) => void;
  answer: (data: { from: string; answer: SessionDescription }) => void;
  "ice-candidate": (data: { from: string; candidate: IceCandidate }) => void;
  typing: (data: { senderId: string; senderName: string }) => void;
  "chat-message": (msg: ChatMessage) => void;
  "chat-reaction-update": (data: { messageId: string; reactions: Record<string, ReactionUser[]> }) => void;
  "chat-message-edit": (data: { messageId: string; text: string }) => void;
  "chat-message-delete": (data: { messageId: string }) => void;
  "chat-pin-update": (data: { pinnedMessageId: string | null }) => void;
  "poll-create": (poll: PollMessage) => void;
  "poll-update": (poll: PollMessage) => void;
}

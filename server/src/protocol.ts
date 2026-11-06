// The wire protocol, shared by both builds like limits.ts (client/src/types/index.ts
// re-exports it). Import nothing here except other shared files, so the client
// can compile it. These types are compile-time claims: any client can send
// anything, so server input still goes through the parsers in validation.ts.

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
  /** Set only by the server, on the message announcing a watch party. */
  watchInvite?: { partyId: string; videoId: string };
}

// Keeps a quote from doubling a message's weight in the room-joined history.
const MAX_REPLY_QUOTE_LENGTH = 200;

/** A reply's quote of `text`. Shared, so an edit changes every copy the same way. */
export function quoteText(text: string): string {
  // By code point, so a cut can't split an emoji.
  return [...text].slice(0, MAX_REPLY_QUOTE_LENGTH).join("");
}

export interface GifItem {
  id: string;
  title: string;
  preview: string;
  url: string;
}

export interface PollOption {
  id: string;
  text: string;
  voters: ReactionUser[];
}

export interface PollMessage {
  id: string;
  type: "poll";
  senderId: string;
  senderName: string;
  question: string;
  options: PollOption[];
  allowMultiple: boolean;
  /** A vote, once cast, can't be changed; votes arrive through `poll-submit`. */
  lockVotes: boolean;
  timestamp: number;
  /** Server time after which votes are refused. */
  endsAt?: number;
  /** Set by the server when `endsAt` passes, so clients don't depend on their own clocks. */
  closed?: boolean;
}

export type PollCreate = { question: string; options: string[]; allowMultiple: boolean; lockVotes: boolean; durationMs?: number };

/** Shared so the client's disabled options match what the server accepts. */
export function isPollOpen(poll: PollMessage, now: number): boolean {
  return !poll.closed && (poll.endsAt === undefined || now < poll.endsAt);
}

/** Whether the user is among a reaction's users (or an option's voters). */
export function hasReacted(users: ReactionUser[], userId: string): boolean {
  return users.some((u) => u.userId === userId);
}

export function hasVotedInPoll(poll: PollMessage, userId: string): boolean {
  return poll.options.some((o) => hasReacted(o.voters, userId));
}

export type ChatEntry = ChatMessage | PollMessage;

/** Who may do something in a room. */
export type RoomPermission = "everyone" | "owners";

export interface RoomPermissions {
  pinPermission: RoomPermission;
  screenSharePermission: RoomPermission;
  /** Text, GIFs, images, polls and edits. Reactions, votes and deleting stay open to all (owners can delete anyone's). */
  messagePermission: RoomPermission;
  /** Newcomers wait for an owner's approval. */
  waitingRoom: boolean;
}

/** The settings that say who may do something, as opposed to on/off switches. */
export type PermissionKey = { [K in keyof RoomPermissions]: RoomPermissions[K] extends RoomPermission ? K : never }[keyof RoomPermissions];

/** Shared so the client's disabled controls match what the server enforces. Missing settings allow everything. */
export function permits(settings: RoomPermissions | null | undefined, permission: PermissionKey, isOwner: boolean): boolean {
  return settings?.[permission] !== "owners" || isOwner;
}

/** Senders delete their own messages; owners can delete anyone's. */
export function mayDeleteMessage(senderId: string, userId: string, isOwner: boolean): boolean {
  return senderId === userId || isOwner;
}

/** Plain text only: GIFs, images and watch-party invites can't be edited. Shared so the client offers Edit only where the server allows it. */
export function hasEditableContent(msg: Pick<ChatMessage, "gifUrl" | "imageUrls" | "watchInvite">): boolean {
  return !msg.gifUrl && !msg.imageUrls?.length && !msg.watchInvite;
}

/** What stands in for a message's text in previews and quotes when it has none. */
export function attachmentLabel(msg: Pick<ChatMessage, "imageUrls" | "watchInvite">): string {
  if (msg.watchInvite) return "[Watch party]";
  return msg.imageUrls?.length ? "[Image]" : "[GIF]";
}

/** Whom an owner can kick, promote or demote: anyone else present but the room's creator. */
export function isModeratable(targetId: string, actorId: string, creatorId: string | null): boolean {
  return targetId !== actorId && targetId !== creatorId;
}

/** Sent to the whole room, so it never holds the password. */
export interface RoomSettings extends RoomPermissions {
  hasPassword: boolean;
  /** userIds. */
  ownerIds: string[];
  /** userId of the room's creator, whom other owners can't kick or demote. */
  creatorId: string | null;
}

export interface WaitingPerson {
  /** socket.id. */
  id: string;
  name: string;
  /** An owner removed this person, or someone on their network, earlier. */
  wasRemoved: boolean;
}

export type RoomClosingReason = "inactive" | "lifetime";
/** "empty": nobody was left to let in those still in the waiting room. */
export type RoomClosedReason = RoomClosingReason | "empty";

export interface RoomClosing {
  reason: RoomClosingReason;
  /** A duration, not a time, so that a client's wrong clock doesn't matter. */
  remainingMs: number;
}

export type WatchPlaybackState = "playing" | "paused";

export interface WatchPlayback {
  state: WatchPlaybackState;
  /** Seconds into the video when this was sent. */
  position: number;
  rate: number;
}

/** A room's watch party, as sent to everyone in the room. */
export interface WatchPartyState {
  id: string;
  /** userId of whoever controls the video when others may not change it. */
  hostId: string;
  allowOthersToChange: boolean;
  videoId: string;
  /** userIds, in the order they joined. */
  memberIds: string[];
  playback: WatchPlayback;
}

/** Where playback is `elapsedMs` after `playback` was true. */
export function projectPosition(playback: WatchPlayback, elapsedMs: number): number {
  if (playback.state !== "playing" || elapsedMs <= 0) return playback.position;
  return playback.position + (elapsedMs / 1000) * playback.rate;
}

/** Shared so the client offers the change-video input only to those the server lets use it. */
export function mayChangeWatchVideo(party: Pick<WatchPartyState, "hostId" | "allowOthersToChange">, userId: string): boolean {
  return party.allowOthersToChange || party.hostId === userId;
}

export function isPollMessage(entry: ChatEntry): entry is PollMessage {
  return "type" in entry && entry.type === "poll";
}

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
  "join-room": (data: { roomId: string; name: string; password?: string; clientKey?: string; isMuted?: boolean; ownerToken?: string }) => void;
  offer: (data: { to: string; offer: SessionDescription }) => void;
  answer: (data: { to: string; answer: SessionDescription }) => void;
  "ice-candidate": (data: { to: string; candidate: IceCandidate }) => void;
  "mute-toggle": (data: { isMuted: boolean }) => void;
  "screen-share-started": () => void;
  "screen-share-stopped": () => void;
  typing: () => void;
  /** `replyToId` only: the server builds the quote, so it can't be forged. */
  "chat-message": (data: Pick<ChatMessage, "text" | "gifUrl" | "imageUrls"> & { replyToId?: string }) => void;
  "chat-reaction": (data: { messageId: string; emoji: string }) => void;
  "chat-edit": (data: { messageId: string; text: string }) => void;
  "chat-delete": (data: { messageId: string }) => void;
  "chat-pin": (data: { messageId: string }) => void;
  "poll-create": (data: PollCreate) => void;
  /** Toggles one vote. Refused for polls with `lockVotes`. */
  "poll-vote": (data: { pollId: string; optionId: string }) => void;
  /** All of a user's votes at once, for polls with `lockVotes`. */
  "poll-submit": (data: { pollId: string; optionIds: string[] }) => void;
  /** This client's user is speaking. Media is peer-to-peer, so the server can't tell otherwise. */
  "voice-activity": () => void;
  "set-owner": (data: { userId: string; isOwner: boolean }) => void;
  "kick-participant": (data: { userId: string }) => void;
  "update-room-settings": (data: Partial<RoomPermissions>) => void;
  /** An empty password makes the room open. */
  "change-room-password": (data: { password: string }) => void;
  "admit-waiting": (data: { id: string }) => void;
  /** Starts the room's watch party and announces it in the chat. The id comes from parseYouTubeVideoId (youtube.ts). */
  "watch-start": (data: { videoId: string; allowOthersToChange: boolean }) => void;
  "watch-join": (data: { partyId: string }) => void;
  "watch-leave": () => void;
  "watch-change-video": (data: { videoId: string }) => void;
  /** A member played, paused, sought or changed speed, in the video they name (stale ones are dropped). */
  "watch-playback": (data: WatchPlayback & { videoId: string }) => void;
}

export interface ServerToClientEvents {
  error: (data: { code: JoinErrorCode; message: string }) => void;
  "rate-limited": (data: { event: string }) => void;
  /** Something the room's settings didn't allow was dropped, e.g. a message sent as they changed. */
  "not-permitted": (data: { event: string }) => void;
  "room-joined": (data: {
    userId: string;
    /** Authorizes this client's image requests. Sent only to its owner. */
    httpToken: string;
    participants: Participant[];
    chatHistory: ChatEntry[];
    pinnedMessageId: string | null;
    screenSharer: string | null;
    /** Set if the room is already within a closing warning. */
    closing: RoomClosing | null;
    settings: RoomSettings;
    watchParty: WatchPartyState | null;
  }) => void;
  "participant-joined": (participant: Participant) => void;
  "participant-left": (data: { id: string; userId: string }) => void;
  "participant-muted": (data: { id: string; isMuted: boolean }) => void;
  "screen-share-started": (data: { id: string }) => void;
  "screen-share-stopped": (data: { id: string }) => void;
  offer: (data: { from: string; offer: SessionDescription }) => void;
  answer: (data: { from: string; answer: SessionDescription }) => void;
  "ice-candidate": (data: { from: string; candidate: IceCandidate }) => void;
  typing: (data: { userId: string; senderName: string }) => void;
  "chat-message": (msg: ChatMessage) => void;
  "chat-reaction-update": (data: { messageId: string; reactions: Record<string, ReactionUser[]> }) => void;
  "chat-message-edit": (data: { messageId: string; text: string }) => void;
  "chat-message-delete": (data: { messageId: string }) => void;
  "chat-pin-update": (data: { pinnedMessageId: string | null }) => void;
  "poll-create": (poll: PollMessage) => void;
  "poll-update": (poll: PollMessage) => void;
  /** A closing warning, or null once activity has cancelled it. */
  "room-closing": (closing: RoomClosing | null) => void;
  "room-closed": (data: { reason: RoomClosedReason }) => void;
  "room-settings": (settings: RoomSettings) => void;
  /** An owner removed this client from the room. */
  kicked: () => void;
  /** This client is in the waiting room, until an owner accepts. */
  "join-waiting": () => void;
  /** Sent to owners only. */
  "waiting-list": (people: WaitingPerson[]) => void;
  /** To the owner who tried: the person couldn't come in because the room is full. */
  "admit-refused": (data: { id: string }) => void;
  "room-password-result": (data: { ok: boolean }) => void;
  /** The room's watch party changed (members, video, settings), or ended (null). */
  "watch-party": (party: WatchPartyState | null) => void;
  /** Another member changed playback. Sent to members only. */
  "watch-playback": (data: WatchPlayback) => void;
  /** Only one watch party at a time: one was already running. */
  "watch-start-refused": (data: { reason: "active" }) => void;
}

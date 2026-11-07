// Runtime guards for Socket.IO payloads. TypeScript annotations on socket
// handlers are compile-time claims only: any client (stale build or crafted
// packet) can send anything. Each parser takes the raw payload and returns a
// normalized value or null; handlers registered through socketRoute.ts never
// see a payload that failed its parser.
//
// The user-facing limits live in limits.ts, which the client also imports.

import type { ChatMessage } from "./roomManager.js";
import type { PollCreate, RoomPermission, RoomPermissions, WatchPlayback } from "./protocol.js";
import { YOUTUBE_VIDEO_ID_PATTERN } from "./youtube.js";
import {
  CLIENT_KEY_PATTERN,
  isValidNewPassword,
  MAX_CHAT_TEXT_LENGTH,
  MAX_IMAGES_PER_MESSAGE,
  MAX_NAME_LENGTH,
  MAX_PASSWORD_LENGTH,
  MAX_POLL_OPTION_LENGTH,
  MAX_POLL_OPTIONS,
  MAX_POLL_QUESTION_LENGTH,
  MAX_WATCH_POSITION_S,
  MAX_WATCH_QUEUE,
  POLL_DURATIONS_MS,
  WATCH_RATES,
} from "./limits.js";

const MAX_ID_LENGTH = 32;
const MAX_EMOJI_LENGTH = 32;
const MAX_URL_LENGTH = 2048;
const MAX_OWNER_TOKEN_LENGTH = 64;

type UnknownRecord = Record<string, unknown>;

function isRecord(v: unknown): v is UnknownRecord {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A string no longer than `max`, else null. */
function str(v: unknown, max: number): string | null {
  return typeof v === "string" && v.length <= max ? v : null;
}

/** A non-empty trimmed string no longer than `max`, else null. */
function trimmedStr(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t && t.length <= max ? t : null;
}

/** Undefined passes through; anything else must satisfy `parse`. */
function optional<T>(v: unknown, parse: (v: unknown) => T | null): T | undefined | null {
  return v === undefined ? undefined : parse(v);
}

const id = (v: unknown) => trimmedStr(v, MAX_ID_LENGTH);
const url = (v: unknown) => str(v, MAX_URL_LENGTH);

/** For events whose payload is ignored (typing, screen-share, disconnect). */
export function noPayload(): Record<string, never> {
  return {};
}

/** Trimmed in this one parser so that create and join can't disagree over stray spaces. */
const password = (v: unknown) => (typeof v === "string" ? str(v.trim(), MAX_PASSWORD_LENGTH) : null);

const clientKey = (v: unknown) => (typeof v === "string" && CLIENT_KEY_PATTERN.test(v) ? v : null);

const bool = (v: unknown) => (typeof v === "boolean" ? v : null);

export function parseJoinRoom(
  raw: unknown,
): { roomId: string; name: string; password?: string; clientKey?: string; isMuted?: boolean; ownerToken?: string } | null {
  if (!isRecord(raw)) return null;
  const roomId = id(raw.roomId);
  const name = trimmedStr(raw.name, MAX_NAME_LENGTH);
  const pw = optional(raw.password, password);
  const key = optional(raw.clientKey, clientKey);
  const isMuted = optional(raw.isMuted, bool);
  const ownerToken = optional(raw.ownerToken, (v) => str(v, MAX_OWNER_TOKEN_LENGTH));
  if (!roomId || !name || pw === null || key === null || isMuted === null || ownerToken === null) return null;
  return { roomId, name, password: pw, clientKey: key, isMuted, ownerToken };
}

/**
 * POST /api/rooms body. Uses the same password limit as join-room so a room
 * can never be created with a password its creator is unable to join with. Only
 * creating has a minimum, so a join's answer never depends on the guess's length.
 */
export function parseCreateRoom(raw: unknown): { password?: string; permissions: Partial<RoomPermissions> } | null {
  if (!isRecord(raw)) return null;
  const pw = optional(raw.password, password);
  if (pw === null) return null;
  if (typeof raw.password === "string" && !isValidNewPassword(raw.password)) return null;
  const permissions = permissionsFrom(raw);
  return permissions && { password: pw, permissions };
}

const permission = (v: unknown): RoomPermission | null => (v === "everyone" || v === "owners" ? v : null);

/** The permission fields present in `raw`, or null if one is invalid. Rebuilt, so nothing else gets through. */
function permissionsFrom(raw: UnknownRecord): Partial<RoomPermissions> | null {
  const pinPermission = optional(raw.pinPermission, permission);
  const screenSharePermission = optional(raw.screenSharePermission, permission);
  const messagePermission = optional(raw.messagePermission, permission);
  const waitingRoom = optional(raw.waitingRoom, bool);
  if (pinPermission === null || screenSharePermission === null || messagePermission === null || waitingRoom === null) return null;
  const result: Partial<RoomPermissions> = {};
  if (pinPermission) result.pinPermission = pinPermission;
  if (screenSharePermission) result.screenSharePermission = screenSharePermission;
  if (messagePermission) result.messagePermission = messagePermission;
  if (waitingRoom !== undefined) result.waitingRoom = waitingRoom;
  return result;
}

export function parseRoomPermissions(raw: unknown): Partial<RoomPermissions> | null {
  return isRecord(raw) ? permissionsFrom(raw) : null;
}

export function parseSetOwner(raw: unknown): { userId: string; isOwner: boolean } | null {
  if (!isRecord(raw)) return null;
  const userId = id(raw.userId);
  const isOwner = bool(raw.isOwner);
  return userId && isOwner !== null ? { userId, isOwner } : null;
}

export function parseKick(raw: unknown): { userId: string } | null {
  const userId = isRecord(raw) ? id(raw.userId) : null;
  return userId ? { userId } : null;
}

export function parseAdmitWaiting(raw: unknown): { id: string } | null {
  const socketId = isRecord(raw) ? id(raw.id) : null;
  return socketId ? { id: socketId } : null;
}

/** The same rule as creating a room; empty removes the password. */
export function parseChangePassword(raw: unknown): { password: string } | null {
  if (!isRecord(raw) || typeof raw.password !== "string" || !isValidNewPassword(raw.password)) return null;
  return { password: raw.password.trim() };
}

/** Socket.IO's reason for a disconnect, which is a bare string. */
export function parseDisconnect(raw: unknown): { reason: string } {
  return { reason: typeof raw === "string" ? raw : "" };
}

/** Well above real SDP, including a video m-line for screen share, and real ICE candidates. */
const MAX_RELAY_LENGTH = { offer: 32 * 1024, answer: 32 * 1024, candidate: 2 * 1024 };

/**
 * offer/answer/ice-candidate relays. The SDP/candidate body is forwarded
 * opaquely to the peer, up to a size that keeps relayed traffic small; we
 * only require it to be an object so the peer gets the shape it expects.
 * A null candidate is the end-of-candidates signal and is allowed.
 */
export function parseRelay(
  key: "offer" | "answer" | "candidate",
): (raw: unknown) => { to: string; body: unknown } | null {
  return (raw) => {
    if (!isRecord(raw)) return null;
    const to = id(raw.to);
    const body = raw[key];
    const bodyOk = isRecord(body) || (key === "candidate" && body === null);
    if (!to || !bodyOk || JSON.stringify(body).length > MAX_RELAY_LENGTH[key]) return null;
    return { to, body };
  };
}

/** A relay with no body: only the target peer. */
export function parseRelayTarget(raw: unknown): { to: string } | null {
  const to = isRecord(raw) ? id(raw.to) : null;
  return to ? { to } : null;
}

export function parseMute(raw: unknown): { isMuted: boolean } | null {
  const isMuted = isRecord(raw) ? bool(raw.isMuted) : null;
  return isMuted === null ? null : { isMuted };
}

type ParsedChatMessage = Pick<ChatMessage, "text" | "gifUrl" | "imageUrls"> & { replyToId?: string };

function parseImageUrls(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.length > MAX_IMAGES_PER_MESSAGE) return null;
  return v.every((u) => url(u) !== null) ? (v as string[]) : null;
}

/**
 * Shape and size only. Content rules (non-empty message, GIPHY CDN prefix,
 * room-scoped image URLs) stay in chatHandler.ts. Only the text is required:
 * a malformed optional field (gifUrl, replyToId, imageUrls) is dropped rather
 * than failing the whole message, which the sender has already cleared.
 */
export function parseChatMessage(raw: unknown): ParsedChatMessage | null {
  if (!isRecord(raw)) return null;
  const text = str(raw.text ?? "", MAX_CHAT_TEXT_LENGTH);
  if (text === null) return null;
  return {
    text: text.trim(),
    replyToId: id(raw.replyToId) ?? undefined,
    gifUrl: url(raw.gifUrl) ?? undefined,
    imageUrls: parseImageUrls(raw.imageUrls) ?? undefined,
  };
}

export function parseChatReaction(raw: unknown): { messageId: string; emoji: string } | null {
  if (!isRecord(raw)) return null;
  const messageId = id(raw.messageId);
  const emoji = trimmedStr(raw.emoji, MAX_EMOJI_LENGTH);
  if (!messageId || !emoji) return null;
  return { messageId, emoji };
}

export function parseChatEdit(raw: unknown): { messageId: string; text: string } | null {
  if (!isRecord(raw)) return null;
  const messageId = id(raw.messageId);
  const text = trimmedStr(raw.text, MAX_CHAT_TEXT_LENGTH);
  if (!messageId || !text) return null;
  return { messageId, text };
}

/** chat-delete and chat-pin. */
export function parseMessageId(raw: unknown): { messageId: string } | null {
  if (!isRecord(raw)) return null;
  const messageId = id(raw.messageId);
  return messageId ? { messageId } : null;
}

export function parsePollCreate(raw: unknown): PollCreate | null {
  if (!isRecord(raw)) return null;
  const question = trimmedStr(raw.question, MAX_POLL_QUESTION_LENGTH);
  if (!question || !Array.isArray(raw.options)) return null;
  // Blank options are dropped before counting, so only non-blank ones count
  // toward MAX_POLL_OPTIONS (the 64 KB message cap bounds the raw array).
  const options: string[] = [];
  for (const o of raw.options) {
    if (typeof o !== "string") return null;
    const t = o.trim();
    if (t.length > MAX_POLL_OPTION_LENGTH) return null;
    if (t) options.push(t);
  }
  if (options.length < 2 || options.length > MAX_POLL_OPTIONS) return null;
  const durationMs = optional(raw.durationMs, (v) => (typeof v === "number" && POLL_DURATIONS_MS.includes(v) ? v : null));
  if (durationMs === null) return null;
  const poll: PollCreate = { question, options, allowMultiple: raw.allowMultiple === true, lockVotes: raw.lockVotes === true };
  if (durationMs !== undefined) poll.durationMs = durationMs;
  return poll;
}

/** Distinct option ids, 1..MAX_POLL_OPTIONS of them. Whether they fit the poll is the handler's check. */
export function parsePollSubmit(raw: unknown): { pollId: string; optionIds: string[] } | null {
  if (!isRecord(raw) || !Array.isArray(raw.optionIds)) return null;
  const pollId = id(raw.pollId);
  if (!pollId || raw.optionIds.length < 1 || raw.optionIds.length > MAX_POLL_OPTIONS) return null;
  const optionIds: string[] = [];
  for (const o of raw.optionIds) {
    const optionId = id(o);
    if (!optionId || optionIds.includes(optionId)) return null;
    optionIds.push(optionId);
  }
  return { pollId, optionIds };
}

export function parsePollVote(raw: unknown): { pollId: string; optionId: string } | null {
  if (!isRecord(raw)) return null;
  const pollId = id(raw.pollId);
  const optionId = id(raw.optionId);
  if (!pollId || !optionId) return null;
  return { pollId, optionId };
}

/** The id parseYouTubeVideoId gives the client's form, so the two accept the same videos. */
const youtubeVideoId = (v: unknown) => (typeof v === "string" && YOUTUBE_VIDEO_ID_PATTERN.test(v) ? v : null);

export function parseWatchStart(raw: unknown): { videoId: string; allowOthersToChange: boolean } | null {
  if (!isRecord(raw)) return null;
  const videoId = youtubeVideoId(raw.videoId);
  return videoId ? { videoId, allowOthersToChange: raw.allowOthersToChange === true } : null;
}

export function parseWatchJoin(raw: unknown): { partyId: string } | null {
  const partyId = isRecord(raw) ? id(raw.partyId) : null;
  return partyId ? { partyId } : null;
}

export function parseWatchChangeVideo(raw: unknown): { videoId: string } | null {
  const videoId = isRecord(raw) ? youtubeVideoId(raw.videoId) : null;
  return videoId ? { videoId } : null;
}

/** Shaped like parseWatchJoin, for the events that name a party. */
export const parseWatchEnd = parseWatchJoin;

export const parseWatchQueueAdd = parseWatchChangeVideo;

export function parseWatchEntry(raw: unknown): { entryId: string } | null {
  const entryId = isRecord(raw) ? id(raw.entryId) : null;
  return entryId ? { entryId } : null;
}

export function parseWatchQueueMove(raw: unknown): { entryId: string; toIndex: number } | null {
  if (!isRecord(raw)) return null;
  const entryId = id(raw.entryId);
  const { toIndex } = raw;
  if (!entryId || typeof toIndex !== "number" || !Number.isInteger(toIndex) || toIndex < 0 || toIndex >= MAX_WATCH_QUEUE) return null;
  return { entryId, toIndex };
}

export function parseWatchPlayback(raw: unknown): (WatchPlayback & { entryId: string }) | null {
  if (!isRecord(raw)) return null;
  const { state, position, rate } = raw;
  const entryId = id(raw.entryId);
  if (!entryId) return null;
  if (state !== "playing" && state !== "paused") return null;
  if (typeof position !== "number" || !Number.isFinite(position)) return null;
  if (typeof rate !== "number" || !WATCH_RATES.includes(rate)) return null;
  return { entryId, state, position: Math.min(Math.max(position, 0), MAX_WATCH_POSITION_S), rate };
}

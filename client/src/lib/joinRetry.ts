import { JOIN_ERROR, type JoinErrorCode } from "../types";

const JOIN_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 15000];

/**
 * Errors that can occur transiently during an automatic rejoin after a
 * network blip (a server restart can leave the room briefly unavailable).
 * NAME_TAKEN isn't one: the server evicts our own stale entry by userId, so it
 * always means someone else has the name.
 */
export function isTransientJoinError(code: JoinErrorCode): boolean {
  return code === JOIN_ERROR.ROOM_NOT_FOUND;
}

/** Only a rejoin retries; a first join reports a dead link at once. */
export function shouldRetryJoin(hasJoined: boolean, code: JoinErrorCode): boolean {
  return hasJoined && isTransientJoinError(code);
}

/** Backoff before retry number `attempt` (from 0), or null once retries are exhausted. */
export function joinRetryDelay(attempt: number): number | null {
  return JOIN_RETRY_DELAYS_MS[attempt] ?? null;
}

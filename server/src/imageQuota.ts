import type { Response } from "express";
import { MAX_CLIENT_INFLIGHT_IMAGE_BYTES, MAX_INFLIGHT_IMAGE_BYTES } from "./limits.js";
import type { Room } from "./roomManager.js";

let inFlightImageBytes = 0;
const clientInFlightBytes = new Map<string, number>();

/** Whether `bytes` would fit the shared budget right now. Reserves nothing. */
export function imageMemoryFits(bytes: number): boolean {
  return inFlightImageBytes + bytes <= MAX_INFLIGHT_IMAGE_BYTES;
}

export interface ImageMemoryHold {
  /** Adds `bytes` to what this response holds, if they fit the shared budget. */
  take(bytes: number): boolean;
  /** Gives back bytes it no longer holds in memory. */
  give(bytes: number): void;
}

/**
 * A response's share of the budget, all given back when it closes. Taken as bytes
 * really arrive, not as declared: otherwise a request that declares a large size
 * and sends nothing would block everyone's images at no cost to its sender.
 */
export function holdImageMemory(res: Response): ImageMemoryHold {
  let held = 0;
  res.once("close", () => {
    inFlightImageBytes -= held;
    held = 0;
  });
  return {
    take(bytes) {
      // Already closed: the release above has run, so these bytes would leak for good.
      if (res.closed || !imageMemoryFits(bytes)) return false;
      inFlightImageBytes += bytes;
      held += bytes;
      return true;
    },
    give(bytes) {
      const given = Math.min(bytes, held);
      inFlightImageBytes -= given;
      held -= given;
    },
  };
}

/** Holds `bytes` of one client's share until the response closes, if they fit. */
export function tryReserveClientImageBytes(res: Response, client: string, bytes: number): boolean {
  const current = clientInFlightBytes.get(client) ?? 0;
  if (res.closed || current + bytes > MAX_CLIENT_INFLIGHT_IMAGE_BYTES) return false;
  clientInFlightBytes.set(client, current + bytes);
  res.once("close", () => {
    const remaining = (clientInFlightBytes.get(client) ?? bytes) - bytes;
    if (remaining > 0) clientInFlightBytes.set(client, remaining);
    else clientInFlightBytes.delete(client);
  });
  return true;
}

export interface Reservation {
  /** What is counted against the room for this upload now. */
  reservedBytes(): number;
  /** Counts `bytes` more against the room, for output larger than was declared. */
  grow(bytes: number): void;
  /** These bytes were stored, so they stay counted against the room. */
  commit(bytes: number): void;
  /** A store is running: the release waits for it, as only then is `commit` final. */
  trackStore(store: Promise<void>): void;
  /** Gives back what wasn't committed. Call once, when the response closes. */
  release(): Promise<void>;
}

/** Counts `bytes` against the room's quota straight away, until released. */
export function reserveRoomImageBytes(room: Room, bytes: number): Reservation {
  let reserved = bytes;
  let stored = 0;
  let store: Promise<void> | undefined;
  room.imageBytes += bytes;
  return {
    reservedBytes: () => reserved,
    grow(extra) {
      reserved += extra;
      room.imageBytes += extra;
    },
    commit(committed) {
      stored += committed;
    },
    trackStore(running) {
      store = running;
    },
    release() {
      return Promise.resolve(store).then(() => {
        room.imageBytes -= reserved - stored;
      });
    },
  };
}

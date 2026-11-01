import type { Response } from "express";
import { MAX_INFLIGHT_IMAGE_BYTES } from "./limits.js";
import type { Room } from "./roomManager.js";

let inFlightImageBytes = 0;

/** Holds `bytes` of the shared budget until the response closes, if they fit. */
export function tryReserveImageMemory(res: Response, bytes: number): boolean {
  // Already closed: the release below would never run, leaking the bytes for good.
  if (res.closed || inFlightImageBytes + bytes > MAX_INFLIGHT_IMAGE_BYTES) return false;
  inFlightImageBytes += bytes;
  res.once("close", () => {
    inFlightImageBytes -= bytes;
  });
  return true;
}

export interface Reservation {
  /** These bytes were stored, so they stay counted against the room. */
  commit(bytes: number): void;
  /** A store is running: the release waits for it, as only then is `commit` final. */
  trackStore(store: Promise<void>): void;
  /** Gives back what wasn't committed. Call once, when the response closes. */
  release(): Promise<void>;
}

/** Counts `bytes` against the room's quota straight away, until released. */
export function reserveRoomImageBytes(room: Room, bytes: number): Reservation {
  let stored = 0;
  let store: Promise<void> | undefined;
  room.imageBytes += bytes;
  return {
    commit(committed) {
      stored += committed;
    },
    trackStore(running) {
      store = running;
    },
    release() {
      return Promise.resolve(store).then(() => {
        room.imageBytes -= bytes - stored;
      });
    },
  };
}

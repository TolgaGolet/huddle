// Token buckets and the per-socket event limits, shared by both builds like
// limits.ts (client/src/types/index.ts re-exports this file). The server enforces
// them; the composer checks the same numbers first, so it can keep a draft the
// server would drop. Import only types from other shared files, so the client can
// compile it.
//
// Limits sit well above what a person can do, and signaling above what an ICE
// burst to five peers needs: they stop floods, not use.

import type { ClientToServerEvents } from "./protocol.js";

export interface RateLimit {
  burst: number;
  perSecond: number;
}

export interface Bucket {
  /** Spends one token; false if none is left. */
  take(): boolean;
  /** True if `take` would succeed, without spending anything. */
  hasToken(): boolean;
  /** True once refilled to `burst`, when forgetting the bucket loses nothing. */
  isFull(): boolean;
}

export function createBucket({ burst, perSecond }: RateLimit, now: () => number = Date.now): Bucket {
  let tokens = burst;
  let last = now();
  const refill = () => {
    const t = now();
    tokens = Math.min(burst, tokens + ((t - last) / 1000) * perSecond);
    last = t;
  };
  return {
    take() {
      refill();
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    },
    hasToken() {
      refill();
      return tokens >= 1;
    },
    isFull() {
      refill();
      return tokens >= burst;
    },
  };
}

export const RATE_LIMITS = {
  signaling: { burst: 300, perSecond: 50 },
  typing: { burst: 5, perSecond: 2 },
  messages: { burst: 20, perSecond: 2 },
  messageActions: { burst: 20, perSecond: 2 },
  reactions: { burst: 30, perSecond: 3 },
  callState: { burst: 20, perSecond: 2 },
  join: { burst: 10, perSecond: 0.2 },
  activity: { burst: 5, perSecond: 0.2 },
  moderation: { burst: 10, perSecond: 1 },
} as const satisfies Record<string, RateLimit>;

export type RateLimitGroup = keyof typeof RATE_LIMITS;

/** Client events sharing a bucket. Keyed by the protocol, so a new event must be added. */
export const EVENT_LIMITS: Readonly<Record<keyof ClientToServerEvents, RateLimitGroup>> = {
  offer: "signaling",
  answer: "signaling",
  "ice-candidate": "signaling",
  typing: "typing",
  "chat-message": "messages",
  "poll-create": "messages",
  "chat-edit": "messageActions",
  "chat-delete": "messageActions",
  "chat-pin": "messageActions",
  "chat-reaction": "reactions",
  "poll-vote": "reactions",
  "mute-toggle": "callState",
  "screen-share-started": "callState",
  "screen-share-stopped": "callState",
  "join-room": "join",
  "voice-activity": "activity",
  "set-owner": "moderation",
  "kick-participant": "moderation",
  "update-room-settings": "moderation",
  "change-room-password": "moderation",
  "admit-waiting": "moderation",
};

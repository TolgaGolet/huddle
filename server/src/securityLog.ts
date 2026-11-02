import type { RateLimitGroup } from "./rateLimit.js";

// Counts only, so this can never hold IPs, names, room ids or tokens.
type SecurityEvent =
  | "wrong_password"
  | "join_rate_limited"
  | `socket_limited_${RateLimitGroup}`
  | "http_rate_limited"
  | "connection_refused"
  | "origin_refused"
  | "capacity_refused"
  | "slow_client_evicted"
  | "upload_stalled"
  | "room_closed_inactive"
  | "room_closed_lifetime";

export const STATUS_LOG_INTERVAL_MS = 30 * 60 * 1000;

const counts = new Map<SecurityEvent, number>();

export function countSecurityEvent(event: SecurityEvent): void {
  counts.set(event, (counts.get(event) ?? 0) + 1);
}

/** What happened since the last call; events that didn't happen are absent. */
export function takeSecurityCounts(): Partial<Record<SecurityEvent, number>> {
  const taken = Object.fromEntries(counts);
  counts.clear();
  return taken;
}

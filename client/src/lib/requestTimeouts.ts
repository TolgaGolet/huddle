/** For small JSON requests. A stalled one would otherwise hang as long as the browser allows. */
export const REQUEST_TIMEOUT_MS = 10_000;

const UPLOAD_BASE_MS = 60_000;
/** 1 Mbps, a slow mobile uplink. */
const UPLOAD_BYTES_PER_MS = 125;

/** Scales with size: a flat limit would make a large batch always fail on a slow but working link. */
export function uploadTimeoutMs(bytes: number): number {
  return Math.ceil(UPLOAD_BASE_MS + bytes / UPLOAD_BYTES_PER_MS);
}

/** Far inside the room's inactivity limit, and within the server's rate limit. */
export const VOICE_REPORT_INTERVAL_MS = 30_000;

/** Calls `report` at most once per interval, however often speech is detected. */
export function createVoiceReporter(report: () => void, now: () => number = Date.now): () => void {
  let last = -Infinity;
  return () => {
    const t = now();
    if (t - last < VOICE_REPORT_INTERVAL_MS) return;
    last = t;
    report();
  };
}

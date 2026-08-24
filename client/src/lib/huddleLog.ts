/**
 * Always-on structured diagnostics logger for Huddle.
 *
 * These logs are emitted in BOTH development and production builds so the
 * "connected but no voice between a specific pair" bug can be diagnosed from a
 * single participant's browser console during a live occurrence. Logs are
 * event-driven (no periodic spam) and use a stable `[huddle:<scope>]` prefix so
 * they can be grepped/shipped from production.
 *
 * No media content is ever logged — only peer ids, negotiation states, and
 * WebRTC stat counters.
 */

/**
 * Whether extended/verbose logging is enabled. Defaults to ON per product
 * request so logs are captured during the bug's occurrence. Set
 * `VITE_HUDDLE_DEBUG=false` at build time to silence the noisiest categories
 * (currently: the periodic audio-stats sampler).
 */
export function huddleDebugEnabled(): boolean {
  const env = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;
  return env?.VITE_HUDDLE_DEBUG !== "false";
}

/**
 * Emit an always-on event log line under the `[huddle:<scope>]` namespace.
 * Safe to call with arbitrary values; values are serialized by the console.
 */
export function huddleLog(scope: string, ...args: unknown[]): void {
  // `console.log` (info) so it is visible in production console + log shippers.
  // eslint-disable-next-line no-console
  console.log(`[huddle:${scope}]`, ...args);
}

/**
 * Emit an always-on warning log line.
 */
export function huddleWarn(scope: string, ...args: unknown[]): void {
  // eslint-disable-next-line no-console
  console.warn(`[huddle:${scope}]`, ...args);
}

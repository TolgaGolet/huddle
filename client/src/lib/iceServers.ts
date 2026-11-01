function hasValidUrls(server: unknown): boolean {
  const urls = (server as { urls?: unknown } | null)?.urls;
  if (Array.isArray(urls)) return urls.length > 0 && urls.every((url) => typeof url === "string");
  return typeof urls === "string";
}

/**
 * The servers in a `VITE_ICE_SERVERS` value, or null if it isn't a non-empty JSON
 * `RTCIceServer[]`. Also runs from vite.config.ts, to fail the build. The value can
 * hold TURN credentials, so callers must never log it.
 */
export function parseIceServers(raw: string): RTCIceServer[] | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length > 0 && parsed.every(hasValidUrls) ? (parsed as RTCIceServer[]) : null;
  } catch {
    return null;
  }
}

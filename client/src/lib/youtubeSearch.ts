import type { YouTubeSearchErrorCode, YouTubeSearchResult } from "../types";
import { errorName } from "./huddleLog";
import { REQUEST_TIMEOUT_MS } from "./requestTimeouts";

/** A failed search, with the server's stable code (never matched on the text). */
export class YouTubeSearchError extends Error {
  override name = "YouTubeSearchError";
  constructor(readonly code: YouTubeSearchErrorCode | "timeout" | "network") {
    super(code);
  }
}

const KNOWN_CODES: ReadonlySet<string> = new Set<YouTubeSearchErrorCode>(["search-unavailable", "search-failed", "not-permitted", "invalid-query"]);

/** Searches through the server's proxy (youtubeRouter.ts), which only those who may control a party can use. */
export async function searchYouTube(query: string, httpToken: string, signal: AbortSignal): Promise<YouTubeSearchResult[]> {
  let res: Response;
  try {
    res = await fetch(`/api/youtube/search?q=${encodeURIComponent(query)}`, {
      headers: { "X-Participant-Token": httpToken },
      signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    });
  } catch (err) {
    const name = errorName(err);
    if (name === "AbortError") throw err;
    throw new YouTubeSearchError(name === "TimeoutError" ? "timeout" : "network");
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { code?: unknown };
    const code = typeof body.code === "string" && KNOWN_CODES.has(body.code) ? (body.code as YouTubeSearchErrorCode) : "search-failed";
    throw new YouTubeSearchError(code);
  }
  const json = (await res.json()) as { data?: YouTubeSearchResult[] };
  return json.data ?? [];
}

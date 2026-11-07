import { createBucket, type Bucket } from "./rateLimit.js";
import { errorSummary } from "./errorLog.js";
import { TtlCache } from "./ttlCache.js";
import type { YouTubeSearchResult } from "./protocol.js";

// YouTube Data API v3 for search, and keyless oEmbed for titles. Upstream URLs
// contain the API key, so they must never reach logs or error messages.

const API_BASE = "https://www.googleapis.com/youtube/v3";
const OEMBED_URL = "https://www.youtube.com/oembed";
const UPSTREAM_TIMEOUT_MS = 5000;
const MAX_RESULTS = 12;
const SEARCH_TTL_MS = 10 * 60_000;
const MAX_CACHED_SEARCHES = 200;
const TITLE_TTL_MS = 60 * 60_000;
const MAX_CACHED_TITLES = 1000;
const MAX_TITLE_LENGTH = 200;
/**
 * A search costs 100 of the key's 10,000 daily quota units (plus 1 for the
 * durations), so 90 leaves room for retries. Set YOUTUBE_DAILY_SEARCH_LIMIT
 * for a key with more quota.
 */
const DEFAULT_DAILY_SEARCHES = 90;
/** After YouTube refuses the key for a reason other than quota (e.g. revoked), wait this long before trying it again. */
const KEY_REFUSED_BACKOFF_MS = 10 * 60_000;
const QUOTA_REASONS: ReadonlySet<string> = new Set(["quotaExceeded", "dailyLimitExceeded"]);

/** Search can't be used now (no key, or its quota is used up): users should paste links instead. Expected, so not logged. */
export class SearchUnavailableError extends Error {
  override name = "SearchUnavailableError";
}

/** Carries the status and Google's reason code for the log, since errorSummary drops messages. */
class YouTubeUpstreamError extends Error {
  override name = "YouTubeUpstreamError";
  constructor(readonly status: number, readonly reason: string | undefined) {
    super(`YouTube responded with ${status}`);
  }
}

let budget: Bucket | undefined;
/** Date.now() until which upstream isn't called, after YouTube refused the key. */
let unavailableUntil = 0;
const searches = new TtlCache<YouTubeSearchResult[]>(MAX_CACHED_SEARCHES);
const titles = new TtlCache<string | null>(MAX_CACHED_TITLES);

function takeSearch(): boolean {
  if (!budget) {
    const configured = Number(process.env.YOUTUBE_DAILY_SEARCH_LIMIT);
    const perDay = configured > 0 ? configured : DEFAULT_DAILY_SEARCHES;
    budget = createBucket({ burst: perDay, perSecond: perDay / 86_400 });
  }
  return budget.take();
}

/** Google resets the daily quota at midnight Pacific time. */
export function msUntilPacificMidnight(now = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hourCycle: "h23",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(now);
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const elapsed = (part("hour") * 3600 + part("minute") * 60 + part("second")) * 1000;
  return Math.max(60_000, 86_400_000 - elapsed);
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'" };

/** The Data API HTML-escapes titles, which React would otherwise show as typed. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+|#39);/gi, (match, name: string) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[name.toLowerCase()] ?? match;
  });
}

/** Seconds in an ISO 8601 duration like PT1H2M3S, or null (live streams report P0D). */
export function parseIsoDuration(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value);
  if (!m) return null;
  const [d, h, min, s] = m.slice(1).map((n) => Number(n ?? 0));
  const total = d * 86_400 + h * 3600 + min * 60 + s;
  return total > 0 ? total : null;
}

const clip = (text: string) => (text.length > MAX_TITLE_LENGTH ? `${text.slice(0, MAX_TITLE_LENGTH - 1)}…` : text);

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
  if (!res.ok) {
    let reason: string | undefined;
    try {
      const body = (await res.json()) as { error?: { errors?: { reason?: unknown }[] } };
      const r = body.error?.errors?.[0]?.reason;
      if (typeof r === "string") reason = r;
    } catch {
      // No JSON body.
    }
    throw new YouTubeUpstreamError(res.status, reason);
  }
  return res.json();
}

interface RawSearchItem {
  id?: { videoId?: unknown };
  snippet?: { title?: unknown; channelTitle?: unknown; liveBroadcastContent?: unknown };
}

interface RawVideoItem {
  id?: unknown;
  contentDetails?: { duration?: unknown };
}

async function fetchSearch(apiKey: string, query: string): Promise<YouTubeSearchResult[]> {
  const params = new URLSearchParams({
    part: "snippet",
    type: "video",
    videoEmbeddable: "true",
    safeSearch: "moderate",
    maxResults: String(MAX_RESULTS),
    q: query,
    key: apiKey,
  });
  const raw = (await getJson(`${API_BASE}/search?${params}`)) as { items?: unknown };
  if (!Array.isArray(raw.items)) throw new Error("Unexpected YouTube search response");
  const results: YouTubeSearchResult[] = [];
  for (const item of raw.items as RawSearchItem[]) {
    const videoId = item.id?.videoId;
    const title = item.snippet?.title;
    // Streams can't be synced (see youtube.ts).
    if (typeof videoId !== "string" || typeof title !== "string" || item.snippet?.liveBroadcastContent !== "none") continue;
    const channel = typeof item.snippet?.channelTitle === "string" ? item.snippet.channelTitle : "";
    results.push({ videoId, title: clip(decodeEntities(title)), channel: clip(decodeEntities(channel)), durationS: null });
  }
  if (results.length) {
    // Durations are a nicety: one unit, and a failure keeps the results.
    try {
      const details = new URLSearchParams({ part: "contentDetails", id: results.map((r) => r.videoId).join(","), key: apiKey });
      const videos = (await getJson(`${API_BASE}/videos?${details}`)) as { items?: unknown };
      if (Array.isArray(videos.items)) {
        const durations = new Map((videos.items as RawVideoItem[]).map((v) => [v.id, parseIsoDuration(v.contentDetails?.duration)]));
        for (const r of results) r.durationS = durations.get(r.videoId) ?? null;
      }
    } catch (err) {
      console.warn("[youtube] durations failed", errorSummary(err));
    }
  }
  for (const r of results) void titles.getOrLoad(r.videoId, TITLE_TTL_MS, () => Promise.resolve(r.title));
  return results;
}

/**
 * Searches YouTube for embeddable videos. Throws SearchUnavailableError when
 * there's no key, the daily budget is spent, or YouTube refused the key.
 */
export async function searchYouTube(query: string): Promise<YouTubeSearchResult[]> {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey || Date.now() < unavailableUntil) throw new SearchUnavailableError();
  return searches.getOrLoad(query.toLowerCase(), SEARCH_TTL_MS, async () => {
    if (!takeSearch()) throw new SearchUnavailableError();
    try {
      return await fetchSearch(apiKey, query);
    } catch (err) {
      if (err instanceof YouTubeUpstreamError && (err.status === 400 || err.status === 403)) {
        const quota = !!err.reason && QUOTA_REASONS.has(err.reason);
        unavailableUntil = Date.now() + (quota ? msUntilPacificMidnight() : KEY_REFUSED_BACKOFF_MS);
        console.warn("[youtube] key refused, search paused", { upstreamStatus: err.status, reason: err.reason });
        throw new SearchUnavailableError();
      }
      throw err;
    }
  });
}

/** Logs a failed search. Only for errors other than SearchUnavailableError. */
export function logSearchFailure(err: unknown): void {
  const upstreamStatus = err instanceof YouTubeUpstreamError ? err.status : undefined;
  console.error("[youtube] search failed", { ...errorSummary(err), upstreamStatus });
}

/**
 * A video's title, from search results already seen or YouTube's oEmbed, which
 * needs no key and costs no quota. Null if YouTube won't say (private, removed,
 * not embeddable). Never rejects.
 */
export async function lookupVideoTitle(videoId: string): Promise<string | null> {
  try {
    return await titles.getOrLoad(videoId, TITLE_TTL_MS, async () => {
      const params = new URLSearchParams({ url: `https://www.youtube.com/watch?v=${videoId}`, format: "json" });
      try {
        const raw = (await getJson(`${OEMBED_URL}?${params}`)) as { title?: unknown };
        return typeof raw.title === "string" && raw.title.trim() ? clip(raw.title.trim()) : null;
      } catch (err) {
        // YouTube's answer for a video it won't describe, which is worth remembering.
        if (err instanceof YouTubeUpstreamError && err.status < 500) return null;
        throw err;
      }
    });
  } catch (err) {
    console.warn("[youtube] title lookup failed", errorSummary(err));
    return null;
  }
}

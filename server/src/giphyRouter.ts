import { Router, type Response } from "express";
import { errorSummary } from "./errorLog.js";
import { createBucket, type Bucket } from "./rateLimit.js";
import { participantFromRequest } from "./participantRequest.js";
import { TtlCache } from "./ttlCache.js";
import type { GifItem } from "./protocol.js";

const GIPHY_BASE = "https://api.giphy.com/v1/gifs";
const LIMIT = 24;
const RATING = "pg";
const UPSTREAM_TIMEOUT_MS = 5000;
// API keys are rate-limited, so most picker opens should not reach Giphy.
const TRENDING_TTL_MS = 5 * 60_000;
const SEARCH_TTL_MS = 60_000;
const MAX_CACHED_RESULTS = 100;
const MAX_QUERY_LENGTH = 100;
// Just under the 100 searches an hour of Giphy's free beta keys. Set
// GIPHY_HOURLY_LIMIT for a production key, which allows many more.
const DEFAULT_HOURLY_LIMIT = 90;

interface GiphyRendition {
  url: string;
  webp?: string;
}

interface RawGiphyGif {
  id: string;
  title: string;
  images: {
    fixed_width_downsampled?: GiphyRendition;
    preview_gif?: GiphyRendition;
    fixed_width?: GiphyRendition;
  };
}

function mapGif(gif: RawGiphyGif): GifItem | null {
  const preview =
    gif.images.fixed_width_downsampled?.url ||
    gif.images.preview_gif?.url;
  const url =
    gif.images.fixed_width?.webp ||
    gif.images.fixed_width?.url ||
    gif.images.fixed_width_downsampled?.url;

  if (!preview || !url) return null;
  return { id: gif.id, title: gif.title || "GIF", preview, url };
}

/** Carries the status for the log, since errorSummary drops messages: a revoked key must look unlike a timeout. */
class GiphyUpstreamError extends Error {
  override name = "GiphyUpstreamError";
  constructor(readonly status: number) {
    super(`GIPHY responded with ${status}`);
  }
}

/** `url` contains the API key, so it must never reach logs or error messages. */
async function fetchGifs(url: string): Promise<GifItem[]> {
  const upstream = await fetch(url, { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
  if (!upstream.ok) throw new GiphyUpstreamError(upstream.status);
  const raw = (await upstream.json()) as { data?: unknown };
  if (!Array.isArray(raw.data)) throw new Error("Unexpected GIPHY response");
  return (raw.data as RawGiphyGif[]).map(mapGif).filter((gif): gif is GifItem => gif !== null);
}

const cache = new TtlCache<GifItem[]>(MAX_CACHED_RESULTS);

/** Thrown instead of calling Giphy when this hour's calls are used up. Expected, so not logged. */
class GiphyBudgetError extends Error {}

let upstreamBudget: Bucket | undefined;

/** Upstream calls only: a cached answer costs the key nothing. */
function takeUpstreamCall(): boolean {
  if (!upstreamBudget) {
    const configured = Number(process.env.GIPHY_HOURLY_LIMIT);
    const perHour = configured > 0 ? configured : DEFAULT_HOURLY_LIMIT;
    upstreamBudget = createBucket({ burst: perHour, perSecond: perHour / 3600 });
  }
  return upstreamBudget.take();
}

async function sendGifs(res: Response, cacheKey: string, ttlMs: number, endpoint: string, params = ""): Promise<void> {
  const apiKey = process.env.GIPHY_API_KEY;
  if (!apiKey) {
    res.status(503).json({ error: "GIPHY_API_KEY not configured on server" });
    return;
  }
  const url = `${GIPHY_BASE}/${endpoint}?api_key=${apiKey}${params}&limit=${LIMIT}&rating=${RATING}`;
  try {
    const load = async () => {
      if (!takeUpstreamCall()) throw new GiphyBudgetError();
      return fetchGifs(url);
    };
    res.json({ data: await cache.getOrLoad(cacheKey, ttlMs, load) });
  } catch (err) {
    if (err instanceof GiphyBudgetError) {
      res.status(503).json({ error: "GIF search is busy, please try again later" });
      return;
    }
    const upstreamStatus = err instanceof GiphyUpstreamError ? err.status : undefined;
    console.error("[giphy] upstream failed", { ...errorSummary(err), upstreamStatus });
    res.status(502).json({ error: "Failed to fetch from GIPHY" });
  }
}

export const giphyRouter = Router();

// Only people in a room use the picker, and anyone else would be spending the key's quota.
giphyRouter.use((req, res, next) => {
  if (participantFromRequest(req)) {
    next();
    return;
  }
  res.status(403).json({ error: "Join a room to search GIFs" });
});

giphyRouter.get("/trending", async (_req, res) => {
  await sendGifs(res, "trending", TRENDING_TTL_MS, "trending");
});

giphyRouter.get("/search", async (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (!q || q.length > MAX_QUERY_LENGTH) {
    res.status(400).json({ error: q ? "Search is too long" : "Missing q parameter" });
    return;
  }
  await sendGifs(res, `search:${q.toLowerCase()}`, SEARCH_TTL_MS, "search", `&q=${encodeURIComponent(q)}`);
});

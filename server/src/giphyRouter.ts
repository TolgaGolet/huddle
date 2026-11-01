import { Router, type Response } from "express";
import { TtlCache } from "./ttlCache.js";

const GIPHY_BASE = "https://api.giphy.com/v1/gifs";
const LIMIT = 24;
const RATING = "pg";
const UPSTREAM_TIMEOUT_MS = 5000;
// API keys are rate-limited, so most picker opens should not reach Giphy.
const TRENDING_TTL_MS = 5 * 60_000;
const SEARCH_TTL_MS = 60_000;
const MAX_CACHED_RESULTS = 100;

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

export interface GifItem {
  id: string;
  title: string;
  preview: string;
  url: string;
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

/** `url` contains the API key, so it must never reach logs or error messages. */
async function fetchGifs(url: string): Promise<GifItem[]> {
  const upstream = await fetch(url, { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
  if (!upstream.ok) throw new Error(`GIPHY responded with ${upstream.status}`);
  const raw = (await upstream.json()) as { data?: unknown };
  if (!Array.isArray(raw.data)) throw new Error("Unexpected GIPHY response");
  return (raw.data as RawGiphyGif[]).map(mapGif).filter((gif): gif is GifItem => gif !== null);
}

const cache = new TtlCache<GifItem[]>(MAX_CACHED_RESULTS);

async function sendGifs(res: Response, cacheKey: string, ttlMs: number, endpoint: string, params = ""): Promise<void> {
  const apiKey = process.env.GIPHY_API_KEY;
  if (!apiKey) {
    res.status(503).json({ error: "GIPHY_API_KEY not configured on server" });
    return;
  }
  const url = `${GIPHY_BASE}/${endpoint}?api_key=${apiKey}${params}&limit=${LIMIT}&rating=${RATING}`;
  try {
    res.json({ data: await cache.getOrLoad(cacheKey, ttlMs, () => fetchGifs(url)) });
  } catch {
    res.status(502).json({ error: "Failed to fetch from GIPHY" });
  }
}

export const giphyRouter = Router();

giphyRouter.get("/trending", async (_req, res) => {
  await sendGifs(res, "trending", TRENDING_TTL_MS, "trending");
});

giphyRouter.get("/search", async (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (!q) {
    res.status(400).json({ error: "Missing q parameter" });
    return;
  }
  await sendGifs(res, `search:${q.toLowerCase()}`, SEARCH_TTL_MS, "search", `&q=${encodeURIComponent(q)}`);
});

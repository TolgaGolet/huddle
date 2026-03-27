import { Router } from "express";
import https from "node:https";

const GIPHY_BASE = "https://api.giphy.com/v1/gifs";
const LIMIT = 24;
const RATING = "pg";

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

function fetchJson(url: string): Promise<{ data: RawGiphyGif[] }> {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let raw = "";
        res.on("data", (chunk: string) => (raw += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(raw) as { data: RawGiphyGif[] });
          } catch (e) {
            reject(e);
          }
        });
      })
      .on("error", reject);
  });
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

export const giphyRouter = Router();

giphyRouter.get("/trending", async (_req, res) => {
  const apiKey = process.env.GIPHY_API_KEY;
  if (!apiKey) {
    res.status(503).json({ error: "GIPHY_API_KEY not configured on server" });
    return;
  }
  try {
    const raw = await fetchJson(
      `${GIPHY_BASE}/trending?api_key=${apiKey}&limit=${LIMIT}&rating=${RATING}`,
    );
    res.json({ data: raw.data.map(mapGif).filter(Boolean) });
  } catch {
    res.status(502).json({ error: "Failed to fetch from GIPHY" });
  }
});

giphyRouter.get("/search", async (req, res) => {
  const apiKey = process.env.GIPHY_API_KEY;
  if (!apiKey) {
    res.status(503).json({ error: "GIPHY_API_KEY not configured on server" });
    return;
  }
  const q = (req.query.q as string | undefined)?.trim();
  if (!q) {
    res.status(400).json({ error: "Missing q parameter" });
    return;
  }
  try {
    const raw = await fetchJson(
      `${GIPHY_BASE}/search?api_key=${apiKey}&q=${encodeURIComponent(q)}&limit=${LIMIT}&rating=${RATING}`,
    );
    res.json({ data: raw.data.map(mapGif).filter(Boolean) });
  } catch {
    res.status(502).json({ error: "Failed to fetch from GIPHY" });
  }
});

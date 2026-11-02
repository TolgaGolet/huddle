import type { GifItem } from "../types";
import { errorName } from "./huddleLog";
import { REQUEST_TIMEOUT_MS } from "./requestTimeouts";

async function fetchGifs(endpoint: string, httpToken: string, signal: AbortSignal): Promise<GifItem[]> {
  try {
    const res = await fetch(endpoint, {
      headers: { "X-Participant-Token": httpToken },
      signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }));
      // `||`: statusText is empty over HTTP/2, and GifPicker reads an empty message as no error.
      throw new Error((body as { error?: string }).error || "GIPHY request failed");
    }
    const json = (await res.json()) as { data: (GifItem | null)[] };
    return (json.data ?? []).filter((g): g is GifItem => g !== null);
  } catch (err) {
    // GifPicker shows the message, and the browser's own isn't meant for users.
    if (errorName(err) === "TimeoutError") throw new Error("GIPHY took too long to respond");
    throw err;
  }
}

export function fetchTrending(httpToken: string, signal: AbortSignal): Promise<GifItem[]> {
  return fetchGifs("/api/giphy/trending", httpToken, signal);
}

export function fetchSearch(query: string, httpToken: string, signal: AbortSignal): Promise<GifItem[]> {
  return fetchGifs(`/api/giphy/search?q=${encodeURIComponent(query)}`, httpToken, signal);
}

export interface GifItem {
  id: string;
  title: string;
  preview: string;
  url: string;
}

async function fetchGifs(endpoint: string, signal: AbortSignal): Promise<GifItem[]> {
  const res = await fetch(endpoint, { signal });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((body as { error?: string }).error ?? "GIPHY request failed");
  }
  const json = (await res.json()) as { data: (GifItem | null)[] };
  return (json.data ?? []).filter((g): g is GifItem => g !== null);
}

export function fetchTrending(signal: AbortSignal): Promise<GifItem[]> {
  return fetchGifs("/api/giphy/trending", signal);
}

export function fetchSearch(query: string, signal: AbortSignal): Promise<GifItem[]> {
  return fetchGifs(`/api/giphy/search?q=${encodeURIComponent(query)}`, signal);
}

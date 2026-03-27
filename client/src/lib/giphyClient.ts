export interface GifItem {
  id: string;
  title: string;
  preview: string;
  url: string;
}

async function fetchGifs(endpoint: string): Promise<GifItem[]> {
  const res = await fetch(endpoint);
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((body as { error?: string }).error ?? "GIPHY request failed");
  }
  const json = (await res.json()) as { data: (GifItem | null)[] };
  return (json.data ?? []).filter((g): g is GifItem => g !== null);
}

export function fetchTrending(): Promise<GifItem[]> {
  return fetchGifs("/api/giphy/trending");
}

export function fetchSearch(query: string): Promise<GifItem[]> {
  return fetchGifs(`/api/giphy/search?q=${encodeURIComponent(query)}`);
}

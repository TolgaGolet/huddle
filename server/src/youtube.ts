// YouTube link parsing, shared by both builds like limits.ts (client/src/types/index.ts
// re-exports it), so the watch-party form accepts exactly what the server does.
// Keep this file free of imports so the client can compile it.

export const YOUTUBE_VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

/** Long enough for any real link with its tracking parameters. */
export const MAX_YOUTUBE_URL_LENGTH = 2048;

const WATCH_HOSTS: ReadonlySet<string> = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"]);
// Not /live/: sync assumes a video that starts at 0 and is shorter than MAX_WATCH_POSITION_S,
// and a stream is neither.
const PATH_PREFIXES = ["/shorts/", "/embed/", "/v/"];

/**
 * The video id of a YouTube link, or null for anything else. Only https (or a
 * bare host, which a person often pastes) and YouTube's own hosts are accepted.
 */
export function parseYouTubeVideoId(input: string): string | null {
  const raw = input.trim();
  if (!raw || raw.length > MAX_YOUTUBE_URL_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase();

  let id: string | null = null;
  if (host === "youtu.be") {
    id = url.pathname.split("/")[1] ?? null;
  } else if (WATCH_HOSTS.has(host)) {
    if (url.pathname === "/watch") id = url.searchParams.get("v");
    else {
      const prefix = PATH_PREFIXES.find((p) => url.pathname.startsWith(p));
      if (prefix) id = url.pathname.slice(prefix.length).split("/")[0];
    }
  }
  return id && YOUTUBE_VIDEO_ID_PATTERN.test(id) ? id : null;
}

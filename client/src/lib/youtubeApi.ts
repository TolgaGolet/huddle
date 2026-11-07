// The part of YouTube's IFrame Player API the watch party uses, typed here so
// that no @types package has to be added. The script and frame hosts are
// allowed in the server's CSP (securityHeaders.ts).

export const YT_STATE = {
  UNSTARTED: -1,
  ENDED: 0,
  PLAYING: 1,
  PAUSED: 2,
  BUFFERING: 3,
  CUED: 5,
} as const;

export interface YouTubePlayer {
  getCurrentTime(): number;
  getPlayerState(): number;
  getPlaybackRate(): number;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  playVideo(): void;
  pauseVideo(): void;
  setPlaybackRate(rate: number): void;
  loadVideoById(videoId: string, startSeconds?: number): void;
  destroy(): void;
}

export interface YouTubePlayerEvents {
  onReady?: (event: { target: YouTubePlayer }) => void;
  onStateChange?: (event: { data: number; target: YouTubePlayer }) => void;
  onPlaybackRateChange?: (event: { data: number; target: YouTubePlayer }) => void;
  onError?: (event: { data: number }) => void;
}

interface YouTubeNamespace {
  Player: new (element: HTMLIFrameElement, options: { events: YouTubePlayerEvents }) => YouTubePlayer;
}

declare global {
  interface Window {
    YT?: YouTubeNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

const API_URL = "https://www.youtube.com/iframe_api";
const LOAD_TIMEOUT_MS = 15_000;

let loading: Promise<YouTubeNamespace> | null = null;

/** Loads the API once. A failed load is forgotten, so a later call tries again. */
export function loadYouTubeApi(): Promise<YouTubeNamespace> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  loading ??= new Promise<YouTubeNamespace>((resolve, reject) => {
    const script = document.createElement("script");
    const fail = () => {
      clearTimeout(timer);
      script.remove();
      loading = null;
      reject(new Error("YouTube player failed to load"));
    };
    const timer = setTimeout(fail, LOAD_TIMEOUT_MS);
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      clearTimeout(timer);
      if (window.YT?.Player) resolve(window.YT);
      else fail();
    };
    script.src = API_URL;
    script.async = true;
    script.onerror = fail;
    document.head.appendChild(script);
  });
  return loading;
}

/**
 * The embed URL for our own iframe, which YT.Player then takes over. The page
 * sends no Referer (securityHeaders.ts), but YouTube refuses embeds without one
 * (error 153), so the iframe sets its own referrerpolicy.
 */
export function embedUrl(videoId: string, { controls = true }: { controls?: boolean } = {}): string {
  const params = new URLSearchParams({
    enablejsapi: "1",
    origin: window.location.origin,
    playsinline: "1",
    rel: "0",
  });
  // For a member who may only watch: their changes would be undone anyway (WatchSync).
  if (!controls) {
    params.set("controls", "0");
    params.set("disablekb", "1");
  }
  return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(videoId)}?${params}`;
}

/** A 320x180 thumbnail. Its host is allowed in the CSP's img-src. */
export function thumbnailUrl(videoId: string): string {
  return `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/mqdefault.jpg`;
}

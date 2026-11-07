import { useEffect, useId, useRef, useState } from "react";
import { Check, Info, ListPlus, Play, RefreshCw, X } from "lucide-react";
import type { YouTubeSearchResult } from "../types";
import { searchYouTube, YouTubeSearchError } from "../lib/youtubeSearch";
import { thumbnailUrl } from "../lib/youtubeApi";
import YouTubeLink from "./YouTubeLink";

interface Props {
  query: string;
  httpToken: string;
  /** Whether the queue can take another video. */
  canQueue: boolean;
  onPlay: (videoId: string) => void;
  onQueue: (videoId: string) => void;
  onClose: () => void;
  /** Search can't be used now: the panel then points to links instead. */
  onUnavailable: () => void;
}

export const SEARCH_UNAVAILABLE_TEXT = "Search in Huddle isn't available right now. Paste a YouTube link instead.";

type Status =
  | { kind: "loading" }
  | { kind: "done"; results: YouTubeSearchResult[] }
  | { kind: "error"; code: YouTubeSearchError["code"] };

export function formatDuration(totalS: number): string {
  const h = Math.floor(totalS / 3600);
  const m = Math.floor((totalS % 3600) / 60);
  const s = String(totalS % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

function errorText(code: YouTubeSearchError["code"]): string {
  if (code === "not-permitted") return "Only those who can change the video can search.";
  if (code === "invalid-query") return "That search is too long.";
  return "Search failed. Try again.";
}

/** YouTube results for the watch party's search, over the player. */
export default function WatchSearchResults({ query, httpToken, canQueue, onPlay, onQueue, onClose, onUnavailable }: Props) {
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [queued, setQueued] = useState<ReadonlySet<string>>(new Set());
  const listRef = useRef<HTMLUListElement>(null);
  const headingId = useId();
  const onUnavailableRef = useRef(onUnavailable);
  onUnavailableRef.current = onUnavailable;

  useEffect(() => {
    const controller = new AbortController();
    setStatus({ kind: "loading" });
    searchYouTube(query, httpToken, controller.signal)
      .then((results) => setStatus({ kind: "done", results }))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        const code = err instanceof YouTubeSearchError ? err.code : "search-failed";
        setStatus({ kind: "error", code });
        if (code === "search-unavailable") onUnavailableRef.current();
      });
    return () => controller.abort();
  }, [query, httpToken, attempt]);

  /** Up and down move between the rows' first buttons. */
  function handleListKeyDown(e: React.KeyboardEvent) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const firsts = [...(listRef.current?.querySelectorAll<HTMLButtonElement>("[data-row-first]") ?? [])];
    const row = (e.target as HTMLElement).closest("li");
    const index = firsts.findIndex((b) => b.closest("li") === row);
    const next = firsts[index + (e.key === "ArrowDown" ? 1 : -1)];
    if (next) {
      e.preventDefault();
      next.focus();
    }
  }

  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- Escape from any control inside closes the results.
    <section
      aria-labelledby={headingId}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
      className="absolute inset-0 z-20 flex flex-col bg-gray-950/95 backdrop-blur-sm"
    >
      <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-800 shrink-0">
        <h3 id={headingId} className="flex-1 min-w-0 truncate text-xs font-medium text-gray-200">
          Results for “{query}”
        </h3>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close search results"
          className="touch-target p-1 rounded text-gray-400 hover:text-gray-200 hover:bg-gray-800 transition-colors cursor-pointer"
        >
          <X size={14} />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {status.kind === "loading" && (
          <ul aria-busy="true" aria-label="Searching" className="p-2 space-y-2">
            {Array.from({ length: 4 }, (_, i) => (
              <li key={i} className="flex gap-3 animate-pulse">
                <div className="w-28 aspect-video shrink-0 rounded bg-gray-800" />
                <div className="flex-1 space-y-2 py-1">
                  <div className="h-3 w-4/5 rounded bg-gray-800" />
                  <div className="h-3 w-1/3 rounded bg-gray-800" />
                </div>
              </li>
            ))}
          </ul>
        )}

        {status.kind === "error" && status.code === "search-unavailable" && (
          <div className="m-3 space-y-2.5 rounded-lg border border-indigo-500/30 bg-indigo-500/10 p-3">
            <p role="status" className="flex items-start gap-2 text-xs text-gray-200">
              <Info size={14} className="mt-0.5 shrink-0 text-indigo-400" aria-hidden />
              {SEARCH_UNAVAILABLE_TEXT}
            </p>
            <YouTubeLink label="Find a video on YouTube" />
          </div>
        )}

        {status.kind === "error" && status.code !== "search-unavailable" && (
          <div role="alert" className="m-3 flex flex-col items-start gap-2 text-xs text-red-300">
            {errorText(status.code)}
            {status.code !== "not-permitted" && status.code !== "invalid-query" && (
              <button
                type="button"
                onClick={() => setAttempt((n) => n + 1)}
                className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 cursor-pointer"
              >
                <RefreshCw size={13} aria-hidden />
                Try again
              </button>
            )}
          </div>
        )}

        {status.kind === "done" && status.results.length === 0 && (
          <p className="m-3 text-xs text-gray-400">No videos found for “{query}”.</p>
        )}

        {status.kind === "done" && status.results.length > 0 && (
          // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- arrow keys move between the buttons inside.
          <ul ref={listRef} onKeyDown={handleListKeyDown} className="p-2 space-y-1">
            {status.results.map((r) => {
              const isQueued = queued.has(r.videoId);
              return (
                <li key={r.videoId} className="flex items-center gap-3 rounded-lg p-1.5 hover:bg-gray-900">
                  <img
                    src={thumbnailUrl(r.videoId)}
                    alt=""
                    loading="lazy"
                    className="w-24 sm:w-28 aspect-video shrink-0 rounded object-cover bg-gray-800"
                  />
                  <div className="flex-1 min-w-0">
                    <p className="line-clamp-2 text-xs font-medium text-gray-100">{r.title}</p>
                    <p className="mt-0.5 truncate text-[11px] text-gray-400">
                      {r.channel}
                      {r.durationS !== null && ` · ${formatDuration(r.durationS)}`}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-col gap-1 sm:flex-row">
                    <button
                      type="button"
                      data-row-first
                      onClick={() => onPlay(r.videoId)}
                      aria-label={`Play now: ${r.title}`}
                      className="touch-target inline-flex items-center justify-center gap-1 rounded-lg bg-indigo-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-indigo-500 cursor-pointer"
                    >
                      <Play size={12} aria-hidden />
                      <span className="hidden sm:inline">Play now</span>
                    </button>
                    <button
                      type="button"
                      disabled={isQueued || !canQueue}
                      onClick={() => {
                        onQueue(r.videoId);
                        setQueued((prev) => new Set(prev).add(r.videoId));
                      }}
                      aria-label={isQueued ? `Added to queue: ${r.title}` : `Add to queue: ${r.title}`}
                      className="touch-target inline-flex items-center justify-center gap-1 rounded-lg border border-gray-700 px-2 py-1 text-[11px] text-gray-200 hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                    >
                      {isQueued ? <Check size={12} aria-hidden /> : <ListPlus size={12} aria-hidden />}
                      <span className="hidden sm:inline">{isQueued ? "Queued" : "Add to queue"}</span>
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}

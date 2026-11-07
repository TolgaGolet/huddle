import { memo, useCallback, useEffect, useId, useRef, useState } from "react";
import { Ban, Clapperboard, Crown, ListPlus, LogOut, Maximize, Minimize, Play, Search } from "lucide-react";
import type { AppSocket, Participant } from "../types";
import { MAX_WATCH_QUEUE, MAX_YOUTUBE_QUERY_LENGTH, mayControlWatchParty, parseYouTubeVideoId } from "../types";
import type { PlaybackFeed, WatchPartyActions, WatchPartySnapshot } from "../hooks/useWatchParty";
import { INVALID_YOUTUBE_LINK } from "./WatchPartyCreator";
import WatchPlayer from "./WatchPlayer";
import WatchQueue from "./WatchQueue";
import WatchSearchResults, { SEARCH_UNAVAILABLE_TEXT } from "./WatchSearchResults";
import ConfirmDialog from "./ConfirmDialog";
import YouTubeLink from "./YouTubeLink";

interface Props {
  socket: AppSocket | null;
  snapshot: WatchPartySnapshot;
  playbackFeed: PlaybackFeed;
  localUserId: string;
  /** Authorizes the search, like the GIF picker's. */
  httpToken: string | null;
  /** Owners can end any party. */
  isOwner: boolean;
  /** Everyone in the room, for members' names. */
  participants: Participant[];
  onLeave: () => void;
  onEnd: (partyId: string) => void;
  actions: WatchPartyActions;
}

/** How long a video change may take to come back from the server before the button is usable again. */
const CHANGE_TIMEOUT_MS = 5_000;
const QUEUE_FULL_ERROR = `The queue is full (${MAX_WATCH_QUEUE} videos).`;

/** Typed as a link, so a search for it would be no use: something like youtube.com/live/… */
const looksLikeLink = (text: string) => /^(https?:\/\/|www\.)|^[\w-]+(\.[\w-]+)+\//i.test(text);

/** Once the server says search can't be used, links are the way for the rest of the visit. */
let searchUnavailable = false;

/** The watch party's player and controls, shown in the theater area to its members. */
export default memo(WatchPartyPanel);

function WatchPartyPanel({ socket, snapshot, playbackFeed, localUserId, httpToken, isOwner, participants, onLeave, onEnd, actions }: Props) {
  const { party } = snapshot;
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const [text, setText] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);
  const [searchNotice, setSearchNotice] = useState(false);
  const [pendingVideoId, setPendingVideoId] = useState<string | null>(null);
  const [search, setSearch] = useState<{ query: string; n: number } | null>(null);
  const [noSearch, setNoSearch] = useState(searchUnavailable);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const inputErrorId = useId();

  const canControl = mayControlWatchParty(party, localUserId);
  const queueFull = party.queue.length >= MAX_WATCH_QUEUE;
  const trimmed = text.trim();
  const linkVideoId = parseYouTubeVideoId(trimmed);
  const searchMode = !!trimmed && !linkVideoId && !looksLikeLink(trimmed);

  // A pending change ends when the party has the video, or after a while.
  if (pendingVideoId && party.videoId === pendingVideoId) setPendingVideoId(null);
  useEffect(() => {
    if (!pendingVideoId) return;
    const timer = setTimeout(() => setPendingVideoId(null), CHANGE_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [pendingVideoId]);

  // Someone else took control away: their search results are no use now.
  if (!canControl && search) setSearch(null);

  useEffect(() => {
    const handler = () => setIsFullscreen(document.fullscreenElement === containerRef.current);
    document.addEventListener("fullscreenchange", handler);
    return () => document.removeEventListener("fullscreenchange", handler);
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (!containerRef.current) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void containerRef.current.requestFullscreen().catch(() => {});
  }, []);

  // Everyone reports the end: the server moves on for one with control, or once
  // every member without it has ended, in case the controller's player is stuck.
  const handleEnded = actions.reportEnded;

  function playNow(videoId: string) {
    clearInput();
    setSearch(null);
    if (videoId === party.videoId) return;
    setPendingVideoId(videoId);
    actions.changeVideo(videoId);
  }

  function addToQueue(videoId: string): boolean {
    if (queueFull) {
      setInputError(QUEUE_FULL_ERROR);
      return false;
    }
    actions.queueAdd(videoId);
    return true;
  }

  function clearInput() {
    setText("");
    setInputError(null);
    setSearchNotice(false);
  }

  function handleLink(action: "play" | "queue") {
    if (!linkVideoId) {
      setInputError(INVALID_YOUTUBE_LINK);
      return;
    }
    if (action === "play") {
      playNow(linkVideoId);
    } else if (addToQueue(linkVideoId)) {
      clearInput();
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!trimmed) return;
    if (!searchMode) {
      handleLink("play");
      return;
    }
    if (noSearch) {
      setSearchNotice(true);
      return;
    }
    setSearchNotice(false);
    setSearch((prev) => ({ query: trimmed, n: (prev?.n ?? 0) + 1 }));
  }

  const handleSearchUnavailable = useCallback(() => {
    searchUnavailable = true;
    setNoSearch(true);
    setSearch(null);
    setSearchNotice(true);
    inputRef.current?.focus();
  }, []);

  const nameOf = useCallback(
    (userId: string) => participants.find((p) => p.userId === userId)?.name ?? "Someone",
    [participants],
  );
  const hostName = nameOf(party.hostId);
  const placeholder = noSearch ? "Paste a YouTube link" : "Search YouTube or paste a link";
  const buttonClass =
    "shrink-0 inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer";

  return (
    <section
      ref={containerRef}
      aria-label="Watch Together"
      className={`flex flex-col bg-gray-950 min-w-0 ${isFullscreen ? "h-full" : "h-[50dvh] shrink-0 md:h-auto md:shrink md:flex-1 md:min-h-0"}`}
    >
      <div className="flex flex-wrap items-center gap-2 px-3 py-1.5 bg-gray-900/60 shrink-0">
        <span className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-gray-200">
          <Clapperboard size={13} className="shrink-0 text-indigo-400" aria-hidden />
          <span className="truncate max-w-48" title={party.title ?? undefined}>
            {party.title ?? "Watch Together"}
          </span>
        </span>
        <ul aria-label="Watching" className="flex flex-1 flex-wrap items-center gap-1 min-w-0">
          {party.memberIds.map((id) => (
            <li
              key={id}
              className="inline-flex items-center gap-1 rounded-full border border-gray-700 bg-gray-800/70 px-2 py-0.5 text-[11px] text-gray-300"
            >
              {id === party.hostId && <Crown size={10} className="text-amber-400" aria-label="Host" />}
              {nameOf(id)}
              {id === localUserId && <span className="text-gray-400">(you)</span>}
            </li>
          ))}
        </ul>
        <div className="flex items-center gap-1">
          {/* iPhone Safari has no element fullscreen. */}
          {document.fullscreenEnabled && (
            <button
              type="button"
              onClick={toggleFullscreen}
              className="touch-target p-1 rounded text-gray-400 hover:text-gray-200 hover:bg-gray-800 transition-colors cursor-pointer"
              title={isFullscreen ? "Exit fullscreen (Esc)" : "Fullscreen"}
              aria-label={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
            >
              {isFullscreen ? <Minimize size={14} /> : <Maximize size={14} />}
            </button>
          )}
          {isOwner && (
            <button
              type="button"
              onClick={() => setConfirmEnd(true)}
              className="touch-target inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-red-300 hover:bg-red-500/10 hover:text-red-200 transition-colors cursor-pointer"
            >
              <Ban size={13} aria-hidden />
              End party
            </button>
          )}
          <button
            type="button"
            onClick={onLeave}
            className="touch-target inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-red-300 hover:bg-red-500/10 hover:text-red-200 transition-colors cursor-pointer"
          >
            <LogOut size={13} aria-hidden />
            Leave party
          </button>
        </div>
      </div>

      <div className="px-3 py-1.5 border-b border-gray-800 shrink-0">
        {canControl ? (
          <form onSubmit={handleSubmit} className="flex gap-2" noValidate>
            <YouTubeLink variant="icon" />
            <input
              ref={inputRef}
              type="text"
              enterKeyHint={searchMode ? "search" : "go"}
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setInputError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape" && search) {
                  e.preventDefault();
                  setSearch(null);
                }
              }}
              placeholder={placeholder}
              aria-label={noSearch ? "YouTube link" : "Search YouTube or paste a link"}
              aria-invalid={!!inputError}
              aria-describedby={inputError || searchNotice ? inputErrorId : undefined}
              maxLength={searchMode ? MAX_YOUTUBE_QUERY_LENGTH : undefined}
              className="flex-1 min-w-0 px-2.5 py-1 rounded-lg bg-gray-800 border border-gray-700 text-base md:text-xs text-white placeholder-gray-400 focus:outline-none focus:border-indigo-500 aria-invalid:border-red-500"
            />
            {searchMode ? (
              <button type="submit" className={`${buttonClass} bg-indigo-600 text-white hover:bg-indigo-500`}>
                <Search size={12} aria-hidden />
                Search
              </button>
            ) : (
              <>
                <button
                  type="submit"
                  disabled={!trimmed || !!pendingVideoId}
                  aria-busy={!!pendingVideoId}
                  className={`${buttonClass} bg-indigo-600 text-white hover:bg-indigo-500`}
                >
                  <Play size={12} aria-hidden />
                  {pendingVideoId ? "Changing…" : "Play now"}
                </button>
                <button
                  type="button"
                  disabled={!trimmed || queueFull}
                  onClick={() => handleLink("queue")}
                  className={`${buttonClass} border border-gray-700 text-gray-200 hover:bg-gray-800`}
                >
                  <ListPlus size={12} aria-hidden />
                  <span className="hidden sm:inline">Add to queue</span>
                  <span className="sm:hidden">Queue</span>
                </button>
              </>
            )}
          </form>
        ) : (
          <p className="text-[11px] text-gray-400">Only {hostName} can control the video.</p>
        )}
        {inputError ? (
          <p id={inputErrorId} role="alert" className="mt-1 text-xs text-red-400">
            {inputError}
          </p>
        ) : (
          searchNotice && (
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
              <p id={inputErrorId} role="status" className="text-xs text-gray-300">
                {SEARCH_UNAVAILABLE_TEXT}
              </p>
              <YouTubeLink label="Find a video on YouTube" />
            </div>
          )
        )}
      </div>

      <WatchQueue queue={party.queue} canEdit={canControl} nameOf={nameOf} onRemove={actions.queueRemove} onPlay={actions.queuePlay} onMove={actions.queueMove} />

      <div className="relative flex-1 min-h-0 flex flex-col">
        {/* A fresh player per party, and when control changes (the embed's controls are fixed). */}
        {socket && (
          <WatchPlayer
            key={`${party.id}:${canControl}`}
            socket={socket}
            snapshot={snapshot}
            playbackFeed={playbackFeed}
            canControl={canControl}
            onEnded={handleEnded}
          />
        )}
        {search && httpToken && (
          <WatchSearchResults
            key={search.n}
            query={search.query}
            httpToken={httpToken}
            canQueue={!queueFull}
            onPlay={playNow}
            onQueue={addToQueue}
            onClose={() => {
              setSearch(null);
              inputRef.current?.focus();
            }}
            onUnavailable={handleSearchUnavailable}
          />
        )}
      </div>

      {confirmEnd && (
        <ConfirmDialog
          icon={<Ban size={18} />}
          title="End this watch party?"
          body="It stops for everyone watching it."
          confirmLabel="End party"
          overlayZ="z-60"
          onCancel={() => setConfirmEnd(false)}
          onConfirm={() => {
            setConfirmEnd(false);
            onEnd(party.id);
          }}
        />
      )}
    </section>
  );
}

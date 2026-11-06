import { memo, useCallback, useEffect, useId, useRef, useState } from "react";
import { Clapperboard, Crown, LogOut, Maximize, Minimize, Play, RefreshCw } from "lucide-react";
import type { AppSocket, Participant, WatchPlayback } from "../types";
import { mayChangeWatchVideo, parseYouTubeVideoId, projectPosition, MAX_YOUTUBE_URL_LENGTH } from "../types";
import type { WatchPartySnapshot } from "../hooks/useWatchParty";
import { embedUrl, loadYouTubeApi, type YouTubePlayer } from "../lib/youtubeApi";
import { WatchSync } from "../lib/watchSync";
import { createWorkerInterval } from "../lib/workerTimer";
import { errorName, huddleWarn } from "../lib/huddleLog";
import { INVALID_YOUTUBE_LINK } from "./WatchPartyCreator";

interface Props {
  socket: AppSocket | null;
  snapshot: WatchPartySnapshot;
  localUserId: string;
  /** Everyone in the room, for members' names. */
  participants: Participant[];
  onLeave: () => void;
  onChangeVideo: (videoId: string) => void;
}

const TICK_MS = 500;
/** How long a video change may take to come back from the server before the button is usable again. */
const CHANGE_TIMEOUT_MS = 5_000;

/** Messages for the IFrame API's onError codes. */
function playerErrorMessage(code: number): string {
  if (code === 101 || code === 150 || code === 153) return "This video's owner doesn't allow it to be played on other sites.";
  if (code === 100) return "This video was removed or is private.";
  return "This video can't be played.";
}

/** Playback that was true at local time `at`, as of now. */
function playbackSince(playback: WatchPlayback, at: number): WatchPlayback {
  return { ...playback, position: projectPosition(playback, performance.now() - at) };
}

/** The watch party's player and controls, shown in the theater area to its members. */
export default memo(WatchPartyPanel);

function WatchPartyPanel({ socket, snapshot, localUserId, participants, onLeave, onChangeVideo }: Props) {
  const { party } = snapshot;
  const containerRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const playerRef = useRef<YouTubePlayer | null>(null);
  const syncRef = useRef<WatchSync | null>(null);
  /** The video the player has, which a new party state may change. */
  const loadedVideoRef = useRef<string | null>(null);
  /** The latest playback from the server, applied once the player is ready. */
  const latestRef = useRef<{ playback: WatchPlayback; at: number }>({ playback: party.playback, at: snapshot.receivedAt });
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;

  // The iframe's first video only: later ones are loaded through the API, as a new src would detach it.
  const [initialVideoId] = useState(party.videoId);
  const [attempt, setAttempt] = useState(0);
  const [ready, setReady] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [playerError, setPlayerError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const [link, setLink] = useState("");
  const [linkError, setLinkError] = useState<string | null>(null);
  const [pendingVideoId, setPendingVideoId] = useState<string | null>(null);
  const linkErrorId = useId();

  const canChange = mayChangeWatchVideo(party, localUserId);

  // Create the player. A retry remounts the iframe (its key) and runs this again.
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe || !socket) return;
    let cancelled = false;
    let stopTicking: (() => void) | undefined;

    loadYouTubeApi()
      .then((YT) => {
        if (cancelled) return;
        const player = new YT.Player(iframe, {
          events: {
            onReady: () => {
              if (cancelled) return;
              // Names the video, so a report sent just before a change can't move the new one.
              const sync = new WatchSync(player, (playback) =>
                socket.emit("watch-playback", { ...playback, videoId: loadedVideoRef.current ?? initialVideoId }),
              );
              playerRef.current = player;
              syncRef.current = sync;
              loadedVideoRef.current = initialVideoId;
              // If the video changed while the player loaded, the new-video effect loads it once `ready` is set.
              if (snapshotRef.current.party.videoId === initialVideoId) {
                const { playback, at } = latestRef.current;
                sync.applyRemote(playbackSince(playback, at));
              }
              // A worker timer: a background tab throttles setInterval to 1 s or less often.
              stopTicking = createWorkerInterval(() => {
                sync.tick();
                setBlocked(sync.isBlocked());
              }, TICK_MS);
              setReady(true);
            },
            onStateChange: (event) => syncRef.current?.onStateChange(event.data),
            onPlaybackRateChange: (event) => syncRef.current?.onRateChange(event.data),
            onError: (event) => setPlayerError(playerErrorMessage(event.data)),
          },
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        huddleWarn("ui", { event: "youtube-api-failed", error: errorName(err) });
        setLoadFailed(true);
      });

    return () => {
      cancelled = true;
      stopTicking?.();
      syncRef.current = null;
      try {
        playerRef.current?.destroy();
      } catch {
        // Already torn down along with the iframe.
      }
      playerRef.current = null;
      setReady(false);
    };
  }, [socket, initialVideoId, attempt]);

  // Other members' play, pause, seek and speed, and the party's playback when we join or rejoin it.
  useEffect(() => {
    if (!socket) return;
    const onPlayback = (playback: WatchPlayback) => {
      latestRef.current = { playback, at: performance.now() };
      syncRef.current?.applyRemote(playback);
    };
    socket.on("watch-playback", onPlayback);
    return () => {
      socket.off("watch-playback", onPlayback);
    };
  }, [socket]);

  // A new video. Membership changes also bring a party state, but its playback
  // may predate a change of ours still on its way, so only a new video applies it
  // (a joiner is sent the playback on its own, as watch-playback).
  useEffect(() => {
    const player = playerRef.current;
    const sync = syncRef.current;
    if (!ready || !player || !sync || loadedVideoRef.current === party.videoId) return;
    loadedVideoRef.current = party.videoId;
    const playback = playbackSince(snapshot.party.playback, snapshot.receivedAt);
    latestRef.current = { playback, at: performance.now() };
    setPlayerError(null);
    player.loadVideoById(party.videoId, playback.position);
    sync.applyRemote(playback);
  }, [ready, party.videoId, snapshot]);

  // A pending change ends when the party has the video, or after a while.
  if (pendingVideoId && party.videoId === pendingVideoId) setPendingVideoId(null);
  useEffect(() => {
    if (!pendingVideoId) return;
    const timer = setTimeout(() => setPendingVideoId(null), CHANGE_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [pendingVideoId]);

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

  function submitVideo(e: React.FormEvent) {
    e.preventDefault();
    const videoId = parseYouTubeVideoId(link);
    if (!videoId) {
      setLinkError(INVALID_YOUTUBE_LINK);
      return;
    }
    setLinkError(null);
    setLink("");
    if (videoId === party.videoId) return;
    setPendingVideoId(videoId);
    onChangeVideo(videoId);
  }

  const nameOf = (userId: string) => participants.find((p) => p.userId === userId)?.name ?? "Someone";
  const hostName = nameOf(party.hostId);

  return (
    <section
      ref={containerRef}
      aria-label="Watch Together"
      className={`flex flex-col bg-gray-950 min-w-0 ${isFullscreen ? "h-full" : "h-[50dvh] shrink-0 md:h-auto md:shrink md:flex-1 md:min-h-0"}`}
    >
      <div className="flex flex-wrap items-center gap-2 px-3 py-1.5 bg-gray-900/60 shrink-0">
        <span className="flex items-center gap-1.5 text-xs font-medium text-gray-200">
          <Clapperboard size={13} className="text-indigo-400" aria-hidden />
          Watch Together
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
        {canChange ? (
          <form onSubmit={submitVideo} className="flex gap-2" noValidate>
            <input
              type="url"
              inputMode="url"
              value={link}
              onChange={(e) => {
                setLink(e.target.value);
                setLinkError(null);
              }}
              placeholder="Paste a YouTube link to change the video"
              aria-label="New YouTube link"
              aria-invalid={!!linkError}
              aria-describedby={linkError ? linkErrorId : undefined}
              maxLength={MAX_YOUTUBE_URL_LENGTH}
              className="flex-1 min-w-0 px-2.5 py-1 rounded-lg bg-gray-800 border border-gray-700 text-base md:text-xs text-white placeholder-gray-400 focus:outline-none focus:border-indigo-500 aria-invalid:border-red-500"
            />
            <button
              type="submit"
              disabled={!link.trim() || !!pendingVideoId}
              aria-busy={!!pendingVideoId}
              className="shrink-0 rounded-lg bg-indigo-600 px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
            >
              {pendingVideoId ? "Changing…" : "Change video"}
            </button>
          </form>
        ) : (
          <p className="text-[11px] text-gray-400">Only {hostName} can change the video.</p>
        )}
        {linkError && (
          <p id={linkErrorId} role="alert" className="mt-1 text-xs text-red-400">
            {linkError}
          </p>
        )}
      </div>

      <div className="relative flex-1 min-h-0 w-full bg-black">
        <iframe
          key={attempt}
          ref={iframeRef}
          src={embedUrl(initialVideoId)}
          title="YouTube video player"
          allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
          allowFullScreen
          referrerPolicy="strict-origin-when-cross-origin"
          className="absolute inset-0 h-full w-full border-0"
        />
        {!ready && !loadFailed && (
          <div className="absolute inset-0 animate-pulse bg-gray-900" aria-busy="true" aria-label="Loading the video player" />
        )}
        {loadFailed && (
          <div role="alert" className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-gray-950 p-4 text-center">
            <p className="text-sm text-gray-300">The YouTube player couldn&apos;t load. A blocker or your network may be stopping it.</p>
            <button
              type="button"
              onClick={() => {
                setLoadFailed(false);
                setAttempt((n) => n + 1);
              }}
              className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 cursor-pointer"
            >
              <RefreshCw size={13} aria-hidden />
              Try again
            </button>
          </div>
        )}
        {playerError && (
          <p role="alert" className="absolute inset-x-0 bottom-0 bg-gray-950/90 px-3 py-2 text-center text-xs text-red-300">
            {playerError}
          </p>
        )}
        {ready && blocked && !playerError && (
          <button
            type="button"
            onClick={() => playerRef.current?.playVideo()}
            className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/60 text-sm text-white cursor-pointer"
          >
            <Play size={32} aria-hidden />
            Your browser paused the video. Click to catch up with the party.
          </button>
        )}
      </div>
    </section>
  );
}

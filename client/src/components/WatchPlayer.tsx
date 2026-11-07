import { memo, useEffect, useRef, useState } from "react";
import { Play, RefreshCw } from "lucide-react";
import type { AppSocket, WatchPlayback } from "../types";
import { projectPosition } from "../types";
import type { PlaybackFeed, WatchPartySnapshot } from "../hooks/useWatchParty";
import { embedUrl, loadYouTubeApi, type YouTubePlayer } from "../lib/youtubeApi";
import { WatchSync } from "../lib/watchSync";
import { createWorkerInterval } from "../lib/workerTimer";
import { errorName, huddleWarn } from "../lib/huddleLog";

interface Props {
  socket: AppSocket;
  snapshot: WatchPartySnapshot;
  playbackFeed: PlaybackFeed;
  /**
   * Fixed for the player's life, as the embed's controls can't change: the
   * panel remounts it (its key) when this does.
   */
  canControl: boolean;
  /** The video with this entryId ended here. */
  onEnded: (entryId: string) => void;
}

const TICK_MS = 500;

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

/**
 * The newest playback known for this video: the party state's, or one the
 * server sent since (a party state carries playback only for its members'
 * changes of video, so a non-member's copy is old by the time they join).
 */
function newestPlayback(snapshot: WatchPartySnapshot, feed: PlaybackFeed): { playback: WatchPlayback; at: number } {
  const latest = feed.latest();
  if (latest && latest.entryId === snapshot.party.entryId && latest.at >= snapshot.receivedAt) return latest;
  return { playback: snapshot.party.playback, at: snapshot.receivedAt };
}

/** The YouTube player, kept in sync with the party. Memoized so typing in the panel's input doesn't re-render it. */
export default memo(WatchPlayer);

function WatchPlayer({ socket, snapshot, playbackFeed, canControl, onEnded }: Props) {
  const { party } = snapshot;
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const playerRef = useRef<YouTubePlayer | null>(null);
  const syncRef = useRef<WatchSync | null>(null);
  /** The video the player has (and its entry), which a new party state may change. */
  const loadedRef = useRef<{ videoId: string; entryId: string } | null>(null);
  /** The latest playback from the server, applied once the player is ready. */
  const latestRef = useRef<{ playback: WatchPlayback; at: number }>(newestPlayback(snapshot, playbackFeed));
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const onEndedRef = useRef(onEnded);
  onEndedRef.current = onEnded;

  // The iframe's first video only: later ones are loaded through the API, as a new src would detach it.
  const [initial] = useState({ videoId: party.videoId, entryId: party.entryId });
  const [attempt, setAttempt] = useState(0);
  const [ready, setReady] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [playerError, setPlayerError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState(false);

  // Create the player. A retry remounts the iframe (its key) and runs this again.
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
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
                socket.emit("watch-playback", { ...playback, entryId: loadedRef.current?.entryId ?? initial.entryId }),
              );
              sync.setCanControl(canControl);
              // The entry the player has, not the party's: that may have moved on already.
              sync.onEnded = () => {
                const loaded = loadedRef.current;
                if (loaded) onEndedRef.current(loaded.entryId);
              };
              playerRef.current = player;
              syncRef.current = sync;
              loadedRef.current = initial;
              // If the video changed while the player loaded, the new-video effect loads it once `ready` is set.
              if (snapshotRef.current.party.entryId === initial.entryId) {
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
  }, [socket, initial, attempt, canControl]);

  // Other members' play, pause, seek and speed, and the party's playback when we join or rejoin it.
  useEffect(() => {
    // One may have come between the first render and now.
    latestRef.current = newestPlayback(snapshotRef.current, playbackFeed);
    return playbackFeed.subscribe(({ entryId, playback, at }) => {
      latestRef.current = { playback, at };
      // For a video the player hasn't loaded yet, the new-video effect applies it.
      if (loadedRef.current?.entryId === entryId) syncRef.current?.applyRemote(playback);
    });
  }, [playbackFeed]);

  // A new video (by entry, so the same video queued twice plays again). Membership
  // changes also bring a party state, but its playback may predate a change of
  // ours still on its way, so only a new video applies it (a joiner is sent the
  // playback on its own, as watch-playback).
  useEffect(() => {
    const player = playerRef.current;
    const sync = syncRef.current;
    if (!ready || !player || !sync || loadedRef.current?.entryId === party.entryId) return;
    loadedRef.current = { videoId: party.videoId, entryId: party.entryId };
    const newest = newestPlayback(snapshot, playbackFeed);
    const playback = playbackSince(newest.playback, newest.at);
    latestRef.current = { playback, at: performance.now() };
    setPlayerError(null);
    player.loadVideoById(party.videoId, playback.position);
    sync.applyRemote(playback);
  }, [ready, party.videoId, party.entryId, snapshot, playbackFeed]);

  return (
    <div className="relative flex-1 min-h-0 w-full bg-black">
      <iframe
        key={attempt}
        ref={iframeRef}
        src={embedUrl(initial.videoId, { controls: canControl })}
        title="YouTube video player"
        allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
        allowFullScreen
        referrerPolicy="strict-origin-when-cross-origin"
        className="absolute inset-0 h-full w-full border-0"
      />
      {/* Clicks on the video would play or pause it, which only those with control may do. */}
      {!canControl && <div className="absolute inset-0" aria-hidden />}
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
  );
}

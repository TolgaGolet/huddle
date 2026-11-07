import { useEffect, useMemo, useRef, useState } from "react";
import type { AppSocket, ServerToClientEvents, WatchPartyState, WatchPlayback } from "../types";
import { usePartyIntent } from "./usePartyIntent";

const EVENTS = { join: "watch-join", leave: "watch-leave", end: "watch-end" } as const;

export interface WatchPartySnapshot {
  party: WatchPartyState;
  /** performance.now() when it arrived, for projecting its playback position. */
  receivedAt: number;
}

/** Playback from the server for the joined party's video `entryId`, received at performance.now() `at`. */
export interface TimedPlayback {
  entryId: string;
  playback: WatchPlayback;
  at: number;
}

/**
 * The joined party's playback from the server. Received here, where the
 * listener is in place before any join is sent, so the reply to a join can't
 * arrive before the player is mounted to hear it.
 */
export interface PlaybackFeed {
  /** The latest received, for a player that mounts after it arrived. */
  latest(): TimedPlayback | null;
  subscribe(listener: (playback: TimedPlayback) => void): () => void;
}

/** What a party's members with control can do, as WatchPartyPanel needs it. */
export interface WatchPartyActions {
  changeVideo: (videoId: string) => void;
  queueAdd: (videoId: string) => void;
  queueRemove: (entryId: string) => void;
  /** Plays a queued video now. */
  queuePlay: (entryId: string) => void;
  queueMove: (entryId: string, toIndex: number) => void;
  /** The video with this entryId ended here. */
  reportEnded: (entryId: string) => void;
}

/**
 * The room's watch parties and which one this client is in (one at most).
 * Must subscribe before the join is sent, like RoomChat, since `room-joined`
 * carries the parties.
 * Which party it is in is kept by usePartyIntent.
 */
export function useWatchParty(socket: AppSocket | null, roomId: string) {
  const [state, setState] = useState<{ parties: WatchPartyState[]; receivedAt: number }>({ parties: [], receivedAt: 0 });
  const { joinedPartyId, joinedRef, received, rejoined, join, leave, end, prepareStart } =
    usePartyIntent(socket, `huddle:watch-party:${roomId}`, EVENTS);
  /** Updated as each broadcast arrives, so a playback right behind one is checked against it. */
  const partiesRef = useRef<WatchPartyState[]>([]);
  const latestPlaybackRef = useRef<TimedPlayback | null>(null);
  const playbackListenersRef = useRef(new Set<(playback: TimedPlayback) => void>());

  useEffect(() => {
    if (!socket) return;
    let userId: string | null = null;

    const store = (parties: WatchPartyState[]) => {
      partiesRef.current = parties;
      setState({ parties, receivedAt: performance.now() });
    };

    const update = (parties: WatchPartyState[]) => {
      store(parties);
      received(parties, userId);
    };

    const onRoomJoined: ServerToClientEvents["room-joined"] = (data) => {
      userId = data.userId;
      store(data.watchParties);
      rejoined(data.watchParties, data.userId);
    };

    // Only for the video our party is playing: one sent for a video or party we
    // have since left (still on its way when we moved on) would move the wrong one.
    const onPlayback: ServerToClientEvents["watch-playback"] = ({ entryId, ...playback }) => {
      const party = partiesRef.current.find((p) => p.id === joinedRef.current);
      if (party?.entryId !== entryId) return;
      const timed = { entryId, playback, at: performance.now() };
      latestPlaybackRef.current = timed;
      for (const listener of playbackListenersRef.current) listener(timed);
    };

    socket.on("room-joined", onRoomJoined);
    socket.on("watch-parties", update);
    socket.on("watch-playback", onPlayback);
    return () => {
      socket.off("room-joined", onRoomJoined);
      socket.off("watch-parties", update);
      socket.off("watch-playback", onPlayback);
    };
  }, [socket, joinedRef, received, rejoined]);

  const { parties, receivedAt } = state;
  const party = parties.find((p) => p.id === joinedPartyId) ?? null;
  // Memoized so the memoized WatchPartyPanel skips renders where nothing changed.
  const snapshot = useMemo<WatchPartySnapshot | null>(() => party && { party, receivedAt }, [party, receivedAt]);

  const playbackFeed = useMemo<PlaybackFeed>(() => ({
    latest: () => latestPlaybackRef.current,
    subscribe: (listener) => {
      playbackListenersRef.current.add(listener);
      return () => playbackListenersRef.current.delete(listener);
    },
  }), []);

  const actions = useMemo<WatchPartyActions>(() => ({
    changeVideo: (videoId) => socket?.emit("watch-change-video", { videoId }),
    queueAdd: (videoId) => socket?.emit("watch-queue-add", { videoId }),
    queueRemove: (entryId) => socket?.emit("watch-queue-remove", { entryId }),
    queuePlay: (entryId) => socket?.emit("watch-queue-play", { entryId }),
    queueMove: (entryId, toIndex) => socket?.emit("watch-queue-move", { entryId, toIndex }),
    reportEnded: (entryId) => socket?.emit("watch-ended", { entryId }),
  }), [socket]);

  return { parties, snapshot, joinedPartyId: party ? party.id : null, join, leave, end, prepareStart, actions, playbackFeed };
}

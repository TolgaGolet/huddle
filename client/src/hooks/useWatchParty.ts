import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppSocket, ServerToClientEvents, WatchPartyState, WatchPlayback } from "../types";

// Per tab, like the identity in clientKey.ts. Storage can be unavailable, which only loses this convenience.
function readJoined(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeJoined(key: string, partyId: string | null): void {
  try {
    if (partyId) sessionStorage.setItem(key, partyId);
    else sessionStorage.removeItem(key);
  } catch {
    // See readJoined.
  }
}

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
 *
 * Being "in" a party is this client's intent, kept across a reconnect or a
 * reload: the server drops a socket that loses its connection, so after the
 * rejoin this sends `watch-join` again instead of leaving the user out.
 */
export function useWatchParty(socket: AppSocket | null, roomId: string) {
  const storageKey = `huddle:watch-party:${roomId}`;
  const [state, setState] = useState<{ parties: WatchPartyState[]; receivedAt: number }>({ parties: [], receivedAt: 0 });
  const [joinedPartyId, setJoinedPartyId] = useState<string | null>(() => readJoined(storageKey));
  // Set at once, not on the next render, so a broadcast already on its way can't undo a join or leave.
  const joinedRef = useRef<string | null>(joinedPartyId);
  /** A party this client left, which a broadcast sent before the leave may still list it in. */
  const leftRef = useRef<string | null>(null);
  /** Updated as each broadcast arrives, so a playback right behind one is checked against it. */
  const partiesRef = useRef<WatchPartyState[]>([]);
  const latestPlaybackRef = useRef<TimedPlayback | null>(null);
  const playbackListenersRef = useRef(new Set<(playback: TimedPlayback) => void>());

  const setJoined = useCallback((partyId: string | null) => {
    if (joinedRef.current === partyId) return;
    joinedRef.current = partyId;
    setJoinedPartyId(partyId);
    writeJoined(storageKey, partyId);
  }, [storageKey]);

  // Kept for a reload, which runs no cleanup, but forgotten on leaving the room
  // (unmounting), so coming back later doesn't load YouTube without a click.
  // Written again on mount for StrictMode's remount.
  useEffect(() => {
    writeJoined(storageKey, joinedRef.current);
    return () => writeJoined(storageKey, null);
  }, [storageKey]);

  useEffect(() => {
    if (!socket) return;
    let userId: string | null = null;

    const update = (parties: WatchPartyState[]) => {
      partiesRef.current = parties;
      setState({ parties, receivedAt: performance.now() });
      const joined = joinedRef.current;
      // The server lists us where we are, as in a party we just started. A
      // socket is in one at most, so being listed in another means we moved.
      const listed = userId ? parties.filter((p) => p.memberIds.includes(userId!) && p.id !== leftRef.current) : [];
      const moved = listed.find((p) => p.id !== joined);
      if (moved) setJoined(moved.id);
      else if (joined && !parties.some((p) => p.id === joined)) setJoined(null);
    };

    const onRoomJoined: ServerToClientEvents["room-joined"] = (data) => {
      userId = data.userId;
      const joined = joinedRef.current;
      const rejoin = data.watchParties.some((p) => p.id === joined && !p.memberIds.includes(data.userId));
      update(data.watchParties);
      if (rejoin && joined) {
        setJoined(joined);
        socket.emit("watch-join", { partyId: joined });
      }
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
  }, [socket, setJoined]);

  const { parties, receivedAt } = state;
  const party = parties.find((p) => p.id === joinedPartyId) ?? null;
  // Memoized so the memoized WatchPartyPanel skips renders where nothing changed.
  const snapshot = useMemo<WatchPartySnapshot | null>(() => party && { party, receivedAt }, [party, receivedAt]);

  /** Joining another party leaves this client's current one (the server does the same). */
  const join = useCallback((partyId: string) => {
    if (!socket?.connected) return;
    leftRef.current = joinedRef.current !== partyId ? joinedRef.current : null;
    socket.emit("watch-join", { partyId });
    setJoined(partyId);
  }, [socket, setJoined]);

  const leave = useCallback(() => {
    leftRef.current = joinedRef.current;
    socket?.emit("watch-leave");
    setJoined(null);
  }, [socket, setJoined]);

  /** Owners only; the server ignores anyone else. */
  const end = useCallback((partyId: string) => {
    socket?.emit("watch-end", { partyId });
  }, [socket]);

  /**
   * Call before starting a party: the server moves us out of the current one,
   * and a broadcast sent before that must not pull us back into it.
   */
  const prepareStart = useCallback(() => {
    leftRef.current = joinedRef.current;
  }, []);

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

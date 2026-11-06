import { useCallback, useEffect, useRef, useState } from "react";
import type { AppSocket, ServerToClientEvents, WatchPartyState } from "../types";

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

/**
 * The room's watch party and whether this client is in it. Must subscribe
 * before the join is sent, like RoomChat, since `room-joined` carries the party.
 *
 * Being "in" the party is this client's intent, kept across a reconnect or a
 * reload: the server drops a socket that loses its connection, so after the
 * rejoin this sends `watch-join` again instead of leaving the user out.
 */
export function useWatchParty(socket: AppSocket | null, roomId: string) {
  const storageKey = `huddle:watch-party:${roomId}`;
  const [snapshot, setSnapshot] = useState<WatchPartySnapshot | null>(null);
  const [joinedPartyId, setJoinedPartyId] = useState<string | null>(() => readJoined(storageKey));
  // Set at once, not on the next render, so a broadcast already on its way can't undo a join or leave.
  const joinedRef = useRef<string | null>(joinedPartyId);
  /** A party this client left, which a broadcast sent before the leave may still list it in. */
  const leftRef = useRef<string | null>(null);

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

    const update = (party: WatchPartyState | null) => {
      setSnapshot(party && { party, receivedAt: performance.now() });
      if (!party || party.id !== joinedRef.current) {
        // The server says we're in it, as when we started it.
        const isIn = !!party && !!userId && party.memberIds.includes(userId) && party.id !== leftRef.current;
        setJoined(isIn ? party.id : null);
      }
    };

    const onRoomJoined: ServerToClientEvents["room-joined"] = (data) => {
      userId = data.userId;
      const party = data.watchParty;
      const rejoin = !!party && party.id === joinedRef.current && !party.memberIds.includes(data.userId);
      update(party);
      if (rejoin) {
        setJoined(party.id);
        socket.emit("watch-join", { partyId: party.id });
      }
    };

    socket.on("room-joined", onRoomJoined);
    socket.on("watch-party", update);
    return () => {
      socket.off("room-joined", onRoomJoined);
      socket.off("watch-party", update);
    };
  }, [socket, setJoined]);

  const party = snapshot?.party ?? null;
  const isMember = !!party && party.id === joinedPartyId;

  const join = useCallback(() => {
    if (!socket?.connected || !party) return;
    leftRef.current = null;
    socket.emit("watch-join", { partyId: party.id });
    setJoined(party.id);
  }, [socket, party, setJoined]);

  const leave = useCallback(() => {
    leftRef.current = joinedRef.current;
    socket?.emit("watch-leave");
    setJoined(null);
  }, [socket, setJoined]);

  const changeVideo = useCallback((videoId: string) => {
    socket?.emit("watch-change-video", { videoId });
  }, [socket]);

  return { snapshot, party, isMember, join, leave, changeVideo };
}

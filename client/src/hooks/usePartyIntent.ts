import { useCallback, useEffect, useRef, useState } from "react";
import type { AppSocket } from "../types";

// The party this tab means to be in, kept across a reload so the rejoin can
// join it again. Per tab, like the identity in clientKey.ts. Storage can be
// unavailable, which only loses this convenience.

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

interface PartyListing {
  id: string;
  memberIds: string[];
}

/** One kind's events, never a mix. */
type PartyEvents =
  | { join: "watch-join"; leave: "watch-leave"; end: "watch-end" }
  | { join: "game-join"; leave: "game-leave"; end: "game-end" };

/**
 * Which party of one kind this client is in (one at most), shared by
 * useWatchParty and useGameParty. Being "in" a party is this client's intent,
 * kept across a reconnect or a reload: the server drops a socket that loses
 * its connection, so after the rejoin `rejoined` sends the join again instead
 * of leaving the user out. The caller subscribes to its kind's events and
 * passes each party list to `received`.
 *
 * A member is in one party at most, of any kind, and the server moves them out
 * of the last one itself (partyMembership.ts). Each kind's hook sees that as
 * its party no longer listing this client, and lets go of it.
 */
export function usePartyIntent(socket: AppSocket | null, storageKey: string, events: PartyEvents) {
  const [joinedPartyId, setJoinedPartyId] = useState<string | null>(() => readJoined(storageKey));
  // Set at once, not on the next render, so a broadcast already on its way can't undo a join or leave.
  const joinedRef = useRef<string | null>(joinedPartyId);
  /** A party this client left, which a broadcast sent before the leave may still list it in. */
  const leftRef = useRef<string | null>(null);
  /**
   * Whether the server has listed us in the joined party. Until it has, a list
   * without us may predate the join; after, it means the server took us out.
   */
  const confirmedRef = useRef(false);

  const setJoined = useCallback((partyId: string | null) => {
    if (joinedRef.current === partyId) return;
    joinedRef.current = partyId;
    confirmedRef.current = false;
    setJoinedPartyId(partyId);
    writeJoined(storageKey, partyId);
  }, [storageKey]);

  // Kept for a reload, which runs no cleanup, but forgotten on leaving the room
  // (unmounting), so coming back later doesn't load the party's page without a
  // click. Written again on mount for StrictMode's remount.
  useEffect(() => {
    writeJoined(storageKey, joinedRef.current);
    return () => writeJoined(storageKey, null);
  }, [storageKey]);

  /** A party list from the server, as seen by `userId` (null before the first join). */
  const received = useCallback((parties: PartyListing[], userId: string | null) => {
    const joined = joinedRef.current;
    // The server lists us where we are, as in a party we just started. A
    // socket is in one at most, so being listed in another means we moved.
    const listed = userId ? parties.filter((p) => p.memberIds.includes(userId) && p.id !== leftRef.current) : [];
    const moved = listed.find((p) => p.id !== joined);
    if (moved) {
      setJoined(moved.id);
      confirmedRef.current = true;
      return;
    }
    if (!joined) return;
    const party = parties.find((p) => p.id === joined);
    if (!party) setJoined(null);
    else if (userId && party.memberIds.includes(userId)) confirmedRef.current = true;
    // Moved into a party of another kind, or out of the room's view of this one.
    else if (userId && confirmedRef.current) setJoined(null);
  }, [setJoined]);

  /** The parties in `room-joined`: joins the intended party again if the server dropped us from it. */
  const rejoined = useCallback((parties: PartyListing[], userId: string) => {
    // The server dropped this socket while it was away, so not being listed says nothing yet.
    confirmedRef.current = false;
    const joined = joinedRef.current;
    const rejoin = parties.some((p) => p.id === joined && !p.memberIds.includes(userId));
    received(parties, userId);
    if (rejoin && joined) {
      setJoined(joined);
      socket?.emit(events.join, { partyId: joined });
    }
  }, [socket, events.join, received, setJoined]);

  /**
   * Joining another party leaves this client's current one (the server does the same).
   * False if it couldn't be sent, while the socket is reconnecting.
   */
  const join = useCallback((partyId: string): boolean => {
    if (!socket?.connected) return false;
    leftRef.current = joinedRef.current !== partyId ? joinedRef.current : null;
    socket.emit(events.join, { partyId });
    setJoined(partyId);
    return true;
  }, [socket, events.join, setJoined]);

  const leave = useCallback(() => {
    leftRef.current = joinedRef.current;
    socket?.emit(events.leave);
    setJoined(null);
  }, [socket, events.leave, setJoined]);

  /** Owners only; the server ignores anyone else. */
  const end = useCallback((partyId: string) => {
    socket?.emit(events.end, { partyId });
  }, [socket, events.end]);

  /**
   * Call before starting a party: the server moves us out of the current one,
   * and a broadcast sent before that must not pull us back into it.
   */
  const prepareStart = useCallback(() => {
    leftRef.current = joinedRef.current;
  }, []);

  return { joinedPartyId, joinedRef, received, rejoined, join, leave, end, prepareStart };
}

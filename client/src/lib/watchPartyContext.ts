import { createContext } from "react";
import type { WatchPartyState } from "../types";

export interface WatchPartyContextValue {
  parties: WatchPartyState[];
  /** The party this client is in, if any (one at most). */
  joinedPartyId: string | null;
  /** Leaves the current party, if any. False if it couldn't be sent (reconnecting). */
  join: (partyId: string) => boolean;
  /** Owners only. */
  end: (partyId: string) => void;
  isOwner: boolean;
  /** Call just before starting a party; see useWatchParty. */
  prepareStart: () => void;
}

/**
 * The room's watch parties, for the invite cards in the chat and the start
 * popup. A context, so a change re-renders only those, not the memoized message list.
 */
export const WatchPartyContext = createContext<WatchPartyContextValue>({
  parties: [],
  joinedPartyId: null,
  join: () => false,
  end: () => {},
  isOwner: false,
  prepareStart: () => {},
});

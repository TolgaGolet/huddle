import { createContext } from "react";
import type { GameInfo, GamePartyState } from "../types";

export interface GamePartyContextValue {
  parties: GamePartyState[];
  /** The games a party can be started for, from the server. */
  games: readonly GameInfo[];
  /** The party this client is in, if any (one at most, of either kind). */
  joinedPartyId: string | null;
  /** Leaves the current party, if any. False if it couldn't be sent (reconnecting). */
  join: (partyId: string) => boolean;
  /** Owners only. */
  end: (partyId: string) => void;
  isOwner: boolean;
  /** Call just before starting a party; see useGameParty. */
  prepareStart: () => void;
}

/**
 * The room's game parties, for the invite cards in the chat and the start
 * popup. A context, so a change re-renders only those, not the memoized message list.
 */
export const GamePartyContext = createContext<GamePartyContextValue>({
  parties: [],
  games: [],
  joinedPartyId: null,
  join: () => false,
  end: () => {},
  isOwner: false,
  prepareStart: () => {},
});

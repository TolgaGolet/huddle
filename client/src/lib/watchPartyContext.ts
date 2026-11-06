import { createContext } from "react";
import type { WatchPartyState } from "../types";

export interface WatchPartyContextValue {
  party: WatchPartyState | null;
  isMember: boolean;
  join: () => void;
}

/**
 * The room's watch party, for the invite cards in the chat. A context, so a
 * change re-renders only the cards, not the memoized message list.
 */
export const WatchPartyContext = createContext<WatchPartyContextValue>({ party: null, isMember: false, join: () => {} });

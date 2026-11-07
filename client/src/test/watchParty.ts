import type { WatchPartyState } from "../types";
import type { WatchPartyContextValue } from "../lib/watchPartyContext";

/** A playing party with nothing queued. */
export function makeParty(overrides: Partial<WatchPartyState> = {}): WatchPartyState {
  return {
    id: "p1",
    hostId: "host",
    allowOthersToChange: false,
    videoId: "dQw4w9WgXcQ",
    entryId: "e1",
    title: null,
    memberIds: ["host"],
    playback: { state: "playing", position: 0, rate: 1 },
    queue: [],
    ...overrides,
  };
}

export function watchContextValue(overrides: Partial<WatchPartyContextValue> = {}): WatchPartyContextValue {
  return { parties: [], joinedPartyId: null, join: () => true, end: () => {}, isOwner: false, prepareStart: () => {}, ...overrides };
}

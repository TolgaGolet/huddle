import type { GameInfo, GamePartyState } from "../types";
import type { GamePartyContextValue } from "../lib/gamePartyContext";

export const RAGAMUFFIN: GameInfo = {
  id: "ragamuffin",
  name: "RagaMuffin",
  description: "A multiplayer browser game.",
  url: "https://ragamuffin.example/",
  embed: true,
};

export function makeGameParty(overrides: Partial<GamePartyState> = {}): GamePartyState {
  return { id: "g1", gameId: RAGAMUFFIN.id, hostId: "host", memberIds: ["host"], ...overrides };
}

export function gameContextValue(overrides: Partial<GamePartyContextValue> = {}): GamePartyContextValue {
  return {
    parties: [],
    games: [RAGAMUFFIN],
    joinedPartyId: null,
    join: () => true,
    end: () => {},
    isOwner: false,
    prepareStart: () => {},
    ...overrides,
  };
}

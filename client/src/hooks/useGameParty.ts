import { useEffect, useState } from "react";
import type { AppSocket, GameInfo, GamePartyState, ServerToClientEvents } from "../types";
import { usePartyIntent } from "./usePartyIntent";

const EVENTS = { join: "game-join", leave: "game-leave", end: "game-end" } as const;

/**
 * The room's game parties, the games they can be for, and which party this
 * client is in (one at most). Like useWatchParty, without playback: it must
 * subscribe before the join is sent, as `room-joined` carries the parties.
 * Which party it is in is kept by usePartyIntent.
 */
export function useGameParty(socket: AppSocket | null, roomId: string) {
  const [parties, setParties] = useState<GamePartyState[]>([]);
  const [games, setGames] = useState<readonly GameInfo[]>([]);
  const { joinedPartyId, received, rejoined, join, leave, end, prepareStart } =
    usePartyIntent(socket, `huddle:game-party:${roomId}`, EVENTS);

  useEffect(() => {
    if (!socket) return;
    let userId: string | null = null;

    const update = (list: GamePartyState[]) => {
      setParties(list);
      received(list, userId);
    };

    const onRoomJoined: ServerToClientEvents["room-joined"] = (data) => {
      userId = data.userId;
      setGames(data.games);
      setParties(data.gameParties);
      rejoined(data.gameParties, data.userId);
    };

    socket.on("room-joined", onRoomJoined);
    socket.on("game-parties", update);
    return () => {
      socket.off("room-joined", onRoomJoined);
      socket.off("game-parties", update);
    };
  }, [socket, received, rejoined]);

  const party = parties.find((p) => p.id === joinedPartyId) ?? null;
  const game = party ? (games.find((g) => g.id === party.gameId) ?? null) : null;

  return {
    parties,
    games,
    /** The joined party, with its game, once both are known. */
    party: party && game ? party : null,
    game,
    joinedPartyId: party ? party.id : null,
    join,
    leave,
    end,
    prepareStart,
  };
}

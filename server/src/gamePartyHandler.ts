import { nanoid } from "nanoid";
import { GAME_PARTY_GRACE_MS, MAX_GAME_PARTIES } from "./limits.js";
import { partiesBesidesNew, type GamePartyState } from "./protocol.js";
import { maySendMessages } from "./chatHandler.js";
import { createPartyMembership, hostOf, partyInvite } from "./partyMembership.js";
import { ownerOnly } from "./roomModeration.js";
import { addChatMessage, touchRoom, type GameParty, type Room } from "./roomManager.js";
import { onRoom, type AppServer } from "./socketRoute.js";
import { noPayload, parseGameEnd, parseGameJoin, parseGameStart } from "./validation.js";

function stateOf(party: GameParty): GamePartyState {
  return {
    id: party.id,
    gameId: party.gameId,
    hostId: hostOf(party),
    memberIds: [...new Set(party.members.values())],
  };
}

/** The room's game parties as clients see them. */
export function gamePartiesOf(room: Room): GamePartyState[] {
  return [...room.gameParties.values()].map(stateOf);
}

/**
 * Up to MAX_GAME_PARTIES per room. The game is a web page that does its own
 * multiplayer, so the server keeps only who is playing which game: the party
 * membership shared with watch parties (partyMembership.ts), without playback.
 */
export function setupGameParty(io: AppServer): void {
  function announce(room: Room): void {
    io.to(room.id).emit("game-parties", gamePartiesOf(room));
  }

  const { partyOf, end, removeMember, leaveCurrent, join } = createPartyMembership({
    io,
    kind: "game",
    partiesOf: (room) => room.gameParties,
    graceMs: GAME_PARTY_GRACE_MS,
    announce,
  });

  io.on("connection", (socket) => {
    onRoom(socket, "game-start", parseGameStart, (ctx, { gameId }) => {
      if (!maySendMessages(socket, ctx, "game-start")) return;
      const { roomId, room, participant } = ctx;
      const alone = partyOf(room, socket.id)?.members.size === 1;
      if (partiesBesidesNew(room.gameParties.size, alone) >= MAX_GAME_PARTIES) {
        socket.emit("game-start-refused", { reason: "limit", max: MAX_GAME_PARTIES });
        return;
      }
      // One party per socket: starting one leaves the last (a game party's is announced below).
      leaveCurrent(room, socket.id);
      const party: GameParty = {
        id: nanoid(10),
        gameId,
        hostId: participant.userId,
        members: new Map([[socket.id, participant.userId]]),
      };
      room.gameParties.set(party.id, party);
      const invite = partyInvite(participant, { gameInvite: { partyId: party.id, gameId } });
      addChatMessage(room, invite);
      touchRoom(room);
      // The party first, so the invite's card can show it as soon as it arrives.
      announce(room);
      io.to(roomId).emit("chat-message", invite);
    });

    onRoom(socket, "game-join", parseGameJoin, ({ room, participant }, { partyId }) => {
      const party = room.gameParties.get(partyId);
      if (!party || party.members.has(socket.id)) return;
      join(room, party, socket.id, participant.userId);
      touchRoom(room);
      announce(room);
    });

    onRoom(socket, "game-leave", noPayload, ({ room }) => removeMember(room, socket.id, true));

    onRoom(socket, "game-end", parseGameEnd, ownerOnly(({ room }, { partyId }) => end(room, partyId)));
  });
}

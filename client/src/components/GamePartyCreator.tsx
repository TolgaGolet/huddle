import { useContext, useId, useRef } from "react";
import { Gamepad2, X } from "lucide-react";
import { MAX_GAME_PARTIES, partiesBesidesNew } from "../types";
import { GamePartyContext } from "../lib/gamePartyContext";
import { WatchPartyContext } from "../lib/watchPartyContext";
import { useClickOutside } from "../hooks/useClickOutside";
import PartyList from "./PartyList";

interface Props {
  /** Returns false if the party wasn't started, which keeps the popup open. */
  onSubmit: (gameId: string) => boolean;
  onClose: () => void;
}

export const GAME_PARTY_LIMIT_TEXT = `At most ${MAX_GAME_PARTIES} game parties can run in a room at once. End one to start a new one.`;

export default function GamePartyCreator({ onSubmit, onClose }: Props) {
  const { parties, games, joinedPartyId, join, end, isOwner, prepareStart } = useContext(GamePartyContext);
  // Starting or joining a game party leaves a watch party too.
  const inWatchParty = !!useContext(WatchPartyContext).joinedPartyId;
  const ref = useRef<HTMLDivElement>(null);
  const gamesHeadingId = useId();

  useClickOutside(ref, onClose);

  const joined = parties.find((party) => party.id === joinedPartyId);
  const atLimit = partiesBesidesNew(parties.length, joined?.memberIds.length === 1) >= MAX_GAME_PARTIES;
  const nameOf = (gameId: string) => games.find((game) => game.id === gameId)?.name ?? "Game";

  function start(gameId: string) {
    prepareStart();
    if (onSubmit(gameId)) onClose();
  }

  return (
    <div
      ref={ref}
      className="absolute bottom-full mb-2 left-0 right-0 bg-gray-800 border border-gray-700 rounded-xl shadow-2xl z-50 max-h-[70dvh] overflow-y-auto"
    >
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-200">
          <Gamepad2 size={14} className="text-emerald-400" aria-hidden />
          Play Together
        </h3>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close play together"
          className="touch-target p-1 rounded hover:bg-gray-700 text-gray-400 hover:text-gray-200 transition-colors cursor-pointer"
        >
          <X size={14} />
        </button>
      </div>

      <div className="p-4 space-y-3">
        <p className="text-xs leading-relaxed text-gray-400">
          A game party opens a game for everyone who joins. An invite is posted in the chat, and the game loads from its own
          website only for those who join.
        </p>

        <PartyList
          kind="game party"
          verb="playing"
          max={MAX_GAME_PARTIES}
          parties={parties}
          joinedPartyId={joinedPartyId}
          isOwner={isOwner}
          nameOf={(party) => nameOf(party.gameId)}
          iconOf={() => <Gamepad2 size={18} className="shrink-0 text-emerald-400" aria-hidden />}
          joinClass="bg-emerald-600"
          join={join}
          end={end}
          onJoined={onClose}
        />

        {atLimit ? (
          <p role="status" className="rounded-lg border border-gray-700 bg-gray-900/60 p-3 text-xs text-gray-300">
            {GAME_PARTY_LIMIT_TEXT}
            {!isOwner && " Owners can end a party, and one ends once everyone has left it."}
          </p>
        ) : (
          <section aria-labelledby={gamesHeadingId} className="space-y-1.5">
            <h4 id={gamesHeadingId} className="text-xs font-medium text-gray-300">
              Games
            </h4>
            {games.length === 0 ? (
              <p className="text-xs text-gray-400">No games are available right now.</p>
            ) : (
              <ul className="space-y-1.5">
                {games.map((game) => (
                  <li key={game.id} className="flex items-center gap-3 rounded-lg border border-gray-700 bg-gray-900/60 p-2.5">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-400">
                      <Gamepad2 size={18} aria-hidden />
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm font-medium text-gray-100">{game.name}</span>
                      <span className="block text-[11px] text-gray-400">{game.description}</span>
                    </span>
                    <button
                      type="button"
                      onClick={() => start(game.id)}
                      aria-label={`Start a game party: ${game.name}`}
                      className="touch-target shrink-0 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-emerald-500 cursor-pointer"
                    >
                      Start
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {(joinedPartyId || inWatchParty) && (
              <p className="text-[11px] text-gray-400">
                Starting a party leaves the {joinedPartyId ? "game you're playing" : "video you're watching"}.
              </p>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

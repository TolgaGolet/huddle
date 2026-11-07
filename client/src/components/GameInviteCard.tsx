import { useContext } from "react";
import { Gamepad2, Users } from "lucide-react";
import { GamePartyContext } from "../lib/gamePartyContext";

interface Props {
  partyId: string;
  gameId: string;
  senderName: string;
}

/** A game party's invite in the chat, showing whether it is still running. */
export default function GameInviteCard({ partyId, gameId, senderName }: Props) {
  const { parties, games, joinedPartyId, join } = useContext(GamePartyContext);
  const active = parties.find((p) => p.id === partyId) ?? null;
  const isMember = !!active && joinedPartyId === active.id;
  const name = games.find((game) => game.id === gameId)?.name ?? "a game";
  const playing = active?.memberIds.length ?? 0;

  return (
    <div className="mt-1 max-w-sm rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3">
      <div className="flex items-center gap-2 text-sm font-medium text-gray-100">
        <Gamepad2 size={15} className="text-emerald-400 shrink-0" aria-hidden />
        Play Together
      </div>
      <p className="mt-1 text-xs text-gray-400">
        {senderName} invited everyone to play <span className="font-medium text-gray-200">{name}</span>.
      </p>
      {active ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1 text-xs text-gray-400">
            <Users size={12} aria-hidden />
            {playing} playing
          </span>
          {isMember ? (
            <span className="ml-auto text-xs font-medium text-green-400">You&apos;re playing</span>
          ) : (
            <button
              type="button"
              onClick={() => join(active.id)}
              className="ml-auto touch-target rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-emerald-500 cursor-pointer"
            >
              Join game
            </button>
          )}
        </div>
      ) : (
        <p className="mt-2 text-xs text-gray-400">This game party has ended.</p>
      )}
    </div>
  );
}

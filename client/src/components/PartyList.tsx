import { useId, useState, type ReactNode } from "react";
import { Users } from "lucide-react";

interface Props<P extends { id: string; memberIds: string[] }> {
  /** "watch party" or "game party", for the heading ("Watch parties") and labels. */
  kind: string;
  /** What members are doing, as in "3 watching". */
  verb: string;
  max: number;
  parties: P[];
  joinedPartyId: string | null;
  isOwner: boolean;
  /** The party's name, as in "Join watch party: <name>". */
  nameOf: (party: P) => string;
  /** The thumbnail or icon at the start of each row. */
  iconOf: (party: P) => ReactNode;
  /** The Join button's background. */
  joinClass: string;
  /** False if the join couldn't be sent, which keeps the popup open. */
  join: (partyId: string) => boolean;
  end: (partyId: string) => void;
  /** After a join was sent. */
  onJoined: () => void;
}

/** The room's parties of one kind in a start popup: join one, or, for owners, end one for everyone. */
export default function PartyList<P extends { id: string; memberIds: string[] }>({
  kind,
  verb,
  max,
  parties,
  joinedPartyId,
  isOwner,
  nameOf,
  iconOf,
  joinClass,
  join,
  end,
  onJoined,
}: Props<P>) {
  /** The party whose End button was pressed once, waiting for the confirmation. */
  const [confirmingEnd, setConfirmingEnd] = useState<string | null>(null);
  const [joinFailed, setJoinFailed] = useState(false);
  const headingId = useId();

  if (parties.length === 0) return null;

  return (
    <section aria-labelledby={headingId} className="space-y-1.5">
      <h4 id={headingId} className="text-xs font-medium text-gray-300">
        {`${kind[0].toUpperCase()}${kind.slice(1, -1)}ies in this room (${parties.length}/${max})`}
      </h4>
      <ul className="space-y-1.5">
        {parties.map((party) => {
          const name = nameOf(party);
          const summary = (
            <>
              {iconOf(party)}
              <span className="flex-1 min-w-0">
                <span className="block truncate text-xs text-gray-100">{name}</span>
                <span className="flex items-center gap-1 text-[11px] text-gray-400">
                  <Users size={11} aria-hidden />
                  {party.memberIds.length} {verb}
                </span>
              </span>
            </>
          );
          return (
            <li key={party.id} className="flex items-center gap-2 rounded-lg border border-gray-700 bg-gray-900/60 p-1.5">
              {party.id === joinedPartyId ? (
                <div className="flex flex-1 min-w-0 items-center gap-2 px-1">
                  {summary}
                  <span className="shrink-0 text-[11px] font-medium text-green-400">You&apos;re {verb}</span>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    const sent = join(party.id);
                    setJoinFailed(!sent);
                    if (sent) onJoined();
                  }}
                  aria-label={`Join ${kind}: ${name}`}
                  className="flex flex-1 min-w-0 items-center gap-2 rounded px-1 text-left hover:bg-gray-800 cursor-pointer"
                >
                  {summary}
                  <span className={`shrink-0 rounded-lg px-2 py-1 text-[11px] font-medium text-white ${joinClass}`}>Join</span>
                </button>
              )}
              {isOwner &&
                (confirmingEnd === party.id ? (
                  <span className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={() => setConfirmingEnd(null)}
                      className="touch-target rounded px-1.5 py-1 text-[11px] text-gray-300 hover:bg-gray-700 cursor-pointer"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setConfirmingEnd(null);
                        end(party.id);
                      }}
                      aria-label={`End for everyone: ${name}`}
                      className="touch-target rounded bg-red-600 px-1.5 py-1 text-[11px] font-medium text-white hover:bg-red-500 cursor-pointer"
                    >
                      End for all
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmingEnd(party.id)}
                    aria-label={`End ${kind}: ${name}`}
                    className="touch-target shrink-0 rounded px-1.5 py-1 text-[11px] text-red-300 hover:bg-red-500/10 cursor-pointer"
                  >
                    End
                  </button>
                ))}
            </li>
          );
        })}
      </ul>
      {joinFailed && (
        <p role="alert" className="text-xs text-red-400">
          Couldn&apos;t join while reconnecting. Try again in a moment.
        </p>
      )}
    </section>
  );
}

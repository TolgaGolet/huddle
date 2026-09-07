import { Check, MoreVertical, Pin } from "lucide-react";
import type { PollMessage } from "../types";

interface Props {
  poll: PollMessage;
  localId: string;
  onVote: (pollId: string, optionId: string) => void;
  onContextMenu?: (poll: PollMessage, e: React.MouseEvent) => void;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export default function PollDisplay({ poll, localId, onVote, onContextMenu }: Props) {
  const totalVotes = poll.options.reduce((sum, o) => sum + o.voterIds.length, 0);

  return (
    <div
      className={`group relative bg-gray-800/60 border border-gray-700 rounded-xl p-3 space-y-2 ${
        poll.pinned ? "border-l-2 border-l-amber-400/70" : ""
      }`}
    >
      {poll.pinned && (
        <span className="inline-flex items-center gap-1 text-[10px] text-amber-400">
          <Pin size={9} /> Pinned
        </span>
      )}
      <div className="flex items-baseline gap-2">
        <span className="text-sm font-semibold text-indigo-400">{poll.senderName}</span>
        <span className="text-[10px] text-gray-600">{formatTime(poll.timestamp)}</span>
        <span className="text-[10px] text-gray-600 bg-gray-700/60 px-1.5 py-0.5 rounded">Poll</span>
      </div>
      {onContextMenu && (
        <button
          type="button"
          onClick={(e) => onContextMenu(poll, e)}
          className="absolute -top-3 right-0 hidden group-hover:flex items-center bg-gray-800 border border-gray-700 rounded-lg shadow-lg p-1.5 text-gray-400 hover:text-gray-200 transition-colors cursor-pointer"
          title="More actions"
        >
          <MoreVertical size={13} />
        </button>
      )}

      <p className="text-sm font-medium text-gray-200">{poll.question}</p>

      <div className="space-y-1.5">
        {poll.options.map((option) => {
          const voted = option.voterIds.includes(localId);
          const count = option.voterIds.length;
          const pct = totalVotes > 0 ? Math.round((count / totalVotes) * 100) : 0;

          return (
            <button
              key={option.id}
              type="button"
              onClick={() => onVote(poll.id, option.id)}
              className={`w-full text-left rounded-lg p-2 relative overflow-hidden transition-colors cursor-pointer group ${
                voted
                  ? "border border-indigo-500/50 bg-indigo-500/10"
                  : "border border-gray-600 hover:border-gray-500 bg-gray-900/40"
              }`}
            >
              <div
                className="absolute inset-0 bg-indigo-500/15 transition-all"
                style={{ width: `${pct}%` }}
              />
              <div className="relative flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  {voted && <Check size={12} className="text-indigo-400 shrink-0" />}
                  <span className="text-xs text-gray-300 truncate">{option.text}</span>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <span className="text-[10px] text-gray-500">{count}</span>
                  {totalVotes > 0 && (
                    <span className="text-[10px] text-gray-500 w-7 text-right">{pct}%</span>
                  )}
                </div>
              </div>
            </button>
          );
        })}
      </div>

      <p className="text-[10px] text-gray-600">
        {totalVotes} {totalVotes === 1 ? "vote" : "votes"}
        {poll.allowMultiple && " · Multiple selections allowed"}
      </p>
    </div>
  );
}

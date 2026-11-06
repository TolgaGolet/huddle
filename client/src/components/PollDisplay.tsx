import { memo, useEffect, useState } from "react";
import { Check, MoreVertical, Pin } from "lucide-react";
import { hasReacted, hasVotedInPoll, type PollMessage } from "../types";
import { useNow } from "../hooks/useNow";
import { avatarTextColor } from "../lib/avatarColor";
import { formatTime } from "../lib/formatTime";

interface Props {
  poll: PollMessage;
  isPinned: boolean;
  localUserId: string;
  onVote: (pollId: string, optionId: string) => void;
  /** All of the user's votes at once, for a poll with `lockVotes`. */
  onSubmit: (pollId: string, optionIds: string[]) => void;
  onContextMenu?: (poll: PollMessage, e: React.MouseEvent) => void;
}

/** How long "Submitting…" waits for the server before the vote can be sent again. */
const SUBMIT_TIMEOUT_MS = 5000;

/** "Ending…" covers the gap until the server's `closed` arrives, or a clock that runs fast. */
function endLabel(poll: PollMessage, now: number): string {
  if (poll.closed) return " · Closed";
  if (poll.endsAt === undefined) return "";
  return now < poll.endsAt ? ` · Ends in ${formatRemaining(poll.endsAt - now)}` : " · Ending…";
}

function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

function PollDisplay({ poll, isPinned, localUserId, onVote, onSubmit, onContextMenu }: Props) {
  const totalVotes = poll.options.reduce((sum, o) => sum + o.voters.length, 0);
  // The countdown reads this device's clock, but only the server's `closed`
  // stops voting, so a clock that's off can't close a poll early or late.
  const now = useNow(poll.endsAt);
  const open = !poll.closed;
  const voted = hasVotedInPoll(poll, localUserId);
  // A locked poll the user has voted in, or any ended poll, takes no more votes.
  const canVote = open && !(poll.lockVotes && voted);
  // A locked poll's votes are final, so they're chosen first and sent by "Submit vote".
  const choosing = poll.lockVotes && canVote;
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  // Any update makes a new poll object, so this re-enables the button once the
  // server has answered (or someone else's vote shows the refused one).
  const [submittedFor, setSubmittedFor] = useState<PollMessage | null>(null);
  const submitting = submittedFor === poll;
  // A refused submit (rate limit, poll just ended) may bring no update at all.
  useEffect(() => {
    if (!submitting) return;
    const timer = setTimeout(() => setSubmittedFor(null), SUBMIT_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [submitting]);

  // Both handlers rely on their buttons' `disabled` for when they may run.
  function choose(optionId: string) {
    if (!poll.lockVotes) {
      onVote(poll.id, optionId);
    } else if (!poll.allowMultiple) {
      setSelected((prev) => new Set(prev.has(optionId) ? [] : [optionId]));
    } else {
      setSelected((prev) => {
        const next = new Set(prev);
        if (!next.delete(optionId)) next.add(optionId);
        return next;
      });
    }
  }

  function submitChoices() {
    setSubmittedFor(poll);
    // Poll order, not click order.
    onSubmit(poll.id, poll.options.filter((o) => selected.has(o.id)).map((o) => o.id));
  }

  return (
    <div
      role="group"
      aria-label={`Poll from ${poll.senderName}`}
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- keyboard route to a poll; focusing it reveals the action button and adds it to the Tab order.
      tabIndex={0}
      className={`group relative bg-gray-800/60 border border-gray-700 rounded-xl p-3 space-y-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${
        isPinned ? "border-l-2 border-l-amber-400/70" : ""
      }`}
    >
      {isPinned && (
        <span className="inline-flex items-center gap-1 text-[10px] text-amber-400">
          <Pin size={9} /> Pinned
        </span>
      )}
      <div className="flex items-baseline gap-2">
        <span className={`text-sm font-semibold ${avatarTextColor(poll.senderName)}`}>{poll.senderName}</span>
        <span className="text-[10px] text-gray-400">{formatTime(poll.timestamp)}</span>
        <span className="text-[10px] text-gray-400 bg-gray-700/60 px-1.5 py-0.5 rounded">Poll</span>
      </div>
      {onContextMenu && (
        <button
          type="button"
          onClick={(e) => onContextMenu(poll, e)}
          className="touch-target absolute -top-3 right-0 hidden group-hover:flex group-has-[:focus-visible]:flex pointer-coarse:group-focus-within:flex items-center bg-gray-800 border border-gray-700 rounded-lg shadow-lg p-1.5 text-gray-400 hover:text-gray-200 transition-colors cursor-pointer"
          title="More actions"
          aria-label="More actions"
          aria-haspopup="menu"
        >
          <MoreVertical size={13} />
        </button>
      )}

      <p className="text-sm font-medium text-gray-200">{poll.question}</p>

      <div className="space-y-1.5">
        {poll.options.map((option) => {
          const marked = choosing ? selected.has(option.id) : hasReacted(option.voters, localUserId);
          const count = option.voters.length;
          const pct = totalVotes > 0 ? Math.round((count / totalVotes) * 100) : 0;

          return (
            <button
              key={option.id}
              type="button"
              onClick={() => choose(option.id)}
              disabled={!canVote || submitting}
              aria-pressed={marked}
              className={`w-full text-left rounded-lg p-2 relative overflow-hidden transition-colors group cursor-pointer disabled:cursor-default ${
                marked
                  ? "border border-indigo-500/50 bg-indigo-500/10"
                  : `border border-gray-600 bg-gray-900/40 ${canVote ? "hover:border-gray-500" : ""}`
              }`}
            >
              <div
                className="absolute inset-0 bg-indigo-500/15 transition-all"
                style={{ width: `${pct}%` }}
              />
              <div className="relative flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  {marked && <Check size={12} className="text-indigo-400 shrink-0" />}
                  <span className="text-xs text-gray-300 truncate">{option.text}</span>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <span className="text-[10px] text-gray-400">{count}</span>
                  {totalVotes > 0 && (
                    <span className="text-[10px] text-gray-400 w-7 text-right">{pct}%</span>
                  )}
                </div>
              </div>
            </button>
          );
        })}
      </div>

      {choosing && (
        <button
          type="button"
          onClick={submitChoices}
          disabled={!selected.size || submitting}
          className="w-full py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed text-xs font-medium transition-colors cursor-pointer"
        >
          {submitting ? "Submitting…" : "Submit vote"}
        </button>
      )}

      <p className="text-[10px] text-gray-400">
        {totalVotes} {totalVotes === 1 ? "vote" : "votes"}
        {poll.allowMultiple && " · Multiple selections allowed"}
        {poll.lockVotes && " · Votes are final"}
        {endLabel(poll, now)}
      </p>
    </div>
  );
}

export default memo(PollDisplay);

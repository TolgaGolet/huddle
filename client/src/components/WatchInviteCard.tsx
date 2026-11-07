import { useContext } from "react";
import { Clapperboard, Users } from "lucide-react";
import { WatchPartyContext } from "../lib/watchPartyContext";

interface Props {
  partyId: string;
  videoId: string;
  senderName: string;
}

function youtubeWatchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
}

/** A watch party's invite in the chat, showing whether it is still running. */
export default function WatchInviteCard({ partyId, videoId, senderName }: Props) {
  const { parties, joinedPartyId, join } = useContext(WatchPartyContext);
  const active = parties.find((p) => p.id === partyId) ?? null;
  const isMember = !!active && joinedPartyId === active.id;
  // The party may have moved on to another video since the invite.
  const currentVideo = active?.videoId ?? videoId;
  const watching = active?.memberIds.length ?? 0;

  return (
    <div className="mt-1 max-w-sm rounded-lg border border-indigo-500/30 bg-indigo-500/5 p-3">
      <div className="flex items-center gap-2 text-sm font-medium text-gray-100">
        <Clapperboard size={15} className="text-indigo-400 shrink-0" aria-hidden />
        Watch Together
      </div>
      <p className="mt-1 text-xs text-gray-400">{senderName} invited everyone to watch a YouTube video together.</p>
      <a
        href={youtubeWatchUrl(currentVideo)}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-1 block truncate text-xs text-indigo-400 hover:underline"
      >
        {active?.title ?? `youtube.com/watch?v=${currentVideo}`}
      </a>
      {active ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1 text-xs text-gray-400">
            <Users size={12} aria-hidden />
            {watching} watching
          </span>
          {isMember ? (
            <span className="ml-auto text-xs font-medium text-green-400">You&apos;re watching</span>
          ) : (
            <button
              type="button"
              onClick={() => join(active.id)}
              className="ml-auto touch-target rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-indigo-500 cursor-pointer"
            >
              Join Watch Together
            </button>
          )}
        </div>
      ) : (
        <p className="mt-2 text-xs text-gray-400">This watch party has ended.</p>
      )}
    </div>
  );
}

import { useContext, useId, useRef, useState } from "react";
import { Clapperboard, Users, X } from "lucide-react";
import { MAX_WATCH_PARTIES, MAX_YOUTUBE_URL_LENGTH, parseYouTubeVideoId, partiesBesidesNew } from "../types";
import { WatchPartyContext } from "../lib/watchPartyContext";
import { thumbnailUrl } from "../lib/youtubeApi";
import { useClickOutside } from "../hooks/useClickOutside";
import YouTubeLink from "./YouTubeLink";
import { queueTitle } from "./WatchQueue";

interface Props {
  /** Returns false if the party wasn't started, which keeps the form and what's typed in it. */
  onSubmit: (videoId: string, allowOthersToChange: boolean) => boolean;
  onClose: () => void;
}

export const INVALID_YOUTUBE_LINK = "Paste a YouTube video link, like youtube.com/watch?v=… or youtu.be/…";
export const WATCH_PARTY_LIMIT_TEXT = `At most ${MAX_WATCH_PARTIES} watch parties can run in a room at once. End one to start a new one.`;

export default function WatchPartyCreator({ onSubmit, onClose }: Props) {
  const { parties, joinedPartyId, join, end, isOwner, prepareStart } = useContext(WatchPartyContext);
  const [link, setLink] = useState("");
  const [allowOthersToChange, setAllowOthersToChange] = useState(true);
  const [showError, setShowError] = useState(false);
  /** The party whose End button was pressed once, waiting for the confirmation. */
  const [confirmingEnd, setConfirmingEnd] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const errorId = useId();
  const listHeadingId = useId();

  useClickOutside(ref, onClose);

  const videoId = parseYouTubeVideoId(link);
  const invalid = showError && !videoId;
  const joined = parties.find((party) => party.id === joinedPartyId);
  const atLimit = partiesBesidesNew(parties.length, joined?.memberIds.length === 1) >= MAX_WATCH_PARTIES;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!videoId) {
      setShowError(true);
      return;
    }
    prepareStart();
    if (onSubmit(videoId, allowOthersToChange)) onClose();
  }

  return (
    <div
      ref={ref}
      className="absolute bottom-full mb-2 left-0 right-0 bg-gray-800 border border-gray-700 rounded-xl shadow-2xl z-50 max-h-[70dvh] overflow-y-auto"
    >
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-200">
          <Clapperboard size={14} className="text-indigo-400" aria-hidden />
          Watch Together
        </h3>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close watch together"
          className="touch-target p-1 rounded hover:bg-gray-700 text-gray-400 hover:text-gray-200 transition-colors cursor-pointer"
        >
          <X size={14} />
        </button>
      </div>

      <div className="p-4 space-y-3">
        <p className="text-xs leading-relaxed text-gray-400">
          A watch party plays a YouTube video for everyone who joins, in sync: when anyone plays, pauses or skips, it happens for
          everybody at the same second. An invite is posted in the chat, and the video loads from YouTube only for those who join.
        </p>

        {parties.length > 0 && (
          <section aria-labelledby={listHeadingId} className="space-y-1.5">
            <h4 id={listHeadingId} className="text-xs font-medium text-gray-300">
              Watch parties in this room ({parties.length}/{MAX_WATCH_PARTIES})
            </h4>
            <ul className="space-y-1.5">
              {parties.map((party) => {
                const watching = party.id === joinedPartyId;
                const title = queueTitle(party);
                const summary = (
                  <>
                    <img src={thumbnailUrl(party.videoId)} alt="" className="h-9 aspect-video shrink-0 rounded object-cover bg-gray-800" />
                    <span className="flex-1 min-w-0">
                      <span className="block truncate text-xs text-gray-100">{title}</span>
                      <span className="flex items-center gap-1 text-[11px] text-gray-400">
                        <Users size={11} aria-hidden />
                        {party.memberIds.length} watching
                      </span>
                    </span>
                  </>
                );
                return (
                  <li key={party.id} className="flex items-center gap-2 rounded-lg border border-gray-700 bg-gray-900/60 p-1.5">
                    {watching ? (
                      <div className="flex flex-1 min-w-0 items-center gap-2">
                        {summary}
                        <span className="shrink-0 text-[11px] font-medium text-green-400">You&apos;re watching</span>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          join(party.id);
                          onClose();
                        }}
                        aria-label={`Join watch party: ${title}`}
                        className="flex flex-1 min-w-0 items-center gap-2 rounded text-left hover:bg-gray-800 cursor-pointer"
                      >
                        {summary}
                        <span className="shrink-0 rounded-lg bg-indigo-600 px-2 py-1 text-[11px] font-medium text-white">Join</span>
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
                            aria-label={`End for everyone: ${title}`}
                            className="touch-target rounded bg-red-600 px-1.5 py-1 text-[11px] font-medium text-white hover:bg-red-500 cursor-pointer"
                          >
                            End for all
                          </button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirmingEnd(party.id)}
                          aria-label={`End watch party: ${title}`}
                          className="touch-target shrink-0 rounded px-1.5 py-1 text-[11px] text-red-300 hover:bg-red-500/10 cursor-pointer"
                        >
                          End
                        </button>
                      ))}
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {atLimit ? (
          <p role="status" className="rounded-lg border border-gray-700 bg-gray-900/60 p-3 text-xs text-gray-300">
            {WATCH_PARTY_LIMIT_TEXT}
            {!isOwner && " Owners can end a party, and one ends once everyone has left it."}
          </p>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-3" noValidate>
            <div>
              <input
                type="url"
                inputMode="url"
                value={link}
                onChange={(e) => setLink(e.target.value)}
                onBlur={() => setShowError(!!link.trim())}
                placeholder="https://www.youtube.com/watch?v=…"
                aria-label="YouTube link"
                aria-invalid={invalid}
                aria-describedby={invalid ? errorId : undefined}
                maxLength={MAX_YOUTUBE_URL_LENGTH}
                autoFocus
                className="w-full px-3 py-2 rounded-lg bg-gray-900 border border-gray-600 text-base md:text-sm text-white placeholder-gray-400 focus:outline-none focus:border-indigo-500 aria-invalid:border-red-500"
              />
              {invalid && (
                <p id={errorId} role="alert" className="mt-1 text-xs text-red-400">
                  {INVALID_YOUTUBE_LINK}
                </p>
              )}
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <YouTubeLink />
                <span className="text-[11px] text-gray-400">Find a video there, then paste its link here.</span>
              </div>
            </div>

            <label className="flex items-center gap-2 cursor-pointer">
              {/* eslint-disable-next-line jsx-a11y/control-has-associated-label -- labelled by the wrapping <label>, which the rule can't see. */}
              <input
                type="checkbox"
                role="switch"
                checked={allowOthersToChange}
                onChange={(e) => setAllowOthersToChange(e.target.checked)}
                className="rounded border-gray-600 bg-gray-900 text-indigo-500 focus:ring-indigo-500 cursor-pointer"
              />
              <span className="text-xs text-gray-400">Others can control the video (play, pause, change, queue)</span>
            </label>

            {joinedPartyId && <p className="text-[11px] text-gray-400">Starting a party leaves the one you&apos;re watching.</p>}

            <button
              type="submit"
              disabled={!link.trim()}
              className="w-full py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed text-sm font-medium transition-colors cursor-pointer"
            >
              Start watch party
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

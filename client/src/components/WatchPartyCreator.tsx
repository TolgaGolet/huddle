import { useContext, useId, useRef, useState } from "react";
import { Clapperboard, X } from "lucide-react";
import { MAX_YOUTUBE_URL_LENGTH, parseYouTubeVideoId } from "../types";
import { WatchPartyContext } from "../lib/watchPartyContext";
import { useClickOutside } from "../hooks/useClickOutside";

interface Props {
  /** Returns false if the party wasn't started, which keeps the form and what's typed in it. */
  onSubmit: (videoId: string, allowOthersToChange: boolean) => boolean;
  onClose: () => void;
}

export const INVALID_YOUTUBE_LINK = "Paste a YouTube video link, like youtube.com/watch?v=… or youtu.be/…";

export default function WatchPartyCreator({ onSubmit, onClose }: Props) {
  const { party, isMember, join } = useContext(WatchPartyContext);
  const [link, setLink] = useState("");
  const [allowOthersToChange, setAllowOthersToChange] = useState(true);
  const [showError, setShowError] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const errorId = useId();

  useClickOutside(ref, onClose);

  const videoId = parseYouTubeVideoId(link);
  const invalid = showError && !videoId;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!videoId) {
      setShowError(true);
      return;
    }
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

        {party ? (
          <div className="rounded-lg border border-gray-700 bg-gray-900/60 p-3 space-y-2">
            <p className="text-xs text-gray-300">
              A watch party is already running in this room. A new one can start once it ends.
            </p>
            {isMember ? (
              <p className="text-xs font-medium text-green-400">You&apos;re watching.</p>
            ) : (
              <button
                type="button"
                onClick={() => {
                  join();
                  onClose();
                }}
                className="w-full py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-sm font-medium transition-colors cursor-pointer"
              >
                Join Watch Together
              </button>
            )}
          </div>
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
              <span className="text-xs text-gray-400">Other users can change the video</span>
            </label>

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

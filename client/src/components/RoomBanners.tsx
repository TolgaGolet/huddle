import type { ReactNode } from "react";
import { MicOff, Volume2, X, type LucideIcon } from "lucide-react";
import { micErrorMessage, type MicError } from "../lib/micError";

const BANNER_ACTION = "px-3 py-1 rounded-md bg-amber-500/20 hover:bg-amber-500/30 text-amber-200 transition-colors cursor-pointer";

function RoomBanner({ icon: Icon, role, message, children }: { icon: LucideIcon; role?: "alert"; message: string; children: ReactNode }) {
  return (
    <div role={role} className="flex items-center justify-between gap-3 px-4 py-2 bg-amber-500/10 border-b border-amber-500/30 text-amber-300 text-xs">
      <span className="flex items-center gap-2">
        <Icon size={14} className="shrink-0" />
        {message}
      </span>
      <span className="flex items-center gap-2 shrink-0">{children}</span>
    </div>
  );
}

interface Props {
  micError: MicError | null;
  micRetrying: boolean;
  onRetryMic: () => void;
  onDismissMicError: () => void;
  needsAudioGesture: boolean;
  onResumeAudio: () => void;
  remotePlaybackBlocked: boolean;
  onResumeRemotePlayback: () => void;
}

export default function RoomBanners({ micError, micRetrying, onRetryMic, onDismissMicError, needsAudioGesture, onResumeAudio, remotePlaybackBlocked, onResumeRemotePlayback }: Props) {
  return (
    <>
      {micError && (
        <RoomBanner icon={MicOff} role="alert" message={micErrorMessage(micError)}>
          {/* Retrying can't help until the page is opened over HTTPS. */}
          {micError !== "insecure" && (
            <button onClick={onRetryMic} disabled={micRetrying} className={`${BANNER_ACTION} disabled:opacity-60 disabled:cursor-wait`}>
              {micRetrying ? "Retrying..." : "Retry"}
            </button>
          )}
          {micError === "switch-failed" && (
            <button
              onClick={onDismissMicError}
              className="touch-target p-1 rounded-md hover:bg-amber-500/30 text-amber-200 transition-colors cursor-pointer"
              title="Dismiss"
              aria-label="Dismiss"
            >
              <X size={14} />
            </button>
          )}
        </RoomBanner>
      )}
      {/* Audio enable banner: shown when the browser blocked AudioContext
          resume / autoplay (notably Safari/iOS after backgrounding). The
          action must be triggered by a user gesture. */}
      {needsAudioGesture && (
        <RoomBanner icon={Volume2} message="Audio was paused by your browser. Click to re-enable voice.">
          <button onClick={onResumeAudio} className={BANNER_ACTION}>
            Enable audio
          </button>
        </RoomBanner>
      )}
      {/* Remote playback blocked: the AudioContext that plays OTHER users'
          voices is suspended (autoplay block / OS interruption). Without this
          banner there was no recovery path — the user heard nobody. */}
      {remotePlaybackBlocked && (
        <RoomBanner icon={Volume2} message="Incoming audio was paused by your browser. Click to hear others.">
          <button onClick={onResumeRemotePlayback} className={BANNER_ACTION}>
            Enable audio
          </button>
        </RoomBanner>
      )}
    </>
  );
}

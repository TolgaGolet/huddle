import { Mic, MicOff, MonitorUp, MonitorOff } from "lucide-react";

interface Props {
  isMuted: boolean;
  /** No working mic: the button retries instead of toggling mute. */
  micUnavailable: boolean;
  isScreenSharing: boolean;
  screenShareDisabled?: boolean;
  /** Why it's disabled, as the button's label. */
  screenShareDisabledLabel?: string;
  onToggleMute: () => void;
  onToggleScreenShare: () => void;
  /** Smaller buttons with no border, for the mobile top strip. */
  compact?: boolean;
}

export default function VoiceControls({
  isMuted,
  micUnavailable,
  isScreenSharing,
  screenShareDisabled,
  screenShareDisabledLabel = "Someone is already sharing",
  onToggleMute,
  onToggleScreenShare,
  compact,
}: Props) {
  // Most phone browsers can't capture the screen, so the button would do nothing.
  const canShareScreen = !!navigator.mediaDevices?.getDisplayMedia;
  const size = compact ? "p-2.5" : "p-3";
  const screenDisabled = screenShareDisabled && !isScreenSharing;
  let micLabel = isMuted ? "Unmute" : "Mute";
  let micColors = isMuted ? "bg-red-500/20 text-red-400 hover:bg-red-500/30" : "bg-gray-800 text-gray-300 hover:bg-gray-700";
  if (micUnavailable) {
    micLabel = "Microphone unavailable, retry";
    micColors = "bg-amber-500/20 text-amber-300 hover:bg-amber-500/30";
  }
  const screenLabel = screenDisabled ? screenShareDisabledLabel : isScreenSharing ? "Stop sharing" : "Share screen";

  return (
    <div className={compact ? "flex items-center gap-2 shrink-0" : "flex items-center justify-center gap-3 px-4 py-3 border-t border-gray-800"}>
      <button
        onClick={onToggleMute}
        className={`${size} rounded-full transition-colors cursor-pointer ${micColors}`}
        title={micLabel}
        aria-label={micLabel}
      >
        {isMuted ? <MicOff size={20} /> : <Mic size={20} />}
      </button>
      {canShareScreen && (
        <button
          onClick={screenDisabled ? undefined : onToggleScreenShare}
          disabled={!!screenDisabled}
          className={`${size} rounded-full transition-colors ${
            screenDisabled
              ? "bg-gray-800/50 text-gray-600 cursor-not-allowed"
              : isScreenSharing
                ? "bg-indigo-500/20 text-indigo-400 hover:bg-indigo-500/30 cursor-pointer"
                : "bg-gray-800 text-gray-300 hover:bg-gray-700 cursor-pointer"
          }`}
          title={screenLabel}
          aria-label={screenLabel}
        >
          {isScreenSharing ? <MonitorOff size={20} /> : <MonitorUp size={20} />}
        </button>
      )}
    </div>
  );
}

import { Mic, MicOff, MonitorUp, MonitorOff } from "lucide-react";

interface Props {
  isMuted: boolean;
  isScreenSharing: boolean;
  screenShareDisabled?: boolean;
  onToggleMute: () => void;
  onToggleScreenShare: () => void;
}

export default function VoiceControls({
  isMuted,
  isScreenSharing,
  screenShareDisabled,
  onToggleMute,
  onToggleScreenShare,
}: Props) {
  const screenDisabled = screenShareDisabled && !isScreenSharing;

  return (
    <div className="flex items-center justify-center gap-3 px-4 py-3 border-t border-gray-800">
      <button
        onClick={onToggleMute}
        className={`p-3 rounded-full transition-colors cursor-pointer ${
          isMuted
            ? "bg-red-500/20 text-red-400 hover:bg-red-500/30"
            : "bg-gray-800 text-gray-300 hover:bg-gray-700"
        }`}
        title={isMuted ? "Unmute" : "Mute"}
      >
        {isMuted ? <MicOff size={20} /> : <Mic size={20} />}
      </button>
      <button
        onClick={screenDisabled ? undefined : onToggleScreenShare}
        disabled={!!screenDisabled}
        className={`p-3 rounded-full transition-colors ${
          screenDisabled
            ? "bg-gray-800/50 text-gray-600 cursor-not-allowed"
            : isScreenSharing
              ? "bg-indigo-500/20 text-indigo-400 hover:bg-indigo-500/30 cursor-pointer"
              : "bg-gray-800 text-gray-300 hover:bg-gray-700 cursor-pointer"
        }`}
        title={screenDisabled ? "Someone is already sharing" : isScreenSharing ? "Stop sharing" : "Share screen"}
      >
        {isScreenSharing ? <MonitorOff size={20} /> : <MonitorUp size={20} />}
      </button>
    </div>
  );
}

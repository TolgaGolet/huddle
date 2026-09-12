import { Mic, MicOff, EllipsisVertical, Loader2 } from "lucide-react";
import type { Participant } from "../types";
import { avatarBgColor } from "../lib/avatarColor";

interface Props {
  participant: Participant;
  isSpeaking: boolean;
  isLocal?: boolean;
  /** WebRTC connection state of the peer link; undefined while unknown. */
  connectionState?: RTCPeerConnectionState;
  onContextMenu?: (e: React.MouseEvent) => void;
  onMenuClick?: (e: React.MouseEvent) => void;
}

function getInitials(name: string): string {
  return name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

export default function ParticipantCard({ participant, isSpeaking, isLocal, connectionState, onContextMenu, onMenuClick }: Props) {
  // "Connecting" is any state where the audio link is not yet usable. Note
  // the media pipeline also requires the PC to be connected; "disconnected"
  // means audio may be interrupted, which we surface the same way.
  const isConnecting =
    !isLocal &&
    (connectionState === undefined ||
      connectionState === "new" ||
      connectionState === "connecting" ||
      connectionState === "disconnected" ||
      connectionState === "failed");
  const stateLabel =
    connectionState === "failed" ? "Reconnecting…" : "Connecting…";

  return (
    <div
      onContextMenu={onContextMenu}
      className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-gray-800/60 transition-colors select-none group"
    >
      <div
        className={`relative flex-shrink-0 w-9 h-9 rounded-full flex items-center justify-center text-sm font-semibold ${avatarBgColor(participant.name)} ${
          isSpeaking && !participant.isMuted ? "ring-2 ring-green-400 ring-offset-2 ring-offset-gray-900" : ""
        } transition-shadow`}
      >
        {getInitials(participant.name)}
      </div>
      <span className="flex-1 text-sm truncate text-gray-200">
        {participant.name}
        {isLocal && <span className="text-gray-500 ml-1">(you)</span>}
      </span>
      {isConnecting && (
        <span
          className="flex items-center gap-1 text-[11px] text-amber-400 flex-shrink-0"
          title="Still establishing audio — they may not hear you yet"
        >
          <Loader2 size={12} className="animate-spin" />
          {stateLabel}
        </span>
      )}
      {participant.isMuted ? (
        <MicOff size={16} className="text-red-400 flex-shrink-0" />
      ) : (
        <Mic size={16} className="text-gray-400 flex-shrink-0" />
      )}
      {onMenuClick && (
        <button
          onClick={onMenuClick}
          className="flex-shrink-0 p-0.5 rounded text-gray-500 hover:text-gray-200 transition-colors cursor-pointer"
        >
          <EllipsisVertical size={16} />
        </button>
      )}
    </div>
  );
}

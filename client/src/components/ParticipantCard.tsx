import { Mic, MicOff, EllipsisVertical } from "lucide-react";
import type { Participant } from "../types";

interface Props {
  participant: Participant;
  isSpeaking: boolean;
  isLocal?: boolean;
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

const COLORS = [
  "bg-indigo-600",
  "bg-emerald-600",
  "bg-rose-600",
  "bg-amber-600",
  "bg-cyan-600",
  "bg-violet-600",
  "bg-pink-600",
  "bg-teal-600",
];

function avatarColor(name: string): string {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return COLORS[Math.abs(hash) % COLORS.length];
}

export default function ParticipantCard({ participant, isSpeaking, isLocal, onContextMenu, onMenuClick }: Props) {
  return (
    <div
      onContextMenu={onContextMenu}
      className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-gray-800/60 transition-colors select-none group"
    >
      <div
        className={`relative flex-shrink-0 w-9 h-9 rounded-full flex items-center justify-center text-sm font-semibold ${avatarColor(participant.name)} ${
          isSpeaking ? "ring-2 ring-green-400 ring-offset-2 ring-offset-gray-900" : ""
        } transition-shadow`}
      >
        {getInitials(participant.name)}
      </div>
      <span className="flex-1 text-sm truncate text-gray-200">
        {participant.name}
        {isLocal && <span className="text-gray-500 ml-1">(you)</span>}
      </span>
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

import { Settings, LogOut, Copy, Check, Link, X } from "lucide-react";
import { useCopyFeedback } from "../hooks/useCopyFeedback";

interface Props {
  roomId: string;
  connected: boolean;
  onOpenSettings: () => void;
  onLeave: () => void;
}

export default function RoomHeader({ roomId, connected, onOpenSettings, onLeave }: Props) {
  const { status: roomIdCopy, copy: copyRoomId } = useCopyFeedback();
  const { status: linkCopy, copy: copyLink } = useCopyFeedback();
  const linkLabel = linkCopy === "failed" ? "Couldn't copy room link" : "Copy room link";

  return (
    <header className="flex items-center justify-between gap-2 px-4 py-2 border-b border-gray-800 bg-gray-900/50 shrink-0">
      <div className="flex items-center gap-3 min-w-0">
        <h1 className="sr-only sm:not-sr-only text-sm font-bold tracking-tight">Huddle</h1>
        <div className="hidden sm:block h-4 w-px bg-gray-700" />
        <button
          onClick={() => void copyRoomId(roomId)}
          className="touch-target flex items-center gap-1.5 min-w-0 text-xs text-gray-400 hover:text-gray-200 transition-colors cursor-pointer"
          title={roomIdCopy === "failed" ? "Couldn't copy room ID" : "Copy room ID"}
        >
          <span className="font-mono truncate">{roomId}</span>
          {roomIdCopy === "copied" && <Check size={12} className="shrink-0 text-green-400" />}
          {roomIdCopy === "failed" && <X size={12} className="shrink-0 text-red-400" />}
          {roomIdCopy === "idle" && <Copy size={12} className="shrink-0" />}
        </button>
        <button
          onClick={() => void copyLink(globalThis.location.href)}
          className="touch-target flex items-center gap-1.5 shrink-0 text-xs text-gray-400 hover:text-gray-200 transition-colors cursor-pointer"
          title={linkLabel}
          aria-label={linkLabel}
        >
          <span className="hidden sm:inline">Copy Link</span>
          {linkCopy === "copied" && <Check size={12} className="text-green-400" />}
          {linkCopy === "failed" && <X size={12} className="text-red-400" />}
          {linkCopy === "idle" && <Link size={12} className="sm:hidden" />}
          {linkCopy === "idle" && <Copy size={12} className="hidden sm:block" />}
        </button>
        {!connected && (
          <span className="truncate text-xs text-amber-400 animate-pulse">Connecting...</span>
        )}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <button
          onClick={onOpenSettings}
          className="p-2 rounded-lg text-gray-400 hover:text-gray-200 hover:bg-gray-800 transition-colors cursor-pointer"
          title="Settings"
          aria-label="Settings"
        >
          <Settings size={18} />
        </button>
        <button
          onClick={onLeave}
          className="p-2 rounded-lg text-gray-400 hover:text-red-400 hover:bg-gray-800 transition-colors cursor-pointer"
          title="Leave room"
          aria-label="Leave room"
        >
          <LogOut size={18} />
        </button>
      </div>
    </header>
  );
}

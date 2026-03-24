import { useEffect, useRef } from "react";
import { Volume2 } from "lucide-react";

interface Props {
  x: number;
  y: number;
  name: string;
  volume: number;
  onVolumeChange: (v: number) => void;
  onClose: () => void;
}

export default function ParticipantContextMenu({ x, y, name, volume, onVolumeChange, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="fixed z-50 bg-gray-800 border border-gray-700 rounded-lg shadow-xl p-3 min-w-[200px]"
      style={{ left: x, top: y }}
    >
      <p className="text-xs text-gray-400 mb-2 truncate">{name}</p>
      <div className="flex items-center gap-2">
        <Volume2 size={14} className="text-gray-400 flex-shrink-0" />
        <input
          type="range"
          min={0}
          max={300}
          value={Math.round(volume * 100)}
          onChange={(e) => onVolumeChange(Number(e.target.value) / 100)}
          className="flex-1 accent-indigo-500 h-1"
        />
        <span className="text-xs text-gray-400 w-10 text-right">{Math.round(volume * 100)}%</span>
      </div>
    </div>
  );
}

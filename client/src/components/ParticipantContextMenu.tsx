import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
  // Clamp the menu inside the viewport so it never renders off-screen
  // (which was making it appear as if "nothing happens").
  const [pos, setPos] = useState({ x, y });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const nx = x + rect.width > window.innerWidth ? window.innerWidth - rect.width - 8 : x;
    const ny = y + rect.height > window.innerHeight ? window.innerHeight - rect.height - 8 : y;
    setPos({ x: Math.max(8, nx), y: Math.max(8, ny) });
  }, [x, y]);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [onClose]);

  // Portal to document.body so the menu escapes any stacking context / overflow
  // clipping created by the sidebar layout and always paints above the main panel.
  return createPortal(
    <div
      ref={ref}
      className="fixed z-[100] bg-gray-800 border border-gray-700 rounded-lg shadow-xl p-3 min-w-[200px]"
      style={{ left: pos.x, top: pos.y }}
    >
      <p className="text-xs text-gray-400 mb-2 truncate">{name}</p>
      <div className="flex items-center gap-2">
        <Volume2 size={14} className="text-gray-400 flex-shrink-0" />
        <input
          type="range"
          min={0}
          max={200}
          value={Math.round(volume * 100)}
          onChange={(e) => onVolumeChange(Number(e.target.value) / 100)}
          className="flex-1 accent-indigo-500 h-1"
        />
        <span className="text-xs text-gray-400 w-10 text-right">{Math.round(volume * 100)}%</span>
      </div>
    </div>,
    document.body,
  );
}

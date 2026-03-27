import { useState, useRef, useEffect } from "react";
import { CATEGORIES, EMOJI_NAMES, loadRecentEmojis, saveRecentEmoji } from "../lib/emojiData";

interface Props {
  onSelect: (emoji: string) => void;
  onClose: () => void;
}

export default function EmojiPicker({ onSelect, onClose }: Props) {
  const [activeCategory, setActiveCategory] = useState(0);
  const [search, setSearch] = useState("");
  const [recentEmojis, setRecentEmojis] = useState<string[]>(() => loadRecentEmojis());
  const [hoveredEmoji, setHoveredEmoji] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [onClose]);

  function handleSelect(emoji: string) {
    const updated = saveRecentEmoji(emoji);
    setRecentEmojis(updated);
    onSelect(emoji);
    onClose();
  }

  const query = search.toLowerCase().trim();
  const filteredEmojis = query
    ? CATEGORIES.flatMap((c) => c.emojis).filter((e) => {
        const name = (EMOJI_NAMES[e] ?? "").toLowerCase();
        return name.includes(query) || e === query;
      })
    : CATEGORIES[activeCategory].emojis;

  const tooltipText = hoveredEmoji
    ? (EMOJI_NAMES[hoveredEmoji] ?? "").split(" ")[0]
    : null;

  return (
    <div
      ref={ref}
      className="absolute bottom-full mb-2 right-0 w-72 bg-gray-800 border border-gray-700 rounded-xl shadow-2xl z-50 overflow-hidden flex flex-col"
    >
      {/* Search */}
      <div className="p-2 border-b border-gray-700">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search emojis..."
          className="w-full px-2 py-1.5 rounded-lg bg-gray-900 border border-gray-600 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500"
          autoFocus
        />
      </div>

      {/* Recent emojis */}
      {!query && recentEmojis.length > 0 && (
        <div className="px-2 pt-2">
          <p className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold mb-1 px-1">
            Recent
          </p>
          <div className="flex gap-0.5">
            {recentEmojis.map((emoji, i) => (
              <button
                key={`recent-${emoji}-${i}`}
                type="button"
                onClick={() => handleSelect(emoji)}
                onMouseEnter={() => setHoveredEmoji(emoji)}
                onMouseLeave={() => setHoveredEmoji(null)}
                className="p-1.5 text-lg rounded hover:bg-gray-700 transition-colors cursor-pointer leading-none"
              >
                {emoji}
              </button>
            ))}
          </div>
          <div className="mt-2 h-px bg-gray-700" />
        </div>
      )}

      {/* Category tabs */}
      {!query && (
        <div className="flex border-b border-gray-700 px-1">
          {CATEGORIES.map((cat, i) => (
            <button
              key={cat.name}
              type="button"
              onClick={() => setActiveCategory(i)}
              className={`flex-1 py-1.5 text-center text-sm cursor-pointer transition-colors ${
                i === activeCategory ? "bg-gray-700 rounded-t-lg" : "hover:bg-gray-700/40"
              }`}
              title={cat.name}
            >
              {cat.icon}
            </button>
          ))}
        </div>
      )}

      {/* Emoji grid */}
      <div className="grid grid-cols-8 gap-0.5 p-2 max-h-48 overflow-y-auto">
        {filteredEmojis.length === 0 ? (
          <p className="col-span-8 text-center text-xs text-gray-500 py-4">
            No emojis found
          </p>
        ) : (
          filteredEmojis.map((emoji, i) => (
            <button
              key={`${emoji}-${i}`}
              type="button"
              onClick={() => handleSelect(emoji)}
              onMouseEnter={() => setHoveredEmoji(emoji)}
              onMouseLeave={() => setHoveredEmoji(null)}
              className="p-1 text-lg rounded hover:bg-gray-700 transition-colors cursor-pointer text-center leading-none"
            >
              {emoji}
            </button>
          ))
        )}
      </div>

      {/* Hover status bar */}
      <div className="h-7 border-t border-gray-700 px-3 flex items-center gap-2 bg-gray-800/70">
        {hoveredEmoji ? (
          <>
            <span className="text-base leading-none">{hoveredEmoji}</span>
            <span className="text-xs text-gray-400">{tooltipText ?? ""}</span>
          </>
        ) : (
          <span className="text-[10px] text-gray-600">
            {query ? `${filteredEmojis.length} result${filteredEmojis.length !== 1 ? "s" : ""}` : CATEGORIES[activeCategory]?.name}
          </span>
        )}
      </div>
    </div>
  );
}

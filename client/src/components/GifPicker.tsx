import { useState, useEffect, useRef, useCallback } from "react";
import { Search, X } from "lucide-react";
import type { GifItem } from "../lib/giphyClient";
import { fetchTrending, fetchSearch } from "../lib/giphyClient";

interface Props {
  onSelect: (gifUrl: string, gifTitle: string) => void;
  onClose: () => void;
}

export default function GifPicker({ onSelect, onClose }: Props) {
  const [search, setSearch] = useState("");
  const [gifs, setGifs] = useState<GifItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Close on outside click
  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [onClose]);

  const load = useCallback(async (query: string) => {
    setLoading(true);
    setError(null);
    try {
      const results = query.trim()
        ? await fetchSearch(query.trim())
        : await fetchTrending();
      setGifs(results);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load GIFs");
      setGifs([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // Load trending on mount
  useEffect(() => {
    load("");
  }, [load]);

  // Debounced search
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => load(search), 400);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [search, load]);

  return (
    <div
      ref={ref}
      className="absolute bottom-full mb-2 right-0 w-80 bg-gray-800 border border-gray-700 rounded-xl shadow-2xl z-50 flex flex-col overflow-hidden"
      style={{ maxHeight: "360px" }}
    >
      {/* Header */}
      <div className="flex items-center gap-2 p-2 border-b border-gray-700">
        <div className="flex-1 flex items-center gap-2 px-2 py-1.5 rounded-lg bg-gray-900 border border-gray-600 focus-within:border-indigo-500 transition-colors">
          <Search size={13} className="text-gray-500 shrink-0" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search GIFs..."
            className="flex-1 bg-transparent text-sm text-white placeholder-gray-500 focus:outline-none"
            autoFocus
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch("")}
              className="text-gray-500 hover:text-gray-300 transition-colors cursor-pointer"
            >
              <X size={12} />
            </button>
          )}
        </div>
      </div>

      {/* Section label */}
      <div className="px-3 pt-2 pb-1">
        <span className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold">
          {search.trim() ? `Results for "${search.trim()}"` : "Trending"}
        </span>
      </div>

      {/* GIF grid */}
      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {loading && (
          <div className="flex items-center justify-center h-24">
            <div className="w-5 h-5 border-2 border-gray-600 border-t-indigo-500 rounded-full animate-spin" />
          </div>
        )}

        {!loading && error && (
          <div className="flex flex-col items-center justify-center h-24 gap-1">
            <p className="text-xs text-red-400">{error}</p>
            {error.includes("GIPHY_API_KEY") && (
              <p className="text-[10px] text-gray-500 text-center px-4">
                Add <code className="text-pink-300">GIPHY_API_KEY</code> to your server's environment variables.
              </p>
            )}
          </div>
        )}

        {!loading && !error && gifs.length === 0 && (
          <div className="flex items-center justify-center h-24">
            <p className="text-xs text-gray-500">No GIFs found</p>
          </div>
        )}

        {!loading && !error && gifs.length > 0 && (
          <div className="columns-2 gap-1.5 space-y-1.5">
            {gifs.map((gif) => (
              <button
                key={gif.id}
                type="button"
                onClick={() => {
                  onSelect(gif.url, gif.title);
                  onClose();
                }}
                className="w-full block rounded-lg overflow-hidden cursor-pointer hover:ring-2 hover:ring-indigo-500 transition-all focus:outline-none focus:ring-2 focus:ring-indigo-500"
                title={gif.title}
              >
                <img
                  src={gif.preview}
                  alt={gif.title}
                  className="w-full object-cover"
                  loading="lazy"
                />
              </button>
            ))}
          </div>
        )}
      </div>

      {/* GIPHY attribution — required by their API terms */}
      <div className="flex items-center justify-center py-1.5 border-t border-gray-700 bg-gray-800/80">
        <a
          href="https://giphy.com"
          target="_blank"
          rel="noopener noreferrer"
          className="text-[10px] text-gray-500 hover:text-gray-300 transition-colors tracking-wider uppercase font-semibold"
        >
          Powered by GIPHY
        </a>
      </div>
    </div>
  );
}

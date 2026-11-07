import { memo, useId, useState } from "react";
import { ChevronDown, ChevronUp, GripVertical, ListVideo, Play, Trash2 } from "lucide-react";
import type { WatchQueueEntry } from "../types";
import { thumbnailUrl } from "../lib/youtubeApi";

interface Props {
  queue: WatchQueueEntry[];
  /** Only those who may control the party can play, remove or reorder. */
  canEdit: boolean;
  nameOf: (userId: string) => string;
  onRemove: (entryId: string) => void;
  onPlay: (entryId: string) => void;
  onMove: (entryId: string, toIndex: number) => void;
}

export const queueTitle = (entry: Pick<WatchQueueEntry, "title">) => entry.title ?? "YouTube video";

/** The watch party's "Up next": every member sees it, those with control can edit it. Memoized so typing in the panel's input doesn't re-render it. */
export default memo(WatchQueue);

function WatchQueue({ queue, canEdit, nameOf, onRemove, onPlay, onMove }: Props) {
  const [open, setOpen] = useState(true);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const listId = useId();

  if (queue.length === 0) return null;

  const endDrag = () => {
    setDragId(null);
    setOverIndex(null);
  };

  return (
    <div className="border-b border-gray-800 shrink-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={listId}
        className="flex w-full items-center gap-1.5 px-3 py-1 text-left text-[11px] font-medium text-gray-300 hover:bg-gray-900 cursor-pointer"
      >
        <ListVideo size={13} className="text-indigo-400" aria-hidden />
        Up next ({queue.length})
        {!open && <span className="ml-1 min-w-0 truncate font-normal text-gray-400">{queueTitle(queue[0])}</span>}
        <ChevronDown size={13} className={`ml-auto shrink-0 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
      </button>
      <ol id={listId} hidden={!open} aria-label="Up next" className="max-h-36 overflow-y-auto px-2 pb-1.5">
        {queue.map((entry, index) => {
          const title = queueTitle(entry);
          return (
            <li
              key={entry.id}
              draggable={canEdit}
              onDragStart={(e) => {
                setDragId(entry.id);
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", entry.id);
              }}
              onDragOver={(e) => {
                if (!dragId) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                if (overIndex !== index) setOverIndex(index);
              }}
              onDrop={(e) => {
                e.preventDefault();
                const from = queue.findIndex((q) => q.id === dragId);
                // The indicator means "before this item". The server takes the
                // dragged one out first, so moving down lands one slot earlier.
                const to = from >= 0 && from < index ? index - 1 : index;
                if (dragId && from >= 0 && to !== from) onMove(dragId, to);
                endDrag();
              }}
              onDragEnd={endDrag}
              className={`flex items-center gap-2 rounded px-1 py-1 border-t-2 ${
                overIndex === index && dragId !== entry.id ? "border-indigo-500" : "border-transparent"
              } ${dragId === entry.id ? "opacity-50" : ""}`}
            >
              {canEdit && <GripVertical size={13} className="shrink-0 cursor-grab text-gray-500" aria-hidden />}
              <span className="w-4 shrink-0 text-right text-[11px] text-gray-400">{index + 1}</span>
              {canEdit ? (
                // The whole item plays it, as a button so the keyboard can too.
                <button
                  type="button"
                  onClick={() => onPlay(entry.id)}
                  aria-label={`Play now: ${title}`}
                  title="Play now"
                  className="group flex flex-1 min-w-0 items-center gap-2 rounded text-left hover:bg-gray-800/70 cursor-pointer"
                >
                  <span className="relative h-8 aspect-video shrink-0">
                    <img src={thumbnailUrl(entry.videoId)} alt="" loading="lazy" className="h-full w-full rounded object-cover bg-gray-800" />
                    <span className="absolute inset-0 hidden items-center justify-center rounded bg-black/50 group-hover:flex group-focus-visible:flex">
                      <Play size={12} className="text-white" aria-hidden />
                    </span>
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="block truncate text-xs text-gray-100">{title}</span>
                    <span className="block truncate text-[11px] text-gray-400">Added by {nameOf(entry.addedBy)}</span>
                  </span>
                </button>
              ) : (
                <>
                  <img src={thumbnailUrl(entry.videoId)} alt="" loading="lazy" className="h-8 aspect-video shrink-0 rounded object-cover bg-gray-800" />
                  <div className="flex-1 min-w-0">
                    <p className="truncate text-xs text-gray-100">{title}</p>
                    <p className="truncate text-[11px] text-gray-400">Added by {nameOf(entry.addedBy)}</p>
                  </div>
                </>
              )}
              {canEdit && (
                <div className="flex shrink-0 items-center">
                  <button
                    type="button"
                    disabled={index === 0}
                    onClick={() => onMove(entry.id, index - 1)}
                    aria-label={`Move up: ${title}`}
                    className="touch-target p-1 rounded text-gray-400 hover:text-gray-200 hover:bg-gray-800 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
                  >
                    <ChevronUp size={13} />
                  </button>
                  <button
                    type="button"
                    disabled={index === queue.length - 1}
                    onClick={() => onMove(entry.id, index + 1)}
                    aria-label={`Move down: ${title}`}
                    className="touch-target p-1 rounded text-gray-400 hover:text-gray-200 hover:bg-gray-800 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
                  >
                    <ChevronDown size={13} />
                  </button>
                  <button
                    type="button"
                    onClick={() => onRemove(entry.id)}
                    aria-label={`Remove from queue: ${title}`}
                    className="touch-target p-1 rounded text-gray-400 hover:text-red-300 hover:bg-red-500/10 cursor-pointer"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

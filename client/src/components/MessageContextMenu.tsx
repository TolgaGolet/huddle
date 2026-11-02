import { useEffect, useRef } from "react";
import { Pencil, Pin, PinOff, Trash2 } from "lucide-react";
import { cycleFocus } from "../lib/focusTrap";

interface Props {
  messageId: string;
  x: number;
  y: number;
  isOwn: boolean;
  isPinned: boolean;
  canEdit: boolean;
  /** False when only owners can pin. */
  canPin?: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onTogglePin: () => void;
  /** Closes from the keyboard; focus goes back to the message. */
  onClose: () => void;
  /** Closes from a click elsewhere, which already moved focus. */
  onDismiss: () => void;
}

export default function MessageContextMenu({ messageId, x, y, isOwn, isPinned, canEdit, canPin = true, onEdit, onDelete, onTogglePin, onClose, onDismiss }: Props) {
  const menuRef = useRef<HTMLDivElement>(null);

  // Move focus into the context menu when it opens, so keyboard users land on
  // it rather than having to Tab past every later message.
  useEffect(() => {
    menuRef.current?.querySelector("button")?.focus();
  }, [messageId]);

  // Close the context menu on any click outside of it.
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) onDismiss();
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [onDismiss]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape" || e.key === "Tab") {
      // Tab isn't prevented: it carries on from the message the menu belongs to.
      onClose();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      cycleFocus([...e.currentTarget.querySelectorAll("button")], e.key === "ArrowUp");
    }
  }

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label="Message actions"
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      style={{ left: x, top: y }}
      className="absolute z-30 min-w-40 py-1 rounded-lg bg-gray-800 border border-gray-700 shadow-xl"
    >
      {canEdit && (
        <button
          type="button"
          role="menuitem"
          onClick={onEdit}
          className="flex w-full pointer-coarse:min-h-10 items-center gap-2 px-3 py-1.5 text-xs text-gray-200 hover:bg-gray-700 transition-colors cursor-pointer"
        >
          <Pencil size={12} /> Edit message
        </button>
      )}
      {isOwn && (
        <button
          type="button"
          role="menuitem"
          onClick={onDelete}
          className="flex w-full pointer-coarse:min-h-10 items-center gap-2 px-3 py-1.5 text-xs text-red-400 hover:bg-gray-700 transition-colors cursor-pointer"
        >
          <Trash2 size={12} /> Delete message
        </button>
      )}
      <button
        type="button"
        role="menuitem"
        onClick={onTogglePin}
        disabled={!canPin}
        title={canPin ? undefined : "Only owners can pin messages"}
        className="disabled:opacity-50 disabled:cursor-not-allowed flex w-full pointer-coarse:min-h-10 items-center gap-2 px-3 py-1.5 text-xs text-gray-200 hover:bg-gray-700 transition-colors cursor-pointer"
      >
        {isPinned ? <PinOff size={12} /> : <Pin size={12} />}
        {isPinned ? "Unpin message" : "Pin message"}
      </button>
    </div>
  );
}

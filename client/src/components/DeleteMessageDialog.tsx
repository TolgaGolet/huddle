import { Trash2 } from "lucide-react";
import Dialog from "./Dialog";

interface Props {
  /** Set when an owner deletes someone else's message, so it isn't mistaken for their own. */
  senderName?: string;
  onCancel: () => void;
  onConfirm: () => void;
  returnFocus: () => HTMLElement | null;
}

export default function DeleteMessageDialog({ senderName, onCancel, onConfirm, returnFocus }: Props) {
  return (
    <Dialog
      onClose={onCancel}
      labelledBy="delete-dialog-title"
      closeOnBackdrop
      returnFocus={returnFocus}
      overlayClassName="absolute inset-0 z-40 flex items-center justify-center bg-black/60"
      panelClassName="mx-4 w-72 rounded-xl bg-gray-800 border border-gray-700 shadow-2xl p-4 focus:outline-none"
    >
      <div className="flex items-center gap-2 mb-2">
        <Trash2 size={14} className="text-red-400" />
        <h3 id="delete-dialog-title" className="text-sm font-semibold text-white">{senderName ? `Delete ${senderName}'s message?` : "Delete message?"}</h3>
      </div>
      <p className="text-xs text-gray-400 mb-4">
        This message will be removed for everyone in the room. This cannot be undone.
      </p>
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="px-3 py-1.5 rounded-lg bg-gray-700 hover:bg-gray-600 text-xs text-gray-200 transition-colors cursor-pointer"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onConfirm}
          className="px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-500 text-xs text-white transition-colors cursor-pointer"
        >
          Delete
        </button>
      </div>
    </Dialog>
  );
}

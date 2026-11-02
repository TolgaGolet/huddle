import { useId, type ReactNode } from "react";
import Dialog from "./Dialog";

export default function ConfirmDialog({ icon, title, body, confirmLabel, overlayZ, onCancel, onConfirm }: {
  icon: ReactNode;
  title: string;
  body: string;
  confirmLabel: string;
  /** A Tailwind class, as the dialog can open over other overlays. */
  overlayZ: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const titleId = useId();
  return (
    <Dialog
      onClose={onCancel}
      labelledBy={titleId}
      overlayClassName={`fixed inset-0 ${overlayZ} flex items-center justify-center bg-black/60 backdrop-blur-sm`}
      panelClassName="w-full max-w-sm mx-4 rounded-xl bg-gray-900 border border-gray-700 shadow-2xl p-6 focus:outline-none"
    >
      <div className="flex items-center gap-3 mb-4">
        <div className="p-2 rounded-full bg-red-500/10 text-red-400">{icon}</div>
        <div className="min-w-0">
          <h3 id={titleId} className="text-lg font-semibold text-gray-100 truncate">{title}</h3>
          <p className="text-sm text-gray-400 mt-0.5">{body}</p>
        </div>
      </div>
      <div className="flex gap-3 justify-end">
        <button onClick={onCancel} className="px-4 py-2 rounded-lg text-sm text-gray-300 hover:bg-gray-800 transition-colors cursor-pointer">
          Cancel
        </button>
        <button onClick={onConfirm} className="px-4 py-2 rounded-lg text-sm font-medium bg-red-600 hover:bg-red-500 text-white transition-colors cursor-pointer">
          {confirmLabel}
        </button>
      </div>
    </Dialog>
  );
}

import { AlertTriangle } from "lucide-react";
import Dialog from "./Dialog";

export default function LeaveRoomDialog({ onCancel, onLeave }: { onCancel: () => void; onLeave: () => void }) {
  return (
    <Dialog
      onClose={onCancel}
      labelledBy="leave-dialog-title"
      overlayClassName="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      panelClassName="w-full max-w-sm mx-4 rounded-xl bg-gray-900 border border-gray-700 shadow-2xl p-6 focus:outline-none"
    >
      <div className="flex items-center gap-3 mb-4">
        <div className="p-2 rounded-full bg-red-500/10 text-red-400">
          <AlertTriangle size={22} />
        </div>
        <div>
          <h3 id="leave-dialog-title" className="text-lg font-semibold text-gray-100">Leave room?</h3>
          <p className="text-sm text-gray-400 mt-0.5">
            You will be disconnected from the call.
          </p>
        </div>
      </div>
      <div className="flex gap-3 justify-end">
        <button
          onClick={onCancel}
          className="px-4 py-2 rounded-lg text-sm text-gray-300 hover:bg-gray-800 transition-colors cursor-pointer"
        >
          Cancel
        </button>
        <button
          onClick={onLeave}
          className="px-4 py-2 rounded-lg text-sm font-medium bg-red-600 hover:bg-red-500 text-white transition-colors cursor-pointer"
        >
          Leave
        </button>
      </div>
    </Dialog>
  );
}

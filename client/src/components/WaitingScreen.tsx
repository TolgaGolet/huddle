import { Hourglass } from "lucide-react";

/** For someone in a room's waiting room, who stays here until an owner accepts them. */
export default function WaitingScreen({ onLeave }: { onLeave: () => void }) {
  return (
    <div className="min-h-dvh flex items-center justify-center bg-gray-950 px-4">
      <div role="status" className="w-full max-w-md text-center">
        <Hourglass size={32} className="mx-auto mb-4 text-amber-400" />
        <h1 className="text-xl font-semibold text-white mb-2">Waiting for an owner</h1>
        <p className="text-sm text-gray-400 mb-6">An owner of this room has been told you're here. You'll join as soon as they accept you.</p>
        <button
          type="button"
          onClick={onLeave}
          className="px-4 py-2 rounded-lg text-sm bg-gray-800 hover:bg-gray-700 border border-gray-700 transition-colors cursor-pointer"
        >
          Leave
        </button>
      </div>
    </div>
  );
}

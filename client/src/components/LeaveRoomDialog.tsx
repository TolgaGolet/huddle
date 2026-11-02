import { AlertTriangle } from "lucide-react";
import ConfirmDialog from "./ConfirmDialog";

export default function LeaveRoomDialog({ onCancel, onLeave }: { onCancel: () => void; onLeave: () => void }) {
  return (
    <ConfirmDialog
      icon={<AlertTriangle size={22} />}
      title="Leave room?"
      body="You will be disconnected from the call."
      confirmLabel="Leave"
      overlayZ="z-50"
      onCancel={onCancel}
      onConfirm={onLeave}
    />
  );
}

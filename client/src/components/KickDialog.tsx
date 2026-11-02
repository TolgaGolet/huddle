import { UserX } from "lucide-react";
import ConfirmDialog from "./ConfirmDialog";

export default function KickDialog({ name, onCancel, onKick }: { name: string; onCancel: () => void; onKick: () => void }) {
  return (
    <ConfirmDialog
      icon={<UserX size={22} />}
      title={`Kick ${name}?`}
      body="If they, or someone on their network, try to come back, they'll wait until an owner accepts them."
      confirmLabel="Kick"
      overlayZ="z-[110]"
      onCancel={onCancel}
      onConfirm={onKick}
    />
  );
}

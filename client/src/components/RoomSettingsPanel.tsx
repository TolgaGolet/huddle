import { useEffect, useRef, useState } from "react";
import { isValidNewPassword, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, type AppSocket, type RoomPermission, type RoomSettings } from "../types";
import { REQUEST_TIMEOUT_MS } from "../lib/requestTimeouts";
import { FIELD_CLASS } from "./fieldStyles";

export function PermissionSelect({ id, label, value, disabled, onChange }: {
  id: string;
  label: string;
  value: RoomPermission;
  disabled?: boolean;
  onChange: (value: RoomPermission) => void;
}) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm text-gray-300 mb-1">{label}</label>
      <select id={id} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as RoomPermission)} className={FIELD_CLASS}>
        <option value="everyone">Everyone</option>
        <option value="owners">Owners only</option>
      </select>
    </div>
  );
}

export function WaitingRoomCheckbox({ id, checked, disabled, onChange }: {
  id: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label htmlFor={id} className={`flex items-start gap-2 text-sm text-gray-300 ${disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}>
      <input id={id} aria-label="Waiting room" type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 accent-indigo-500" />
      <span>
        Waiting room
        <span className="block text-xs text-gray-400">New people wait until an owner accepts them.</span>
      </span>
    </label>
  );
}

type PasswordStatus = "idle" | "invalid" | "saving" | "saved" | "failed";

function PasswordForm({ socket, disabled, hasPassword }: { socket: AppSocket | null; disabled: boolean; hasPassword: boolean }) {
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<PasswordStatus>("idle");
  const [confirmingRemoval, setConfirmingRemoval] = useState(false);
  const keepRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!socket) return;
    const onResult = ({ ok }: { ok: boolean }) => {
      setStatus(ok ? "saved" : "failed");
      if (ok) setPassword("");
    };
    socket.on("room-password-result", onResult);
    return () => {
      socket.off("room-password-result", onResult);
    };
  }, [socket]);

  // A dropped event would otherwise leave the button disabled for good.
  useEffect(() => {
    if (status !== "saving") return;
    const timer = setTimeout(() => setStatus("failed"), REQUEST_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [status]);

  useEffect(() => {
    if (confirmingRemoval) keepRef.current?.focus();
  }, [confirmingRemoval]);

  function send(newPassword: string) {
    setStatus("saving");
    socket?.emit("change-room-password", { password: newPassword });
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    // Removing the password opens the room, so an empty field must never do that.
    if (!password) return;
    if (!isValidNewPassword(password)) {
      setStatus("invalid");
      return;
    }
    send(password);
  }

  function remove() {
    setConfirmingRemoval(false);
    send("");
  }

  return (
    <form onSubmit={submit}>
      <label htmlFor="room-new-password" className="block text-sm text-gray-300 mb-1">
        {hasPassword ? "Change room password" : "Set a room password"}
      </label>
      <div className="flex gap-2">
        <input
          id="room-new-password"
          aria-label={hasPassword ? "Change room password" : "Set a room password"}
          type="password"
          autoComplete="new-password"
          value={password}
          disabled={disabled}
          maxLength={MAX_PASSWORD_LENGTH}
          onChange={(e) => {
            setPassword(e.target.value);
            setStatus("idle");
          }}
          placeholder="New password"
          className={`flex-1 min-w-0 ${FIELD_CLASS}`}
        />
        <button
          type="submit"
          disabled={disabled || status === "saving" || !password}
          className="shrink-0 px-3 py-2 rounded-lg text-sm bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
        >
          {status === "saving" ? "Saving..." : "Save"}
        </button>
      </div>
      {status === "invalid" && <p role="alert" className="mt-1 text-xs text-red-400">Password must be at least {MIN_PASSWORD_LENGTH} characters.</p>}
      {status === "failed" && <p role="alert" className="mt-1 text-xs text-red-400">Couldn't change the password. Please try again.</p>}
      {status === "saved" && <p role="status" className="mt-1 text-xs text-green-400">Saved. People already in the room stay connected.</p>}
      {hasPassword && !confirmingRemoval && (
        <button
          type="button"
          disabled={disabled || status === "saving"}
          onClick={() => setConfirmingRemoval(true)}
          className="mt-2 text-xs text-red-400 hover:text-red-300 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
        >
          Remove password
        </button>
      )}
      {hasPassword && confirmingRemoval && (
        <div role="group" aria-label="Confirm removing the password" className="mt-2 flex flex-wrap items-center gap-2 text-xs text-gray-300">
          <span className="w-full">Remove the password? Anyone with the room's link will be able to join.</span>
          <button ref={keepRef} type="button" onClick={() => setConfirmingRemoval(false)} className="px-3 py-1.5 rounded-lg text-gray-300 hover:bg-gray-800 transition-colors cursor-pointer">
            Keep password
          </button>
          <button type="button" onClick={remove} className="px-3 py-1.5 rounded-lg font-medium bg-red-600 hover:bg-red-500 text-white transition-colors cursor-pointer">
            Remove
          </button>
        </div>
      )}
    </form>
  );
}

interface Props {
  socket: AppSocket | null;
  settings: RoomSettings;
  isOwner: boolean;
}

/** Shown to everyone, so people can see the rules, but only owners can change them. */
export default function RoomSettingsPanel({ socket, settings, isOwner }: Props) {
  const disabled = !isOwner;
  return (
    <section aria-labelledby="room-settings-title" className="mb-6 pb-6 border-b border-gray-800">
      <h3 id="room-settings-title" className="text-sm font-semibold text-white mb-1">Room</h3>
      {disabled && <p className="text-xs text-gray-400 mb-3">Only owners can change these settings.</p>}
      <div className="flex flex-col gap-3 mt-3">
        <PermissionSelect
          id="room-pin-permission"
          label="Who can pin messages"
          value={settings.pinPermission}
          disabled={disabled}
          onChange={(pinPermission) => socket?.emit("update-room-settings", { pinPermission })}
        />
        <PermissionSelect
          id="room-screen-permission"
          label="Who can share their screen"
          value={settings.screenSharePermission}
          disabled={disabled}
          onChange={(screenSharePermission) => socket?.emit("update-room-settings", { screenSharePermission })}
        />
        <WaitingRoomCheckbox
          id="room-waiting-room"
          checked={settings.waitingRoom}
          disabled={disabled}
          onChange={(waitingRoom) => socket?.emit("update-room-settings", { waitingRoom })}
        />
        <PasswordForm socket={socket} disabled={disabled} hasPassword={settings.hasPassword} />
      </div>
    </section>
  );
}

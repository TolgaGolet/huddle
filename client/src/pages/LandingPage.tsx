import { useState } from "react";
import { Link, useNavigate, useLocation } from "react-router-dom";
import { Users, Plus, Lock } from "lucide-react";
import { isValidNewPassword, MAX_NAME_LENGTH, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, type RoomPermission } from "../types";
import { PermissionSelect, WaitingRoomCheckbox } from "../components/RoomSettingsPanel";
import { setRoomEntry } from "../lib/roomEntry";
import { REQUEST_TIMEOUT_MS } from "../lib/requestTimeouts";
import { lookupRoom } from "../lib/roomLookup";

type Mode = "idle" | "join" | "create";

const INPUT_BASE = "px-4 py-3 rounded-lg bg-gray-800 border text-white placeholder-gray-400 focus:outline-none transition-colors";
const INPUT = `${INPUT_BASE} border-gray-700 focus:border-indigo-500`;

interface RedirectState {
  notice?: string;
  error?: string;
  roomId?: string;
  name?: string;
}

function NameInput({ value, onChange }: { value: string; onChange: (name: string) => void }) {
  return (
    <input
      aria-label="Your name"
      type="text"
      placeholder="Your name"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      maxLength={MAX_NAME_LENGTH}
      autoFocus
      className={`w-full ${INPUT}`}
    />
  );
}

function FormActions({ error, onBack, disabled, label }: { error: string; onBack: () => void; disabled: boolean; label: string }) {
  return (
    <>
      {error && <p role="alert" className="text-red-400 text-sm">{error}</p>}
      <div className="flex gap-3">
        <button
          type="button"
          onClick={onBack}
          className="flex-1 py-3 rounded-lg bg-gray-800 hover:bg-gray-700 border border-gray-700 transition-colors cursor-pointer"
        >
          Back
        </button>
        <button
          type="submit"
          disabled={disabled}
          className="flex-1 py-3 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors font-medium cursor-pointer"
        >
          {label}
        </button>
      </div>
    </>
  );
}

export default function LandingPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const rs = (location.state as RedirectState | null) ?? {};
  const [mode, setMode] = useState<Mode>(rs.error || rs.roomId ? "join" : "idle");
  const [name, setName] = useState(rs.name || "");
  const [roomId, setRoomId] = useState(rs.roomId || "");
  const [password, setPassword] = useState("");
  const [pinPermission, setPinPermission] = useState<RoomPermission>("everyone");
  const [screenSharePermission, setScreenSharePermission] = useState<RoomPermission>("everyone");
  const [messagePermission, setMessagePermission] = useState<RoomPermission>("everyone");
  const [waitingRoom, setWaitingRoom] = useState(false);
  const [error, setError] = useState(rs.error || "");
  const [loading, setLoading] = useState(false);
  const [roomNeedsPassword, setRoomNeedsPassword] = useState(false);

  function goToRoom(id: string, pw?: string, ownerToken?: string) {
    setRoomEntry({ roomId: id, password: pw, ownerToken });
    navigate(`/room/${id}`, { state: { name: name.trim() } });
  }

  async function handleJoin(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !roomId.trim()) return;
    setError("");
    setLoading(true);
    try {
      const data = await lookupRoom(roomId.trim());
      if ("error" in data) {
        setError(data.error);
        return;
      }
      if (!data.exists) {
        setError("Room not found. Check the ID and try again.");
        setRoomNeedsPassword(false);
        return;
      }
      if (data.hasPassword && !roomNeedsPassword) {
        setRoomNeedsPassword(true);
        return;
      }
      if (data.hasPassword && !password.trim()) {
        setError("This room requires a password.");
        return;
      }
      if (typeof data.participantCount === "number" && typeof data.maxParticipants === "number" && data.participantCount >= data.maxParticipants) {
        setError(`This room is full (${data.participantCount}/${data.maxParticipants} participants). Try again later or create a new room.`);
        setRoomNeedsPassword(false);
        return;
      }
      goToRoom(roomId.trim(), data.hasPassword ? password.trim() : undefined);
    } catch {
      setError("Failed to connect. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    if (!isValidNewPassword(password)) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters, or leave it empty for an open room.`);
      return;
    }
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          password: password.trim() || undefined,
          // Left out at their defaults.
          pinPermission: pinPermission === "owners" ? pinPermission : undefined,
          screenSharePermission: screenSharePermission === "owners" ? screenSharePermission : undefined,
          messagePermission: messagePermission === "owners" ? messagePermission : undefined,
          waitingRoom: waitingRoom || undefined,
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Failed to create room. Please try again.");
        return;
      }
      goToRoom(data.roomId, password.trim() || undefined, data.ownerToken);
    } catch {
      setError("Failed to create room. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  function resetMode() {
    setMode("idle");
    setError("");
    setPassword("");
    setRoomNeedsPassword(false);
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-950 px-4">
      <div className="w-full max-w-md">
        <h1 className="text-4xl font-bold text-center mb-2 text-white tracking-tight">
          Huddle
        </h1>
        <p className="text-gray-400 text-center mb-10 text-sm">
          Lightweight voice &amp; chat rooms
        </p>

        {rs.notice && (
          <p role="alert" className="mb-6 px-4 py-3 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-300 text-sm text-center">
            {rs.notice}
          </p>
        )}

        {mode === "idle" && (
          <div className="flex flex-col gap-4">
            <button
              onClick={() => setMode("join")}
              className="flex items-center justify-center gap-3 w-full py-4 rounded-xl bg-gray-800 hover:bg-gray-700 border border-gray-700 transition-colors text-lg font-medium cursor-pointer"
            >
              <Users size={22} />
              Join a Room
            </button>
            <button
              onClick={() => setMode("create")}
              className="flex items-center justify-center gap-3 w-full py-4 rounded-xl bg-indigo-600 hover:bg-indigo-500 transition-colors text-lg font-medium cursor-pointer"
            >
              <Plus size={22} />
              Create a Room
            </button>
          </div>
        )}

        {mode === "join" && (
          <form onSubmit={handleJoin} className="flex flex-col gap-4">
            <NameInput value={name} onChange={setName} />
            <input
              aria-label="Room ID"
              type="text"
              placeholder="Room ID"
              value={roomId}
              onChange={(e) => {
                setRoomId(e.target.value);
                setRoomNeedsPassword(false);
                setPassword("");
              }}
              className={`w-full ${INPUT}`}
            />
            {roomNeedsPassword && (
              <div className="flex items-center gap-2">
                <Lock size={16} className="text-amber-400 flex-shrink-0" />
                <input
                  aria-label="Room password"
                  type="password"
                  placeholder="Room password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  maxLength={MAX_PASSWORD_LENGTH}
                  autoFocus
                  className={`flex-1 ${INPUT_BASE} border-amber-600/50 focus:border-amber-500`}
                />
              </div>
            )}
            <FormActions
              error={error}
              onBack={resetMode}
              disabled={loading || !name.trim() || !roomId.trim() || (roomNeedsPassword && !password.trim())}
              label={loading ? "Joining..." : "Join"}
            />
          </form>
        )}

        {mode === "create" && (
          <form onSubmit={handleCreate} className="flex flex-col gap-4">
            <NameInput value={name} onChange={setName} />
            <div className="flex items-center gap-2">
              <Lock size={16} className="text-gray-400 flex-shrink-0" />
              <input
                aria-label="Password (optional)"
                type="password"
                placeholder="Password (optional)"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                maxLength={MAX_PASSWORD_LENGTH}
                className={`flex-1 ${INPUT}`}
              />
            </div>
            <PermissionSelect id="create-pin-permission" label="Who can pin messages" value={pinPermission} onChange={setPinPermission} />
            <PermissionSelect id="create-screen-permission" label="Who can share their screen" value={screenSharePermission} onChange={setScreenSharePermission} />
            <PermissionSelect id="create-message-permission" label="Who can send messages" value={messagePermission} onChange={setMessagePermission} />
            <WaitingRoomCheckbox id="create-waiting-room" checked={waitingRoom} onChange={setWaitingRoom} />
            <FormActions
              error={error}
              onBack={resetMode}
              disabled={loading || !name.trim()}
              label={loading ? "Creating..." : "Create Room"}
            />
          </form>
        )}

        <p className="mt-8 text-center text-xs">
          <Link to="/privacy" className="text-gray-400 hover:text-gray-200 underline transition-colors">Privacy</Link>
        </p>
      </div>
    </div>
  );
}

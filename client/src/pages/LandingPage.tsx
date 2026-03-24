import { useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { Users, Plus, Lock } from "lucide-react";

type Mode = "idle" | "join" | "create";

interface RedirectState {
  error?: string;
  roomId?: string;
  name?: string;
  password?: string;
}

export default function LandingPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const rs = (location.state as RedirectState | null) ?? {};
  const [mode, setMode] = useState<Mode>(rs.error ? "join" : "idle");
  const [name, setName] = useState(rs.name || "");
  const [roomId, setRoomId] = useState(rs.roomId || "");
  const [password, setPassword] = useState(rs.password || "");
  const [error, setError] = useState(rs.error || "");
  const [loading, setLoading] = useState(false);
  const [roomNeedsPassword, setRoomNeedsPassword] = useState(!!rs.password);

  function goToRoom(id: string, pw?: string) {
    navigate(`/room/${id}`, { state: { name: name.trim(), password: pw } });
  }

  async function handleJoin(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !roomId.trim()) return;
    setError("");
    setLoading(true);
    try {
      const res = await fetch(`/api/rooms/${roomId.trim()}`);
      const data = await res.json();
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
      goToRoom(roomId.trim(), data.hasPassword ? password : undefined);
    } catch {
      setError("Failed to connect. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: password.trim() || undefined }),
      });
      const data = await res.json();
      goToRoom(data.roomId, password.trim() || undefined);
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
            <input
              type="text"
              placeholder="Your name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              className="w-full px-4 py-3 rounded-lg bg-gray-800 border border-gray-700 text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500 transition-colors"
            />
            <input
              type="text"
              placeholder="Room ID"
              value={roomId}
              onChange={(e) => {
                setRoomId(e.target.value);
                setRoomNeedsPassword(false);
                setPassword("");
              }}
              className="w-full px-4 py-3 rounded-lg bg-gray-800 border border-gray-700 text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500 transition-colors"
            />
            {roomNeedsPassword && (
              <div className="flex items-center gap-2">
                <Lock size={16} className="text-amber-400 flex-shrink-0" />
                <input
                  type="password"
                  placeholder="Room password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoFocus
                  className="flex-1 px-4 py-3 rounded-lg bg-gray-800 border border-amber-600/50 text-white placeholder-gray-500 focus:outline-none focus:border-amber-500 transition-colors"
                />
              </div>
            )}
            {error && <p className="text-red-400 text-sm">{error}</p>}
            <div className="flex gap-3">
              <button
                type="button"
                onClick={resetMode}
                className="flex-1 py-3 rounded-lg bg-gray-800 hover:bg-gray-700 border border-gray-700 transition-colors cursor-pointer"
              >
                Back
              </button>
              <button
                type="submit"
                disabled={loading || !name.trim() || !roomId.trim() || (roomNeedsPassword && !password.trim())}
                className="flex-1 py-3 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors font-medium cursor-pointer"
              >
                {loading ? "Joining..." : "Join"}
              </button>
            </div>
          </form>
        )}

        {mode === "create" && (
          <form onSubmit={handleCreate} className="flex flex-col gap-4">
            <input
              type="text"
              placeholder="Your name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              className="w-full px-4 py-3 rounded-lg bg-gray-800 border border-gray-700 text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500 transition-colors"
            />
            <div className="flex items-center gap-2">
              <Lock size={16} className="text-gray-500 flex-shrink-0" />
              <input
                type="password"
                placeholder="Password (optional)"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="flex-1 px-4 py-3 rounded-lg bg-gray-800 border border-gray-700 text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500 transition-colors"
              />
            </div>
            {error && <p className="text-red-400 text-sm">{error}</p>}
            <div className="flex gap-3">
              <button
                type="button"
                onClick={resetMode}
                className="flex-1 py-3 rounded-lg bg-gray-800 hover:bg-gray-700 border border-gray-700 transition-colors cursor-pointer"
              >
                Back
              </button>
              <button
                type="submit"
                disabled={loading || !name.trim()}
                className="flex-1 py-3 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors font-medium cursor-pointer"
              >
                {loading ? "Creating..." : "Create Room"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

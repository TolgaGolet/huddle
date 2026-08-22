import { useState, useEffect, useCallback, useRef } from "react";
import { useParams, useLocation, useNavigate } from "react-router-dom";
import { Settings, LogOut, Copy, Check, AlertTriangle, Volume2 } from "lucide-react";
import { useSocket } from "../hooks/useSocket";
import { useWebRTC } from "../hooks/useWebRTC";
import { useMediaDevices } from "../hooks/useMediaDevices";
import { useCaptureAudio } from "../hooks/useCaptureAudio";
import { useVoiceActivity } from "../hooks/useVoiceActivity";
import ParticipantsList from "../components/ParticipantsList";
import ChatPanel from "../components/ChatPanel";
import VoiceControls from "../components/VoiceControls";
import SettingsPopup from "../components/SettingsPopup";
import ScreenViewer from "../components/ScreenViewer";
import type { Participant } from "../types";
import { MAX_PARTICIPANTS } from "../types";

export default function RoomPage() {
  const { roomId } = useParams<{ roomId: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const state = location.state as { name?: string; password?: string } | null;
  const name = state?.name || "Anonymous";
  const password = state?.password;

  const { socket, participants, chatHistory, connected, joinError, currentScreenSharer, joinRoom } = useSocket({
    roomId: roomId || "",
    name,
    password,
  });

  useEffect(() => {
    if (!state?.name) {
      navigate("/", { replace: true, state: { roomId } });
    }
  }, [state, navigate, roomId]);

  useEffect(() => {
    if (joinError) {
      navigate("/", {
        replace: true,
        state: { error: joinError, roomId, name, password },
      });
    }
  }, [joinError, navigate, roomId, name, password]);

  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [isMuted, setIsMuted] = useState(false);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [peerVolumes, setPeerVolumes] = useState<Map<string, number>>(new Map());
  const [copied, setCopied] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const [showLeaveConfirm, setShowLeaveConfirm] = useState(false);

  // Warn when trying to close the tab
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);

  const { audioInputs, selectedDeviceId, setSelectedDeviceId } = useMediaDevices();
  const { processStream, localAnalyser, needsAudioGesture, resumeAudio, cleanup } = useCaptureAudio();
  const rawStreamRef = useRef<MediaStream | null>(null);
  // Generation guard: only the newest acquisition may install its stream.
  // Stale getUserMedia completions (e.g. from a superseded device switch)
  // are stopped instead of overwriting the active capture.
  const acquireGenRef = useRef(0);

  /**
   * Build browser-compatible audio constraints that request native WebRTC
   * processing (echo cancellation, noise suppression, automatic gain control).
   *
   * These constraints are treated as hints: each browser may honor or ignore
   * them depending on platform/hardware. They are the same class of processing
   * used by Google Meet / Zoom and, unlike a page-owned AudioWorklet, continue
   * to run on the browser's real-time audio thread when the tab is backgrounded.
   *
   * `advanced`/`exact` are avoided for processing flags so a browser that does
   * not support a constraint still returns a usable track. Device selection
   * uses `exact` so switching devices is honored.
   */
  const buildAudioConstraints = useCallback((deviceId?: string): MediaTrackConstraints => {
    const constraints: MediaTrackConstraints = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    };
    if (deviceId) {
      constraints.deviceId = { exact: deviceId };
    }
    return constraints;
  }, []);

  const acquireMic = useCallback(
    async (deviceId?: string) => {
      const gen = ++acquireGenRef.current;
      try {
        const raw = await navigator.mediaDevices.getUserMedia({
          audio: buildAudioConstraints(deviceId),
        });
        // A newer acquisition superseded this one; discard the stale stream.
        if (gen !== acquireGenRef.current) {
          raw.getTracks().forEach((t) => t.stop());
          return;
        }
        // Stop the previously active raw tracks before replacing, now that
        // the new stream is confirmed good.
        if (rawStreamRef.current && rawStreamRef.current !== raw) {
          rawStreamRef.current.getTracks().forEach((t) => t.stop());
        }
        rawStreamRef.current = raw;

        // Surface the browser-reported capture settings in development so
        // noise-suppression capability can be distinguished from request.
        const env = (import.meta as ImportMeta & { env?: { DEV?: boolean } }).env;
        if (env?.DEV) {
          const track = raw.getAudioTracks()[0];
          const settings = track?.getSettings();
          const supported = navigator.mediaDevices.getSupportedConstraints?.() ?? {};
          console.debug("[huddle:capture]", {
            deviceId: settings?.deviceId,
            echoCancellation: settings?.echoCancellation,
            noiseSuppression: settings?.noiseSuppression,
            autoGainControl: settings?.autoGainControl,
            sampleRate: settings?.sampleRate,
            channelCount: settings?.channelCount,
            supportedEchoCancellation: supported.echoCancellation,
            supportedNoiseSuppression: supported.noiseSuppression,
            supportedAutoGainControl: supported.autoGainControl,
          });
        }

        const processed = await processStream(raw);
        if (gen !== acquireGenRef.current) return;
        setLocalStream(processed);
      } catch (err) {
        console.error("Failed to acquire microphone:", err);
      }
    },
    [processStream, buildAudioConstraints],
  );

  useEffect(() => {
    acquireMic();
    return () => {
      rawStreamRef.current?.getTracks().forEach((t) => t.stop());
      cleanup();
    };
  }, []);

  const handleDeviceChange = useCallback(
    (deviceId: string) => {
      setSelectedDeviceId(deviceId);
      // acquireMic stops the old raw tracks only after the new stream is
      // confirmed, avoiding a window with no active capture.
      acquireMic(deviceId);
    },
    [acquireMic, setSelectedDeviceId],
  );

  const handleScreenShareStopped = useCallback(() => {
    setIsScreenSharing(false);
  }, []);

  // Coordinate the ready-then-join boundary: emit `join-room` only after the
  // WebRTC signaling listeners are installed, so the server's `room-joined`,
  // `offer`, and `ice-candidate` events cannot arrive before we handle them.
  // This also fires after a Socket.IO reconnect (WebRTC resets its listeners
  // on the new socket), re-issuing `join-room` to rejoin the room cleanly.
  const handleSignalingReady = useCallback(() => {
    joinRoom();
  }, [joinRoom]);

  const { remoteAnalysers, screenStreams, startScreenShare, stopScreenShare, setRemoteVolume } =
    useWebRTC({ socket, localStream, onScreenShareStopped: handleScreenShareStopped, onSignalingReady: handleSignalingReady });

  const speaking = useVoiceActivity(remoteAnalysers, localAnalyser, socket?.id);

  const handleToggleMute = useCallback(() => {
    if (!localStream) return;
    const audioTrack = localStream.getAudioTracks()[0];
    if (audioTrack) {
      audioTrack.enabled = isMuted;
      setIsMuted(!isMuted);
      socket?.emit("mute-toggle", { isMuted: !isMuted });
    }
  }, [localStream, isMuted, socket]);

  const someoneElseSharing = !!currentScreenSharer && currentScreenSharer !== socket?.id;

  const handleToggleScreenShare = useCallback(async () => {
    if (isScreenSharing) {
      stopScreenShare();
      setIsScreenSharing(false);
    } else {
      if (someoneElseSharing) return;
      const ok = await startScreenShare();
      setIsScreenSharing(ok);
    }
  }, [isScreenSharing, startScreenShare, stopScreenShare, someoneElseSharing]);

  const handleSetPeerVolume = useCallback(
    (peerId: string, volume: number) => {
      setPeerVolumes((prev) => new Map(prev).set(peerId, volume));
      setRemoteVolume(peerId, volume);
    },
    [setRemoteVolume],
  );

  const handleCopyRoomId = useCallback(() => {
    if (!roomId) return;
    navigator.clipboard.writeText(roomId);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [roomId]);

  const handleCopyLink = useCallback(() => {
    navigator.clipboard.writeText(globalThis.location.href);
    setLinkCopied(true);
    setTimeout(() => setLinkCopied(false), 2000);
  }, []);

  const localParticipant: Participant = {
    id: socket?.id || "local",
    name,
    isMuted,
  };

  const allParticipants = [localParticipant, ...participants];

  const firstScreenStream = screenStreams.entries().next().value;
  const screenSharerName =
    firstScreenStream && allParticipants.find((p) => p.id === firstScreenStream[0])?.name;

  if (!roomId || !state?.name) {
    return null;
  }

  return (
    <div className="h-screen flex flex-col bg-gray-950 text-gray-100">
      {/* Audio enable banner: shown when the browser blocked AudioContext
          resume / autoplay (notably Safari/iOS after backgrounding). The
          action must be triggered by a user gesture. */}
      {needsAudioGesture && (
        <div className="flex items-center justify-between gap-3 px-4 py-2 bg-amber-500/10 border-b border-amber-500/30 text-amber-300 text-xs">
          <span className="flex items-center gap-2">
            <Volume2 size={14} />
            Audio was paused by your browser. Click to re-enable voice.
          </span>
          <button
            onClick={resumeAudio}
            className="px-3 py-1 rounded-md bg-amber-500/20 hover:bg-amber-500/30 text-amber-200 transition-colors cursor-pointer"
          >
            Enable audio
          </button>
        </div>
      )}
      {/* Top bar */}
      <header className="flex items-center justify-between px-4 py-2 border-b border-gray-800 bg-gray-900/50 shrink-0">
        <div className="flex items-center gap-3">
          <h1 className="text-sm font-bold tracking-tight">Huddle</h1>
          <div className="h-4 w-px bg-gray-700" />
          <button
            onClick={handleCopyRoomId}
            className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-200 transition-colors cursor-pointer"
            title="Copy room ID"
          >
            <span className="font-mono">{roomId}</span>
            {copied ? <Check size={12} className="text-green-400" /> : <Copy size={12} />}
          </button>
          <button
            onClick={handleCopyLink}
            className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-200 transition-colors cursor-pointer"
            title="Copy room link"
          >
            <span>Copy Link</span>
            {linkCopied ? <Check size={12} className="text-green-400" /> : <Copy size={12} />}
          </button>
          {!connected && (
            <span className="text-xs text-amber-400 animate-pulse">Connecting...</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowSettings(true)}
            className="p-2 rounded-lg text-gray-400 hover:text-gray-200 hover:bg-gray-800 transition-colors cursor-pointer"
            title="Settings"
          >
            <Settings size={18} />
          </button>
          <button
            onClick={() => setShowLeaveConfirm(true)}
            className="p-2 rounded-lg text-gray-400 hover:text-red-400 hover:bg-gray-800 transition-colors cursor-pointer"
            title="Leave room"
          >
            <LogOut size={18} />
          </button>
        </div>
      </header>

      {/* Main content */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left panel: participants + voice controls */}
        <aside className="w-64 flex flex-col border-r border-gray-800 bg-gray-900/30 shrink-0">
          <ParticipantsList
            participants={allParticipants}
            localId={socket?.id || "local"}
            speaking={speaking}
            peerVolumes={peerVolumes}
            onSetPeerVolume={handleSetPeerVolume}
            maxParticipants={MAX_PARTICIPANTS}
          />
          <VoiceControls
            isMuted={isMuted}
            isScreenSharing={isScreenSharing}
            screenShareDisabled={someoneElseSharing}
            onToggleMute={handleToggleMute}
            onToggleScreenShare={handleToggleScreenShare}
          />
        </aside>

        {/* Right panel: screen share (theater) + chat */}
        <main className="flex-1 flex overflow-hidden min-w-0">
          {firstScreenStream && (
            <ScreenViewer
              stream={firstScreenStream[1]}
              sharerName={screenSharerName || "Someone"}
            />
          )}
          <div
            className={
              firstScreenStream
                ? "w-80 shrink-0 flex flex-col border-l border-gray-800"
                : "flex-1 flex flex-col"
            }
          >
            <ChatPanel socket={socket} chatHistory={chatHistory} localId={socket?.id || "local"} />
          </div>
        </main>
      </div>

      {/* Settings popup */}
      {showSettings && (
        <SettingsPopup
          onClose={() => setShowSettings(false)}
          audioInputs={audioInputs}
          selectedDeviceId={selectedDeviceId}
          onDeviceChange={handleDeviceChange}
        />
      )}

      {/* Leave room confirmation */}
      {showLeaveConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="w-full max-w-sm mx-4 rounded-xl bg-gray-900 border border-gray-700 shadow-2xl p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 rounded-full bg-red-500/10 text-red-400">
                <AlertTriangle size={22} />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-gray-100">Leave room?</h3>
                <p className="text-sm text-gray-400 mt-0.5">
                  You will be disconnected from the call.
                </p>
              </div>
            </div>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setShowLeaveConfirm(false)}
                className="px-4 py-2 rounded-lg text-sm text-gray-300 hover:bg-gray-800 transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={() => navigate("/")}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-red-600 hover:bg-red-500 text-white transition-colors cursor-pointer"
              >
                Leave
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

import { useState, useEffect, useCallback, useRef } from "react";
import { useParams, useLocation, useNavigate } from "react-router-dom";
import { Settings, LogOut, Copy, Check } from "lucide-react";
import { useSocket } from "../hooks/useSocket";
import { useWebRTC } from "../hooks/useWebRTC";
import { useMediaDevices } from "../hooks/useMediaDevices";
import { useNoiseSuppression } from "../hooks/useNoiseSuppression";
import { useVoiceActivity } from "../hooks/useVoiceActivity";
import ParticipantsList from "../components/ParticipantsList";
import ChatPanel from "../components/ChatPanel";
import VoiceControls from "../components/VoiceControls";
import SettingsPopup from "../components/SettingsPopup";
import ScreenViewer from "../components/ScreenViewer";
import type { Participant } from "../types";

export default function RoomPage() {
  const { roomId } = useParams<{ roomId: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const state = location.state as { name?: string; password?: string } | null;
  const name = state?.name || "Anonymous";
  const password = state?.password;

  const { socket, participants, chatHistory, connected, joinError, currentScreenSharer } = useSocket({
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
  const [inputGain, setInputGain] = useState(1);
  const [peerVolumes, setPeerVolumes] = useState<Map<string, number>>(new Map());
  const [copied, setCopied] = useState(false);

  const { audioInputs, selectedDeviceId, setSelectedDeviceId } = useMediaDevices();
  const { processStream, setInputGain: setEngineGain, localAnalyser, cleanup } = useNoiseSuppression();
  const rawStreamRef = useRef<MediaStream | null>(null);

  const acquireMic = useCallback(
    async (deviceId?: string) => {
      try {
        const audioConstraints: MediaTrackConstraints = {
          echoCancellation: true,
          noiseSuppression: false,
          autoGainControl: false,
        };
        if (deviceId) {
          audioConstraints.deviceId = { exact: deviceId };
        }
        const raw = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
        rawStreamRef.current = raw;
        const processed = await processStream(raw);
        setLocalStream(processed);
      } catch (err) {
        console.error("Failed to acquire microphone:", err);
      }
    },
    [processStream],
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
      rawStreamRef.current?.getTracks().forEach((t) => t.stop());
      acquireMic(deviceId);
    },
    [acquireMic, setSelectedDeviceId],
  );

  const handleInputGainChange = useCallback(
    (value: number) => {
      setInputGain(value);
      setEngineGain(value);
    },
    [setEngineGain],
  );

  const handleScreenShareStopped = useCallback(() => {
    setIsScreenSharing(false);
  }, []);

  const { remoteAnalysers, screenStreams, startScreenShare, stopScreenShare, setRemoteVolume } =
    useWebRTC({ socket, localStream, onScreenShareStopped: handleScreenShareStopped });

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
            onClick={() => navigate("/")}
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
            localInputGain={inputGain}
            onLocalInputGainChange={handleInputGainChange}
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
          inputGain={inputGain}
          onInputGainChange={handleInputGainChange}
        />
      )}
    </div>
  );
}

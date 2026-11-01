import { useState, useEffect, useCallback, useMemo, useRef, type ReactNode } from "react";
import { useParams, useLocation, useNavigate } from "react-router-dom";
import { Settings, LogOut, Copy, Check, AlertTriangle, Volume2, ChevronDown, Link, MicOff, X, type LucideIcon } from "lucide-react";
import { useCopyFeedback } from "../hooks/useCopyFeedback";
import { useSocket } from "../hooks/useSocket";
import { useWebRTC } from "../hooks/useWebRTC";
import { useMediaDevices } from "../hooks/useMediaDevices";
import { useCaptureAudio } from "../hooks/useCaptureAudio";
import { useVoiceActivity } from "../hooks/useVoiceActivity";
import { useAudioSettings } from "../hooks/useAudioSettings";
import { useTransmissionGate } from "../hooks/useTransmissionGate";
import Dialog from "../components/Dialog";
import ParticipantsList from "../components/ParticipantsList";
import ChatPanel from "../components/ChatPanel";
import VoiceControls from "../components/VoiceControls";
import SettingsPopup from "../components/SettingsPopup";
import ScreenViewer from "../components/ScreenViewer";
import type { Participant } from "../types";
import { MAX_PARTICIPANTS } from "../types";
import { errorName, huddleLog } from "../lib/huddleLog";
import { ImageSessionContext } from "../lib/imageSessionContext";
import { resyncCallStateWhenLimited } from "../lib/callStateResync";
import { classifyMicError, micErrorAfterTrackEnded, micErrorMessage, type MicError } from "../lib/micError";
import { applyNoiseSuppression, stopStreams } from "../lib/micStreams";
import { playMuteSound, playUnmuteSound } from "../lib/notificationSounds";

/**
 * A shared link arrives with no name, so it redirects to the join form. RoomCall
 * only mounts once there is one: its hooks open the socket and ask for the mic.
 */
export default function RoomPage() {
  const { roomId } = useParams<{ roomId: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const state = location.state as { name?: string; password?: string } | null;
  const name = state?.name;

  useEffect(() => {
    if (!name) navigate("/", { replace: true, state: { roomId } });
  }, [name, navigate, roomId]);

  if (!roomId || !name) return null;
  return <RoomCall roomId={roomId} name={name} password={state?.password} />;
}

const BANNER_ACTION = "px-3 py-1 rounded-md bg-amber-500/20 hover:bg-amber-500/30 text-amber-200 transition-colors cursor-pointer";

function RoomBanner({ icon: Icon, role, message, children }: { icon: LucideIcon; role?: "alert"; message: string; children: ReactNode }) {
  return (
    <div role={role} className="flex items-center justify-between gap-3 px-4 py-2 bg-amber-500/10 border-b border-amber-500/30 text-amber-300 text-xs">
      <span className="flex items-center gap-2">
        <Icon size={14} className="shrink-0" />
        {message}
      </span>
      <span className="flex items-center gap-2 shrink-0">{children}</span>
    </div>
  );
}

function RoomCall({ roomId, name, password }: { roomId: string; name: string; password?: string }) {
  const navigate = useNavigate();

  const [isMuted, setIsMuted] = useState(false);
  const [micError, setMicError] = useState<MicError | null>(null);
  const micUnavailable = !!micError && micError !== "switch-failed";
  // What the room is told: without a mic the user can't be heard, whatever their
  // own mute choice (which is kept, and applies again once the mic is back).
  const announcedMuted = isMuted || micUnavailable;

  const { socket, userId, httpToken, imageSession, participants, chatHistory, pinnedMessageId, connected, joinError, currentScreenSharer, typingUsers, notifyTyping, joinRoom } = useSocket({
    roomId,
    name,
    password,
    isMuted: announcedMuted,
  });

  useEffect(() => {
    if (joinError) {
      navigate("/", {
        replace: true,
        state: { error: joinError, roomId, name, password },
      });
    }
  }, [joinError, navigate, roomId, name, password]);

  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [micRetrying, setMicRetrying] = useState(false);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [peerVolumes, setPeerVolumes] = useState<Map<string, number>>(new Map());
  const { status: roomIdCopy, copy: copyRoomId } = useCopyFeedback();
  const { status: linkCopy, copy: copyLink } = useCopyFeedback();
  const [showLeaveConfirm, setShowLeaveConfirm] = useState(false);
  const [participantsOpen, setParticipantsOpen] = useState(false);

  // Warn when trying to close the tab
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);

  const { audioInputs, selectedDeviceId, setSelectedDeviceId } = useMediaDevices();
  const {
    settings,
    setNoiseCancellationEnabled,
    setTransmissionThreshold,
    setManualThresholdDb,
  } = useAudioSettings();
  const { processStream, localAnalyser, needsAudioGesture, resumeAudio, cleanup } = useCaptureAudio();
  const rawStreamRef = useRef<MediaStream | null>(null);
  // The outbound clone is independent of the raw track and must be stopped
  // separately; refs keep acquireMic and the unmount cleanup off stale state.
  const outboundStreamRef = useRef<MediaStream | null>(null);
  const isMutedRef = useRef(isMuted);
  isMutedRef.current = isMuted;
  const announcedMutedRef = useRef(announcedMuted);
  announcedMutedRef.current = announcedMuted;
  // The device Retry asks for: the one that failed, unless it has gone away.
  const micRetryDeviceRef = useRef<string | undefined>(undefined);
  const isScreenSharingRef = useRef(isScreenSharing);
  isScreenSharingRef.current = isScreenSharing;

  useEffect(() => {
    if (!socket) return;
    return resyncCallStateWhenLimited(socket, () => ({
      isMuted: announcedMutedRef.current,
      isScreenSharing: isScreenSharingRef.current,
    }));
  }, [socket]);

  // Only while connected: Socket.IO would flush this before the rejoin, where
  // the server ignores it. The join itself carries the current state.
  useEffect(() => {
    if (socket?.connected) socket.emit("mute-toggle", { isMuted: announcedMuted });
  }, [socket, announcedMuted]);

  // Generation guard: only the newest acquisition may install its stream.
  // Stale getUserMedia completions (e.g. from a superseded device switch)
  // are stopped instead of overwriting the active capture.
  const acquireGenRef = useRef(0);

  // Check if noise suppression is supported as a controllable constraint
  const isNoiseCancellationSupported = Boolean(
    typeof navigator !== "undefined" &&
      navigator.mediaDevices?.getSupportedConstraints?.()?.noiseSuppression,
  );

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
  const buildAudioConstraints = useCallback(
    (deviceId?: string, noiseCancellation = settings.noiseCancellationEnabled): MediaTrackConstraints => {
      const constraints: MediaTrackConstraints = {
        echoCancellation: true,
        noiseSuppression: noiseCancellation,
        autoGainControl: true,
      };
      if (deviceId) {
        constraints.deviceId = { exact: deviceId };
      }
      return constraints;
    },
    [settings.noiseCancellationEnabled],
  );

  /** Resolves true only if this acquisition became the active capture. */
  const acquireMic = useCallback(
    async (deviceId?: string, noiseCancellation?: boolean): Promise<boolean> => {
      const gen = ++acquireGenRef.current;
      const startedAt = performance.now();
      try {
        const raw = await navigator.mediaDevices.getUserMedia({
          audio: buildAudioConstraints(deviceId, noiseCancellation),
        });
        huddleLog("capture", {
          event: "getUserMedia-resolved",
          gen,
          elapsedMs: Math.round(performance.now() - startedAt),
          deviceId: deviceId ?? "default",
        });
        // A newer acquisition superseded this one; discard the stale stream.
        if (gen !== acquireGenRef.current) {
          stopStreams(raw);
          return false;
        }
        // Stop the previously active raw tracks before replacing, now that
        // the new stream is confirmed good.
        if (rawStreamRef.current && rawStreamRef.current !== raw) {
          stopStreams(rawStreamRef.current);
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
        if (gen !== acquireGenRef.current) return false;

        // Clone the native capture track specifically for the outbound WebRTC stream.
        // This decouples outbound transmission gating (track.enabled) from the localAnalyser
        // tap. Setting outboundTrack.enabled = false silences transmission without silencing
        // the raw analyser input, allowing the gate to reopen when speech resumes.
        const rawAudioTrack = raw.getAudioTracks()[0];
        const outboundTrack = rawAudioTrack ? rawAudioTrack.clone() : null;
        const outboundStream = outboundTrack ? new MediaStream([outboundTrack]) : processed;

        const outboundAudioTrack = outboundStream.getAudioTracks()[0];
        if (outboundAudioTrack) {
          outboundAudioTrack.enabled = !isMutedRef.current;
        }

        // Clean up previously active outbound tracks
        if (outboundStreamRef.current && outboundStreamRef.current !== raw) {
          stopStreams(outboundStreamRef.current);
        }
        outboundStreamRef.current = outboundStream;

        setLocalStream(outboundStream);
        setMicError(null);
        micRetryDeviceRef.current = undefined;
        // Set here, not when the user picks, so the picker only ever shows the
        // device in use, including after a fallback to the default one.
        const activeDeviceId = rawAudioTrack?.getSettings().deviceId;
        if (activeDeviceId) setSelectedDeviceId(activeDeviceId);
        // Unplugged, or revoked by the browser. stop() doesn't fire this, so our
        // own device switches and leaving don't reach it.
        rawAudioTrack?.addEventListener("ended", () => {
          if (rawStreamRef.current !== raw) return;
          huddleLog("capture", { event: "track-ended" });
          void acquireMicRef.current?.().then((recovered) => {
            if (!recovered && rawStreamRef.current === raw) setMicError(micErrorAfterTrackEnded);
          });
        });
        huddleLog("capture", {
          event: "localStream-committed",
          gen,
          elapsedMs: Math.round(performance.now() - startedAt),
        });
        return true;
      } catch (err) {
        huddleLog("capture", { event: "getUserMedia-failed", error: errorName(err) });
        if (gen !== acquireGenRef.current) return false;
        const error = classifyMicError(err);
        const stillCapturing = outboundStreamRef.current?.getAudioTracks()[0]?.readyState === "live";
        setMicError(stillCapturing ? "switch-failed" : error);
        micRetryDeviceRef.current = error === "not-found" ? undefined : deviceId;
        return false;
      }
    },
    [processStream, buildAudioConstraints, setSelectedDeviceId],
  );
  const acquireMicRef = useRef(acquireMic);
  acquireMicRef.current = acquireMic;

  const retryMic = useCallback(async () => {
    if (micRetrying) return;
    setMicRetrying(true);
    await acquireMic(micRetryDeviceRef.current);
    setMicRetrying(false);
  }, [micRetrying, acquireMic]);

  useEffect(() => {
    acquireMic();
    return () => {
      // Invalidate any in-flight acquisition so a late getUserMedia resolve
      // stops its own stream instead of reopening the mic after leaving.
      // eslint-disable-next-line react-hooks/exhaustive-deps -- a counter that must bump its live value.
      acquireGenRef.current++;
      stopStreams(rawStreamRef.current, outboundStreamRef.current);
      rawStreamRef.current = null;
      outboundStreamRef.current = null;
      cleanup();
    };
    // Mount-only: acquireMic changes with the noise-cancellation setting, and
    // re-running this effect would tear down the live mic and audio engine.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleDeviceChange = useCallback(
    (deviceId: string) => {
      // acquireMic stops the old raw tracks only after the new stream is
      // confirmed, avoiding a window with no active capture.
      void acquireMic(deviceId);
    },
    [acquireMic],
  );

  const handleNoiseCancellationChange = useCallback(
    async (enabled: boolean) => {
      setNoiseCancellationEnabled(enabled);

      // Peers receive the outbound clone, and constraints apply per track.
      const tracks = [rawStreamRef.current, outboundStreamRef.current].flatMap((stream) => stream?.getAudioTracks() ?? []);
      try {
        if (await applyNoiseSuppression(tracks, enabled)) {
          huddleLog("capture", {
            event: "applyConstraints-noiseSuppression-success",
            enabled,
          });
          return;
        }
        huddleLog("capture", { event: "applyConstraints-not-applied-fallback-reacquire" });
      } catch (err) {
        huddleLog("capture", {
          event: "applyConstraints-failed-fallback-reacquire",
          error: errorName(err),
        });
      }

      // Fallback: reacquire mic with new constraints. Chromium accepts the call
      // above without changing anything, and hands a new capture of an open device
      // that device's old processing, so the current capture must close first.
      stopStreams(rawStreamRef.current, outboundStreamRef.current);
      void acquireMic(selectedDeviceId, enabled);
    },
    [setNoiseCancellationEnabled, acquireMic, selectedDeviceId],
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

  const { remoteAnalysers, screenStreams, peerConnectionStates, remotePlaybackBlocked, resumeRemotePlayback, startScreenShare, stopScreenShare, setRemoteVolume } =
    useWebRTC({ socket, localStream, onScreenShareStopped: handleScreenShareStopped, onSignalingReady: handleSignalingReady });

  // Steam-chat style voice transmission threshold gate:
  // Suppresses transmitting slight noises, fan hums, mouse clicks when below threshold.
  const { isTransmitting, gateStateRef } = useTransmissionGate({
    localAnalyser,
    outboundStream: localStream,
    threshold: settings.transmissionThreshold,
    manualThresholdDb: settings.manualThresholdDb,
    isMuted,
  });

  const rawSpeaking = useVoiceActivity(remoteAnalysers, localAnalyser, socket?.id);

  // Speaking indicator for local participant should illuminate ONLY if voice is actively
  // being transmitted to other users (unmuted AND passing transmission threshold).
  const localId = socket?.id || "local";
  const localIsAudible = isTransmitting && !isMuted;
  const speaking = useMemo(
    () => new Set([...rawSpeaking].filter((id) => id !== localId || localIsAudible)),
    [rawSpeaking, localId, localIsAudible],
  );

  const handleToggleMute = useCallback(() => {
    setIsMuted((prev) => {
      const nextMuted = !prev;
      if (nextMuted) playMuteSound();
      else playUnmuteSound();
      return nextMuted;
    });
  }, []);

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
    void copyRoomId(roomId);
  }, [roomId, copyRoomId]);

  const handleCopyLink = useCallback(() => {
    void copyLink(globalThis.location.href);
  }, [copyLink]);

  const localParticipant: Participant = {
    id: localId,
    userId: userId ?? "",
    name,
    isMuted: announcedMuted,
  };

  const allParticipants = [localParticipant, ...participants];

  // "Connecting…" indicator: a remote participant is connecting while their
  // peer connection is not yet `connected` (new/connecting/failed — `failed`
  // is included because recovery is automatic and users should know audio is
  // not flowing yet). The local participant shows it while ANY remote peer is
  // still connecting, so the user understands others can't hear them yet.
  const connecting = new Set<string>();
  for (const [peerId, state] of peerConnectionStates) {
    if (state !== "connected" && state !== "closed") connecting.add(peerId);
  }
  const anyRemoteConnecting = connecting.size > 0;
  if (anyRemoteConnecting) connecting.add(localId);

  const speakingNames = allParticipants.filter((p) => speaking.has(p.id) && !p.isMuted).map((p) => p.name);

  const firstScreenStream = screenStreams.entries().next().value;
  const screenSharerName =
    firstScreenStream && allParticipants.find((p) => p.id === firstScreenStream[0])?.name;

  const linkLabel = linkCopy === "failed" ? "Couldn't copy room link" : "Copy room link";

  const voiceControlsProps = {
    isMuted: announcedMuted,
    micUnavailable,
    isScreenSharing,
    screenShareDisabled: someoneElseSharing,
    onToggleMute: micUnavailable ? retryMic : handleToggleMute,
    onToggleScreenShare: handleToggleScreenShare,
  };

  return (
    <div className="h-dvh flex flex-col bg-gray-950 text-gray-100">
      {micError && (
        <RoomBanner icon={MicOff} role="alert" message={micErrorMessage(micError)}>
          <button onClick={retryMic} disabled={micRetrying} className={`${BANNER_ACTION} disabled:opacity-60 disabled:cursor-wait`}>
            {micRetrying ? "Retrying..." : "Retry"}
          </button>
          {micError === "switch-failed" && (
            <button
              onClick={() => setMicError(null)}
              className="touch-target p-1 rounded-md hover:bg-amber-500/30 text-amber-200 transition-colors cursor-pointer"
              title="Dismiss"
              aria-label="Dismiss"
            >
              <X size={14} />
            </button>
          )}
        </RoomBanner>
      )}
      {/* Audio enable banner: shown when the browser blocked AudioContext
          resume / autoplay (notably Safari/iOS after backgrounding). The
          action must be triggered by a user gesture. */}
      {needsAudioGesture && (
        <RoomBanner icon={Volume2} message="Audio was paused by your browser. Click to re-enable voice.">
          <button onClick={resumeAudio} className={BANNER_ACTION}>
            Enable audio
          </button>
        </RoomBanner>
      )}
      {/* Remote playback blocked: the AudioContext that plays OTHER users'
          voices is suspended (autoplay block / OS interruption). Without this
          banner there was no recovery path — the user heard nobody. */}
      {remotePlaybackBlocked && (
        <RoomBanner icon={Volume2} message="Incoming audio was paused by your browser. Click to hear others.">
          <button onClick={resumeRemotePlayback} className={BANNER_ACTION}>
            Enable audio
          </button>
        </RoomBanner>
      )}
      {/* Top bar */}
      <header className="flex items-center justify-between gap-2 px-4 py-2 border-b border-gray-800 bg-gray-900/50 shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <h1 className="sr-only sm:not-sr-only text-sm font-bold tracking-tight">Huddle</h1>
          <div className="hidden sm:block h-4 w-px bg-gray-700" />
          <button
            onClick={handleCopyRoomId}
            className="touch-target flex items-center gap-1.5 min-w-0 text-xs text-gray-400 hover:text-gray-200 transition-colors cursor-pointer"
            title={roomIdCopy === "failed" ? "Couldn't copy room ID" : "Copy room ID"}
          >
            <span className="font-mono truncate">{roomId}</span>
            {roomIdCopy === "copied" && <Check size={12} className="shrink-0 text-green-400" />}
            {roomIdCopy === "failed" && <X size={12} className="shrink-0 text-red-400" />}
            {roomIdCopy === "idle" && <Copy size={12} className="shrink-0" />}
          </button>
          <button
            onClick={handleCopyLink}
            className="touch-target flex items-center gap-1.5 shrink-0 text-xs text-gray-400 hover:text-gray-200 transition-colors cursor-pointer"
            title={linkLabel}
            aria-label={linkLabel}
          >
            <span className="hidden sm:inline">Copy Link</span>
            {linkCopy === "copied" && <Check size={12} className="text-green-400" />}
            {linkCopy === "failed" && <X size={12} className="text-red-400" />}
            {linkCopy === "idle" && <Link size={12} className="sm:hidden" />}
            {linkCopy === "idle" && <Copy size={12} className="hidden sm:block" />}
          </button>
          {!connected && (
            <span className="truncate text-xs text-amber-400 animate-pulse">Connecting...</span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => setShowSettings(true)}
            className="p-2 rounded-lg text-gray-400 hover:text-gray-200 hover:bg-gray-800 transition-colors cursor-pointer"
            title="Settings"
            aria-label="Settings"
          >
            <Settings size={18} />
          </button>
          <button
            onClick={() => setShowLeaveConfirm(true)}
            className="p-2 rounded-lg text-gray-400 hover:text-red-400 hover:bg-gray-800 transition-colors cursor-pointer"
            title="Leave room"
            aria-label="Leave room"
          >
            <LogOut size={18} />
          </button>
        </div>
      </header>

      {/* Main content */}
      <div className="flex flex-col md:flex-row flex-1 min-h-0 overflow-hidden">
        {/* Participants + voice controls: a collapsible top strip below md, a sidebar from md.
            VoiceControls renders twice so the tab order matches each layout; the hidden copy is display:none. */}
        <aside className="w-full md:w-64 flex flex-col border-b md:border-b-0 md:border-r border-gray-800 bg-gray-900/30 shrink-0 md:min-h-0">
          <div className="md:hidden flex items-center gap-2 px-3 py-1.5">
            <button
              type="button"
              onClick={() => setParticipantsOpen((open) => !open)}
              aria-expanded={participantsOpen}
              aria-controls="room-participants"
              className="flex flex-1 items-center gap-1.5 min-w-0 min-h-10 rounded-lg text-left text-xs text-gray-300 cursor-pointer"
            >
              <ChevronDown size={14} className={`shrink-0 transition-transform ${participantsOpen ? "rotate-180" : ""}`} />
              <span className="shrink-0">Participants {allParticipants.length}/{MAX_PARTICIPANTS}</span>
              {speakingNames.length > 0 && (
                <span className="truncate text-green-400">{speakingNames.join(", ")}</span>
              )}
            </button>
            <VoiceControls compact {...voiceControlsProps} />
          </div>
          <div
            id="room-participants"
            className={`${participantsOpen ? "flex" : "hidden"} md:flex flex-col flex-1 min-h-0 max-h-[40dvh] md:max-h-none overflow-hidden border-t md:border-t-0 border-gray-800`}
          >
            <ParticipantsList
              participants={allParticipants}
              localId={localId}
              speaking={speaking}
              peerVolumes={peerVolumes}
              onSetPeerVolume={handleSetPeerVolume}
              maxParticipants={MAX_PARTICIPANTS}
              connecting={connecting}
            />
          </div>
          <div className="hidden md:block">
            <VoiceControls {...voiceControlsProps} />
          </div>
        </aside>

        {/* Screen share (theater) + chat: stacked below md, side by side from md */}
        <main className="flex-1 flex flex-col md:flex-row overflow-hidden min-w-0 min-h-0">
          {firstScreenStream && (
            <ScreenViewer
              stream={firstScreenStream[1]}
              sharerName={screenSharerName || "Someone"}
            />
          )}
          <div
            className={
              firstScreenStream
                ? "flex-1 min-h-0 md:flex-none md:w-80 md:shrink-0 flex flex-col border-t md:border-t-0 md:border-l border-gray-800"
                : "flex-1 min-h-0 flex flex-col"
            }
          >
            <ImageSessionContext value={imageSession}>
              <ChatPanel
                socket={socket}
                httpToken={httpToken}
                chatHistory={chatHistory}
                pinnedMessageId={pinnedMessageId}
                localUserId={userId ?? ""}
                roomId={roomId}
                typingUsers={typingUsers}
                notifyTyping={notifyTyping}
              />
            </ImageSessionContext>
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
          noiseCancellationEnabled={settings.noiseCancellationEnabled}
          onNoiseCancellationChange={handleNoiseCancellationChange}
          isNoiseCancellationSupported={isNoiseCancellationSupported}
          transmissionThreshold={settings.transmissionThreshold}
          onTransmissionThresholdChange={setTransmissionThreshold}
          manualThresholdDb={settings.manualThresholdDb}
          onManualThresholdDbChange={setManualThresholdDb}
          localAnalyser={localAnalyser}
          isMuted={isMuted}
          isTransmitting={isTransmitting}
          gateStateRef={gateStateRef}
        />
      )}

      {/* Leave room confirmation */}
      {showLeaveConfirm && (
        <Dialog
          onClose={() => setShowLeaveConfirm(false)}
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
        </Dialog>
      )}
    </div>
  );
}

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useParams, useLocation, useNavigate } from "react-router-dom";
import { ChevronDown } from "lucide-react";
import { useSocket } from "../hooks/useSocket";
import { useWebRTC } from "../hooks/useWebRTC";
import { useMediaDevices } from "../hooks/useMediaDevices";
import { useCaptureAudio } from "../hooks/useCaptureAudio";
import { useMicrophone } from "../hooks/useMicrophone";
import { useVoiceActivityReport } from "../hooks/useVoiceActivityReport";
import { useVoiceActivity } from "../hooks/useVoiceActivity";
import { useWatchParty } from "../hooks/useWatchParty";
import { useAudioSettings } from "../hooks/useAudioSettings";
import { useTransmissionGate } from "../hooks/useTransmissionGate";
import LeaveRoomDialog from "../components/LeaveRoomDialog";
import ParticipantsList from "../components/ParticipantsList";
import RoomBanners from "../components/RoomBanners";
import RoomChat from "../components/RoomChat";
import RoomSettingsPanel from "../components/RoomSettingsPanel";
import RoomHeader from "../components/RoomHeader";
import WaitingScreen from "../components/WaitingScreen";
import VoiceControls from "../components/VoiceControls";
import SettingsPopup from "../components/SettingsPopup";
import ScreenViewer from "../components/ScreenViewer";
import WatchPartyPanel from "../components/WatchPartyPanel";
import { WatchPartyContext } from "../lib/watchPartyContext";
import type { Participant } from "../types";
import { MAX_PARTICIPANTS, permits } from "../types";
import { resyncCallStateWhenLimited } from "../lib/callStateResync";
import { isNoiseCancellationSupported } from "../lib/micCapture";
import { playMuteSound, playUnmuteSound } from "../lib/notificationSounds";

/**
 * A shared link arrives with no name, so it redirects to the join form. RoomCall
 * only mounts once there is one: its hooks open the socket and ask for the mic.
 */
export default function RoomPage() {
  const { roomId } = useParams<{ roomId: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const state = location.state as { name?: string } | null;
  const name = state?.name;

  useEffect(() => {
    if (!name) navigate("/", { replace: true, state: { roomId } });
  }, [name, navigate, roomId]);

  if (!roomId || !name) return null;
  return <RoomCall roomId={roomId} name={name} />;
}

function RoomCall({ roomId, name }: { roomId: string; name: string }) {
  const navigate = useNavigate();

  const [isMuted, setIsMuted] = useState(false);
  const { audioInputs, selectedDeviceId, setSelectedDeviceId } = useMediaDevices();
  const {
    settings,
    setNoiseCancellationEnabled,
    setTransmissionThreshold,
    setManualThresholdDb,
  } = useAudioSettings();
  const { processStream, localAnalyser, needsAudioGesture, resumeAudio, cleanup } = useCaptureAudio();
  const {
    stream: localStream,
    error: micError,
    retrying: micRetrying,
    retry: retryMic,
    dismissError: dismissMicError,
    setDevice,
    setNoiseCancellation,
  } = useMicrophone({
    isMuted,
    noiseCancellation: settings.noiseCancellationEnabled,
    processStream,
    onDevice: setSelectedDeviceId,
    onRelease: cleanup,
  });
  const micUnavailable = !!micError && micError !== "switch-failed";
  // What the room is told: without a mic the user can't be heard, whatever their
  // own mute choice (which is kept, and applies again once the mic is back).
  const announcedMuted = isMuted || micUnavailable;

  const { socket, userId, httpToken, imageSession, participants, connected, exit, currentScreenSharer, closing, settings: roomSettings, isWaiting, waitingList, admitRefusedId, joinRoom } = useSocket({
    roomId,
    name,
    isMuted: announcedMuted,
  });

  useEffect(() => {
    if (!exit) return;
    // Only a failed join returns to the form with its details filled in.
    navigate("/", { replace: true, state: "error" in exit ? { ...exit, roomId, name } : exit });
  }, [exit, navigate, roomId, name]);

  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [peerVolumes, setPeerVolumes] = useState<Map<string, number>>(new Map());
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

  const announcedMutedRef = useRef(announcedMuted);
  announcedMutedRef.current = announcedMuted;
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

  const handleNoiseCancellationChange = useCallback(
    async (enabled: boolean) => {
      setNoiseCancellationEnabled(enabled);
      await setNoiseCancellation(enabled, selectedDeviceId);
    },
    [setNoiseCancellationEnabled, setNoiseCancellation, selectedDeviceId],
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

  // Before useWebRTC, whose effect sends the join: room-joined carries the party.
  const watch = useWatchParty(socket, roomId);

  const { remoteAnalysers, screenStreams, peerConnectionStates, remotePlaybackBlocked, resumeRemotePlayback, startScreenShare, stopScreenShare, setRemoteVolume } =
    useWebRTC({ socket, localStream, micSettled: localStream !== null || micError !== null, onScreenShareStopped: handleScreenShareStopped, onSignalingReady: handleSignalingReady });

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
    // Not in a state updater: StrictMode runs those twice.
    if (isMuted) playUnmuteSound();
    else playMuteSound();
    setIsMuted(!isMuted);
  }, [isMuted]);

  const someoneElseSharing = !!currentScreenSharer && currentScreenSharer !== socket?.id;

  const ownerIds = useMemo(() => new Set(roomSettings?.ownerIds), [roomSettings]);
  const isOwner = !!userId && ownerIds.has(userId);
  const canPin = permits(roomSettings, "pinPermission", isOwner);
  const canShareScreen = permits(roomSettings, "screenSharePermission", isOwner);
  const canSendMessages = permits(roomSettings, "messagePermission", isOwner);

  // The server stops a share the settings no longer allow; the capture ends here.
  useEffect(() => {
    if (isScreenSharing && !canShareScreen) {
      stopScreenShare();
      setIsScreenSharing(false);
    }
  }, [isScreenSharing, canShareScreen, stopScreenShare]);

  const handleSetOwner = useCallback((targetUserId: string, makeOwner: boolean) => {
    socket?.emit("set-owner", { userId: targetUserId, isOwner: makeOwner });
  }, [socket]);
  const handleKick = useCallback((targetUserId: string) => {
    socket?.emit("kick-participant", { userId: targetUserId });
  }, [socket]);
  const handleAdmit = useCallback((id: string) => {
    socket?.emit("admit-waiting", { id });
  }, [socket]);

  const handleToggleScreenShare = useCallback(async () => {
    if (isScreenSharing) {
      stopScreenShare();
      setIsScreenSharing(false);
    } else {
      if (someoneElseSharing || !canShareScreen) return;
      const ok = await startScreenShare();
      setIsScreenSharing(ok);
    }
  }, [isScreenSharing, startScreenShare, stopScreenShare, someoneElseSharing, canShareScreen]);

  const handleSetPeerVolume = useCallback((userId: string, volume: number) => {
    setPeerVolumes((prev) => new Map(prev).set(userId, volume));
  }, []);

  // Choices are by userId, so one survives a reconnect under a new socket id.
  useEffect(() => {
    for (const p of participants) {
      const volume = peerVolumes.get(p.userId);
      if (volume !== undefined) setRemoteVolume(p.id, volume);
    }
  }, [participants, peerVolumes, setRemoteVolume]);

  // Memoized so the memoized WatchPartyPanel skips the re-renders `speaking` causes.
  const allParticipants = useMemo(() => {
    const localParticipant: Participant = { id: localId, userId: userId ?? "", name, isMuted: announcedMuted };
    return [localParticipant, ...participants];
  }, [localId, userId, name, announcedMuted, participants]);

  // A context, so a party change re-renders only the invite cards, not the memoized chat.
  const { party: watchParty, isMember: isWatchMember, join: joinWatchParty } = watch;
  const watchContext = useMemo(
    () => ({ party: watchParty, isMember: isWatchMember, join: joinWatchParty }),
    [watchParty, isWatchMember, joinWatchParty],
  );

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

  useVoiceActivityReport(socket, speaking.has(localId));

  const speakingNames = allParticipants.filter((p) => speaking.has(p.id) && !p.isMuted).map((p) => p.name);

  const firstScreenStream = screenStreams.entries().next().value;
  const screenSharerName =
    firstScreenStream && allParticipants.find((p) => p.id === firstScreenStream[0])?.name;

  // The player is for the party's members; everyone else sees its invite in the chat.
  const watchSnapshot = watch.isMember ? watch.snapshot : null;

  const voiceControlsProps = {
    isMuted: announcedMuted,
    micUnavailable,
    isScreenSharing,
    screenShareDisabled: someoneElseSharing || !canShareScreen,
    screenShareDisabledLabel: canShareScreen ? undefined : "Only owners can share their screen",
    onToggleMute: micUnavailable ? retryMic : handleToggleMute,
    onToggleScreenShare: handleToggleScreenShare,
  };

  return (
    <>
    {isWaiting && <WaitingScreen onLeave={() => navigate("/")} />}
    {/* Hidden, not removed: RoomChat must already be listening for the room-joined
        that ends the wait, as that carries the chat history. */}
    <div className={isWaiting ? "hidden" : "h-dvh flex flex-col bg-gray-950 text-gray-100"}>
      <RoomBanners
        waitingList={isOwner ? waitingList : undefined}
        admitRefusedId={admitRefusedId}
        onAdmit={handleAdmit}
        closing={closing}
        micError={micError}
        micRetrying={micRetrying}
        onRetryMic={retryMic}
        onDismissMicError={dismissMicError}
        needsAudioGesture={needsAudioGesture}
        onResumeAudio={resumeAudio}
        remotePlaybackBlocked={remotePlaybackBlocked}
        onResumeRemotePlayback={resumeRemotePlayback}
      />
      <RoomHeader
        roomId={roomId}
        connected={connected}
        onOpenSettings={() => setShowSettings(true)}
        onLeave={() => setShowLeaveConfirm(true)}
      />

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
              ownerIds={ownerIds}
              creatorId={roomSettings?.creatorId}
              canModerate={isOwner}
              onSetOwner={handleSetOwner}
              onKick={handleKick}
            />
          </div>
          <div className="hidden md:block">
            <VoiceControls {...voiceControlsProps} />
          </div>
        </aside>

        {/* Screen share (theater) + chat: stacked below md, side by side from md */}
        <main className="flex-1 flex flex-col md:flex-row overflow-hidden min-w-0 min-h-0">
          {(firstScreenStream || watchSnapshot) && (
            <div className="flex flex-col min-w-0 shrink-0 md:shrink md:flex-1 md:min-h-0">
              {watchSnapshot && (
                <WatchPartyPanel
                  socket={socket}
                  snapshot={watchSnapshot}
                  localUserId={userId ?? ""}
                  participants={allParticipants}
                  onLeave={watch.leave}
                  onChangeVideo={watch.changeVideo}
                />
              )}
              {firstScreenStream && (
                <ScreenViewer
                  stream={firstScreenStream[1]}
                  sharerName={screenSharerName || "Someone"}
                />
              )}
            </div>
          )}
          <div
            className={
              firstScreenStream || watchSnapshot
                ? "flex-1 min-h-0 md:flex-none md:w-80 md:shrink-0 flex flex-col border-t md:border-t-0 md:border-l border-gray-800"
                : "flex-1 min-h-0 flex flex-col"
            }
          >
            <WatchPartyContext value={watchContext}>
              <RoomChat
                socket={socket}
                httpToken={httpToken}
                imageSession={imageSession}
                localUserId={userId ?? ""}
                roomId={roomId}
                canPin={canPin}
                isOwner={isOwner}
                canSendMessages={canSendMessages}
              />
            </WatchPartyContext>
          </div>
        </main>
      </div>

      {/* Settings popup */}
      {showSettings && (
        <SettingsPopup
          onClose={() => setShowSettings(false)}
          roomPanel={roomSettings && <RoomSettingsPanel socket={socket} settings={roomSettings} isOwner={isOwner} />}
          audioInputs={audioInputs}
          selectedDeviceId={selectedDeviceId}
          onDeviceChange={setDevice}
          noiseCancellationEnabled={settings.noiseCancellationEnabled}
          onNoiseCancellationChange={handleNoiseCancellationChange}
          isNoiseCancellationSupported={isNoiseCancellationSupported()}
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

      {showLeaveConfirm && (
        <LeaveRoomDialog onCancel={() => setShowLeaveConfirm(false)} onLeave={() => navigate("/")} />
      )}
    </div>
    </>
  );
}

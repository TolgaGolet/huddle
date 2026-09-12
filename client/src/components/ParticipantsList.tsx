import { useState, useCallback } from "react";
import type { Participant } from "../types";
import ParticipantCard from "./ParticipantCard";
import ParticipantContextMenu from "./ParticipantContextMenu";

interface Props {
  participants: Participant[];
  localId: string;
  speaking: Set<string>;
  peerVolumes: Map<string, number>;
  onSetPeerVolume: (peerId: string, volume: number) => void;
  maxParticipants?: number;
  /** Per-peer WebRTC connection state; used to show "Connecting…" badges. */
  peerStates?: Map<string, RTCPeerConnectionState>;
}

interface ContextMenuState {
  peerId: string;
  name: string;
  isLocal: boolean;
  x: number;
  y: number;
}

export default function ParticipantsList({
  participants,
  localId,
  speaking,
  peerVolumes,
  onSetPeerVolume,
  maxParticipants,
  peerStates,
}: Props) {
  const [ctx, setCtx] = useState<ContextMenuState | null>(null);

  const openMenu = useCallback(
    (e: React.MouseEvent, p: Participant) => {
      e.preventDefault();
      setCtx({ peerId: p.id, name: p.name, isLocal: p.id === localId, x: e.clientX, y: e.clientY });
    },
    [localId],
  );

  // The local participant has no software volume control anymore (native
  // unity-gain capture is transmitted directly). Only remote participants
  // expose a playback-volume slider.
  const ctxVolume = ctx && !ctx.isLocal ? (peerVolumes.get(ctx.peerId) ?? 1) : 1;

  const ctxOnChange = ctx && !ctx.isLocal
    ? (v: number) => onSetPeerVolume(ctx.peerId, v)
    : undefined;

  const isFull = typeof maxParticipants === "number" && participants.length >= maxParticipants;
  const countLabel = typeof maxParticipants === "number"
    ? `${participants.length}/${maxParticipants}`
    : `${participants.length}`;

  return (
    <div className="flex-1 overflow-y-auto py-2 px-1">
      <h3 className={`text-[11px] uppercase tracking-wider font-semibold px-3 mb-1 ${isFull ? "text-amber-400" : "text-gray-500"}`}>
        Participants — {countLabel}{isFull ? " (full)" : ""}
      </h3>
      {participants.map((p) => (
        <ParticipantCard
          key={p.id}
          participant={p}
          isSpeaking={speaking.has(p.id)}
          isLocal={p.id === localId}
          connectionState={p.id === localId ? "connected" : peerStates?.get(p.id)}
          onContextMenu={(e) => openMenu(e, p)}
          onMenuClick={(e) => openMenu(e, p)}
        />
      ))}
      {ctx && ctxOnChange && (
        <ParticipantContextMenu
          x={ctx.x}
          y={ctx.y}
          name={ctx.isLocal ? `${ctx.name} (you)` : ctx.name}
          volume={ctxVolume}
          onVolumeChange={ctxOnChange}
          onClose={() => setCtx(null)}
        />
      )}
    </div>
  );
}

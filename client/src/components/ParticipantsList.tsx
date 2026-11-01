import { useState, useCallback } from "react";
import type { Participant } from "../types";
import ParticipantCard from "./ParticipantCard";
import ParticipantContextMenu from "./ParticipantContextMenu";

interface Props {
  participants: Participant[];
  localId: string;
  speaking: Set<string>;
  /** Playback volume by userId, which survives a peer's reconnect. */
  peerVolumes: Map<string, number>;
  onSetPeerVolume: (userId: string, volume: number) => void;
  maxParticipants?: number;
  /** Participant ids whose peer connection is still being established. */
  connecting?: Set<string>;
}

interface ContextMenuState {
  userId: string;
  name: string;
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
  connecting,
}: Props) {
  const [ctx, setCtx] = useState<ContextMenuState | null>(null);

  const openMenu = useCallback((e: React.MouseEvent, p: Participant) => {
    e.preventDefault();
    setCtx({ userId: p.userId, name: p.name, x: e.clientX, y: e.clientY });
  }, []);

  const isFull = typeof maxParticipants === "number" && participants.length >= maxParticipants;
  const countLabel = typeof maxParticipants === "number"
    ? `${participants.length}/${maxParticipants}`
    : `${participants.length}`;

  return (
    <div className="flex-1 overflow-y-auto py-2 px-1">
      <h3 className={`text-[11px] uppercase tracking-wider font-semibold px-3 mb-1 ${isFull ? "text-amber-400" : "text-gray-400"}`}>
        Participants — {countLabel}{isFull ? " (full)" : ""}
      </h3>
      {participants.map((p) => {
        // The local participant has no software volume control (native
        // unity-gain capture is transmitted directly), so no menu either.
        const isLocal = p.id === localId;
        const onOpenMenu = isLocal ? undefined : (e: React.MouseEvent) => openMenu(e, p);
        return (
          <ParticipantCard
            key={p.id}
            participant={p}
            isSpeaking={speaking.has(p.id)}
            isLocal={isLocal}
            isConnecting={connecting?.has(p.id)}
            onOpenMenu={onOpenMenu}
          />
        );
      })}
      {ctx && (
        <ParticipantContextMenu
          x={ctx.x}
          y={ctx.y}
          name={ctx.name}
          volume={peerVolumes.get(ctx.userId) ?? 1}
          onVolumeChange={(v) => onSetPeerVolume(ctx.userId, v)}
          onClose={() => setCtx(null)}
        />
      )}
    </div>
  );
}

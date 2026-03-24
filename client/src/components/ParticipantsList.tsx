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
  localInputGain: number;
  onLocalInputGainChange: (value: number) => void;
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
  localInputGain,
  onLocalInputGainChange,
}: Props) {
  const [ctx, setCtx] = useState<ContextMenuState | null>(null);

  const openMenu = useCallback(
    (e: React.MouseEvent, p: Participant) => {
      e.preventDefault();
      setCtx({ peerId: p.id, name: p.name, isLocal: p.id === localId, x: e.clientX, y: e.clientY });
    },
    [localId],
  );

  const ctxVolume = ctx
    ? ctx.isLocal
      ? localInputGain
      : (peerVolumes.get(ctx.peerId) ?? 1)
    : 1;

  const ctxOnChange = ctx
    ? ctx.isLocal
      ? onLocalInputGainChange
      : (v: number) => onSetPeerVolume(ctx.peerId, v)
    : undefined;

  return (
    <div className="flex-1 overflow-y-auto py-2 px-1">
      <h3 className="text-[11px] uppercase tracking-wider text-gray-500 font-semibold px-3 mb-1">
        Participants — {participants.length}
      </h3>
      {participants.map((p) => (
        <ParticipantCard
          key={p.id}
          participant={p}
          isSpeaking={speaking.has(p.id)}
          isLocal={p.id === localId}
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

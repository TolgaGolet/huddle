import type { MicTelemetry } from "../types";
import { dbToPercentage } from "../lib/audioLevels";

interface MicLevelPreviewProps {
  readonly telemetry: MicTelemetry;
}

function getStatusDisplay(
  hasInput: boolean,
  isMuted: boolean,
  isTransmitting: boolean,
  thresholdDb: number | null,
): { text: string; color: string } {
  if (!hasInput) return { text: "No microphone input detected", color: "text-zinc-500" };
  if (isMuted) return { text: "Microphone is muted", color: "text-amber-400" };
  if (isTransmitting) return { text: "Voice transmitting", color: "text-emerald-400 font-medium" };
  if (thresholdDb !== null) return { text: "Noise suppressed (below threshold)", color: "text-blue-400" };
  return { text: "Ambient / quiet", color: "text-zinc-400" };
}

export function MicLevelPreview({ telemetry }: MicLevelPreviewProps) {
  const { levelDb, noiseFloorDb, thresholdDb, isTransmitting, isMuted, hasInput } = telemetry;

  const levelPct = hasInput && !isMuted ? dbToPercentage(levelDb) : 0;
  const noiseFloorPct = hasInput && !isMuted ? dbToPercentage(noiseFloorDb) : 0;
  const thresholdPct = thresholdDb !== null ? dbToPercentage(thresholdDb) : null;

  const status = getStatusDisplay(hasInput, isMuted, isTransmitting, thresholdDb);

  return (
    <div className="flex flex-col gap-2 p-3 bg-zinc-900/60 rounded-xl border border-zinc-800/80">
      <div className="flex items-center justify-between text-xs">
        <span className="text-zinc-300 font-medium">Mic Input & Activity</span>
        <span className={status.color}>{status.text}</span>
      </div>

      {/* Meter Bar */}
      <div
        className="relative h-2.5 w-full bg-zinc-800 rounded-full overflow-hidden"
        role="meter"
        aria-label="Microphone input level"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={levelPct}
        aria-valuetext={`${levelPct}% ${status.text}`}
      >
        {/* Estimated noise floor background marker */}
        {hasInput && !isMuted && noiseFloorPct > 0 && (
          <div
            className="absolute top-0 bottom-0 left-0 bg-zinc-700/60 transition-all duration-150 pointer-events-none"
            style={{ width: `${noiseFloorPct}%` }}
            title={`Ambient noise floor: ~${Math.round(noiseFloorDb)} dB`}
          />
        )}

        {/* Dynamic level bar */}
        <div
          className={`h-full transition-all duration-75 rounded-full ${
            isTransmitting ? "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]" : "bg-zinc-500"
          }`}
          style={{ width: `${levelPct}%` }}
        />

        {/* Threshold position marker */}
        {thresholdPct !== null && (
          <div
            className="absolute top-0 bottom-0 w-0.5 bg-yellow-400 shadow-[0_0_4px_rgba(250,204,21,0.8)] z-10 pointer-events-none"
            style={{ left: `${thresholdPct}%` }}
            title={`Voice transmission threshold: ${thresholdDb} dB`}
          />
        )}
      </div>

      {/* Footer stats */}
      <div className="flex items-center justify-between text-[11px] text-zinc-500">
        <span>Level: {hasInput && !isMuted ? `${Math.round(levelDb)} dB` : "--"}</span>
        {thresholdDb !== null ? (
          <span className="text-yellow-500/80">Threshold: {thresholdDb} dB</span>
        ) : (
          <span>Threshold: Off</span>
        )}
        <span>Noise floor: {hasInput && !isMuted ? `${Math.round(noiseFloorDb)} dB` : "--"}</span>
      </div>
    </div>
  );
}

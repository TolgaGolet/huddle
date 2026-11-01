import { useEffect, useRef, useState, type RefObject } from "react";
import type { MicTelemetry, VoiceTransmissionThreshold } from "../types";
import {
  calculateAnalyserLevel,
  getThresholdDb,
  stepNoiseFloor,
  type GateState,
} from "../lib/audioLevels";

const TELEMETRY_INTERVAL_MS = 80;

/**
 * Data for the settings meter. Whether voice is transmitting comes from the
 * real gate (useTransmissionGate), never a second calculation, so the meter
 * always matches what peers hear.
 */
export function useMicTelemetry(
  localAnalyser: AnalyserNode | null,
  isMuted: boolean,
  threshold: VoiceTransmissionThreshold,
  manualThresholdDb: number,
  isTransmitting: boolean,
  gateStateRef: RefObject<GateState>,
): MicTelemetry {
  const [levels, setLevels] = useState({ levelDb: -100, noiseFloorDb: -60 });

  // The gate doesn't measure while the threshold is off, but the meter still
  // shows the ambient floor.
  const ownNoiseFloorRef = useRef<number | null>(null);
  const bufferRef = useRef<Uint8Array | null>(null);

  useEffect(() => {
    if (!localAnalyser || isMuted) {
      setLevels((prev) => ({ ...prev, levelDb: -100 }));
      return;
    }

    const interval = setInterval(() => {
      const binCount = localAnalyser.fftSize;
      if (!bufferRef.current || bufferRef.current.length < binCount) {
        bufferRef.current = new Uint8Array(binCount);
      }

      const { levelDb } = calculateAnalyserLevel(localAnalyser, bufferRef.current);

      const ownNoiseFloorDb = stepNoiseFloor(ownNoiseFloorRef.current, levelDb);
      ownNoiseFloorRef.current = ownNoiseFloorDb;

      setLevels({
        levelDb,
        noiseFloorDb: threshold === "off" ? ownNoiseFloorDb : gateStateRef.current.noiseFloorDb ?? ownNoiseFloorDb,
      });
    }, TELEMETRY_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [localAnalyser, isMuted, threshold, gateStateRef]);

  const hasInput = Boolean(localAnalyser);
  return {
    ...levels,
    thresholdDb: getThresholdDb(threshold, manualThresholdDb)?.openDb ?? null,
    isMuted,
    hasInput,
    isTransmitting: hasInput && isTransmitting,
  };
}

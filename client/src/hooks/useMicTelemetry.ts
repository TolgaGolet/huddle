import { useEffect, useRef, useState } from "react";
import type { MicTelemetry, VoiceTransmissionThreshold } from "../types";
import {
  calculateAnalyserLevel,
  getThresholdDb,
  NOISE_FLOOR_MAX_DB,
  NOISE_FLOOR_MIN_DB,
  RELEASE_MS,
  updateAdaptiveNoiseFloor,
} from "../lib/audioLevels";

const TELEMETRY_INTERVAL_MS = 80;

export function useMicTelemetry(
  localAnalyser: AnalyserNode | null,
  isMuted: boolean,
  threshold: VoiceTransmissionThreshold,
  manualThresholdDb = -36,
  active: boolean,
): MicTelemetry {
  const [telemetry, setTelemetry] = useState<MicTelemetry>({
    levelDb: -100,
    noiseFloorDb: -60,
    thresholdDb: threshold === "off" ? null : getThresholdDb(threshold, manualThresholdDb)?.openDb ?? null,
    isTransmitting: false,
    isMuted,
    hasInput: false,
  });

  const noiseFloorRef = useRef<number>(-60);
  const openSinceRef = useRef<number>(0);
  const bufferRef = useRef<Uint8Array | null>(null);

  useEffect(() => {
    const limits = getThresholdDb(threshold, manualThresholdDb);
    const configuredThresholdDb = limits?.openDb ?? null;

    // If not active or no analyser, update state and don't poll
    if (!active || !localAnalyser) {
      setTelemetry((prev) => ({
        ...prev,
        levelDb: -100,
        thresholdDb: configuredThresholdDb,
        isTransmitting: false,
        isMuted,
        hasInput: Boolean(localAnalyser),
      }));
      return;
    }

    if (isMuted) {
      setTelemetry((prev) => ({
        ...prev,
        levelDb: -100,
        thresholdDb: configuredThresholdDb,
        isTransmitting: false,
        isMuted: true,
        hasInput: true,
      }));
      return;
    }

    const interval = setInterval(() => {
      const binCount = localAnalyser.fftSize;
      if (!bufferRef.current || bufferRef.current.length < binCount) {
        bufferRef.current = new Uint8Array(binCount);
      }

      const { levelDb } = calculateAnalyserLevel(localAnalyser, bufferRef.current);
      const now = performance.now();

      // Initialize floor if at baseline
      if (noiseFloorRef.current === -60 && levelDb > -100) {
        noiseFloorRef.current = Math.max(Math.min(levelDb, NOISE_FLOOR_MAX_DB), NOISE_FLOOR_MIN_DB);
      } else {
        noiseFloorRef.current = updateAdaptiveNoiseFloor(noiseFloorRef.current, levelDb);
      }

      let isTransmitting = false;

      if (threshold === "off") {
        isTransmitting = true;
      } else if (limits) {
        const openThr = Math.max(limits.openDb, noiseFloorRef.current + 8);
        const closeThr = Math.max(limits.closeDb, noiseFloorRef.current + 4);

        if (openSinceRef.current > 0) {
          const sinceOpen = now - openSinceRef.current;
          if (sinceOpen < RELEASE_MS || levelDb >= closeThr) {
            isTransmitting = true;
            if (levelDb >= closeThr) {
              openSinceRef.current = now;
            }
          } else {
            openSinceRef.current = 0;
          }
        } else if (levelDb >= openThr) {
          openSinceRef.current = now;
          isTransmitting = true;
        }
      }

      setTelemetry({
        levelDb,
        noiseFloorDb: noiseFloorRef.current,
        thresholdDb: configuredThresholdDb,
        isTransmitting,
        isMuted: false,
        hasInput: true,
      });
    }, TELEMETRY_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [localAnalyser, isMuted, threshold, manualThresholdDb, active]);

  return telemetry;
}

import { useEffect, useRef, useState } from "react";
import type { VoiceTransmissionThreshold } from "../types";
import {
  calculateAnalyserLevel,
  getThresholdDb,
  NOISE_FLOOR_MAX_DB,
  NOISE_FLOOR_MIN_DB,
  RELEASE_MS,
  updateAdaptiveNoiseFloor,
} from "../lib/audioLevels";
import { createWorkerInterval } from "../lib/workerTimer";

/**
 * Cadence for checking mic transmission level.
 * 25ms provides snappy speech onset detection to avoid clipping initial consonants.
 */
const GATE_POLL_INTERVAL_MS = 25;

/** Attack requirement: consecutive samples above threshold before gate opens */
const REQUIRED_ATTACK_SAMPLES = 2; // ~50ms of sustained energy

interface UseTransmissionGateOptions {
  localAnalyser: AnalyserNode | null;
  outboundStream: MediaStream | null;
  threshold: VoiceTransmissionThreshold;
  manualThresholdDb?: number;
  isMuted: boolean;
}

/**
 * Manages per-user Voice Transmission Threshold (similar to Steam chat).
 *
 * When enabled ('low', 'medium', 'high', 'very-high', 'manual'), the gate
 * suppresses transmission below the threshold when the user is not speaking
 * (e.g. slight mouse clicks, fan noise, breath).
 * When 'off', transmission is constantly open whenever the user is unmuted.
 *
 * It gates the outgoing audio track (the cloned outbound track in outboundStream)
 * by setting `track.enabled = !isMuted && gateOpen`.
 * Because localAnalyser is attached to the separate raw microphone track, disabling
 * the outbound track does NOT silence the analyser.
 *
 * Uses a Web Worker clock so it runs with unthrottled 25ms precision even when
 * the browser is minimized or running in an inactive background tab.
 */
export function useTransmissionGate({
  localAnalyser,
  outboundStream,
  threshold,
  manualThresholdDb = -36,
  isMuted,
}: UseTransmissionGateOptions): boolean {
  // If threshold is 'off', gate is always considered open
  const [gateOpen, setGateOpen] = useState<boolean>(true);

  const consecutiveHighRef = useRef<number>(0);
  const openSinceRef = useRef<number>(0);
  const noiseFloorRef = useRef<number>(-60);
  const bufferRef = useRef<Uint8Array | null>(null);
  // Tracks the previous isMuted value so the unmute transition can re-arm
  // the gate (close it once) — otherwise the fail-open state from the muted
  // period persists until the first speech/pause cycle.
  const prevMutedRef = useRef<boolean>(isMuted);

  // Synchronize outbound track.enabled based on manual mute and gate status
  useEffect(() => {
    if (!outboundStream) return;
    const track = outboundStream.getAudioTracks()[0];
    if (!track) return;

    const isThresholdActive = threshold !== "off";
    const shouldEnableTrack = !isMuted && (!isThresholdActive || gateOpen);

    if (track.enabled !== shouldEnableTrack) {
      track.enabled = shouldEnableTrack;
    }
  }, [outboundStream, isMuted, threshold, gateOpen]);

  useEffect(() => {
    if (threshold === "off") {
      setGateOpen(true);
      return;
    }

    if (!localAnalyser) {
      // No analyser (mic not ready / AudioContext suspended): we CANNOT
      // measure the level, so the gate must fail OPEN — a closed gate here
      // would silently disable the outbound track and cause one-way audio
      // whenever the analyser's AudioContext is autoplay-blocked.
      setGateOpen(true);
      consecutiveHighRef.current = 0;
      openSinceRef.current = 0;
      return;
    }

    // A non-null analyser whose AudioContext is suspended/interrupted produces
    // only silence. Treating that as "below threshold" would keep the gate
    // closed and mute an otherwise healthy outbound track (one-way audio). If
    // we cannot actually measure, fail OPEN just like the missing-analyser case.
    const analyserCtxState = (localAnalyser.context as BaseAudioContext | undefined)?.state;
    if (analyserCtxState && analyserCtxState !== "running") {
      setGateOpen(true);
      consecutiveHighRef.current = 0;
      openSinceRef.current = 0;
      return;
    }

    if (isMuted) {
      // While muted the gate is irrelevant (track is disabled by mute), but
      // on the unmute TRANSITION re-arm it closed so transmission resumes
      // under the configured threshold instead of staying open from the
      // muted period.
      if (!prevMutedRef.current) {
        setGateOpen(false);
        consecutiveHighRef.current = 0;
        openSinceRef.current = 0;
      }
      prevMutedRef.current = true;
      return;
    }
    prevMutedRef.current = false;

    const limits = getThresholdDb(threshold, manualThresholdDb);
    if (!limits) {
      setGateOpen(true);
      return;
    }

    const { openDb, closeDb } = limits;

    const onTick = () => {
      // Re-check every tick: the AudioContext can be suspended mid-session
      // (autoplay policy, OS interruption, device switch) while the analyser
      // object stays the same. A suspended context yields only silence, which
      // would otherwise read as "below threshold" and keep the gate closed.
      const ctxState = (localAnalyser.context as BaseAudioContext | undefined)?.state;
      if (ctxState && ctxState !== "running") {
        setGateOpen(true);
        consecutiveHighRef.current = 0;
        openSinceRef.current = 0;
        return;
      }

      const binCount = localAnalyser.fftSize;
      if (!bufferRef.current || bufferRef.current.length < binCount) {
        bufferRef.current = new Uint8Array(binCount);
      }

      const now = performance.now();
      const { levelDb } = calculateAnalyserLevel(localAnalyser, bufferRef.current);

      // Adaptive ambient floor tracker
      if (noiseFloorRef.current === -60 && levelDb > -100) {
        noiseFloorRef.current = Math.max(Math.min(levelDb, NOISE_FLOOR_MAX_DB), NOISE_FLOOR_MIN_DB);
      } else {
        noiseFloorRef.current = updateAdaptiveNoiseFloor(noiseFloorRef.current, levelDb);
      }

      // Dynamic thresholds that account for ambient floor
      const effectiveOpen = Math.max(openDb, noiseFloorRef.current + 8);
      const effectiveClose = Math.max(closeDb, noiseFloorRef.current + 4);

      if (openSinceRef.current > 0) {
        // Gate is currently OPEN
        const timeOpen = now - openSinceRef.current;
        if (timeOpen < RELEASE_MS || levelDb >= effectiveClose) {
          // Keep open and refresh release window if still speaking
          if (levelDb >= effectiveClose) {
            openSinceRef.current = now;
          }
        } else {
          // Energy dropped below close threshold and release time expired -> close
          openSinceRef.current = 0;
          consecutiveHighRef.current = 0;
          setGateOpen(false);
        }
      } else {
        // Gate is currently CLOSED
        if (levelDb >= effectiveOpen) {
          consecutiveHighRef.current += 1;
          if (consecutiveHighRef.current >= REQUIRED_ATTACK_SAMPLES) {
            openSinceRef.current = now;
            setGateOpen(true);
          }
        } else {
          consecutiveHighRef.current = 0;
        }
      }
    };

    // Use Web Worker timer so background-tab throttling does not freeze or delay gating
    const stopWorker = createWorkerInterval(onTick, GATE_POLL_INTERVAL_MS);

    return () => {
      stopWorker();
    };
  }, [localAnalyser, threshold, manualThresholdDb, isMuted]);

  return threshold === "off" ? !isMuted : !isMuted && gateOpen;
}

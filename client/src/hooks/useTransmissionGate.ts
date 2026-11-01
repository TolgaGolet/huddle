import { useEffect, useRef, useState, type RefObject } from "react";
import type { VoiceTransmissionThreshold } from "../types";
import {
  analyserBuffer, calculateAnalyserLevel,
  closeGate,
  getThresholdDb,
  INITIAL_GATE_STATE,
  stepGate,
  type GateState,
} from "../lib/audioLevels";
import { createWorkerInterval } from "../lib/workerTimer";

/**
 * Cadence for checking mic transmission level.
 * 25ms provides snappy speech onset detection to avoid clipping initial consonants.
 */
const GATE_POLL_INTERVAL_MS = 25;

interface UseTransmissionGateOptions {
  localAnalyser: AnalyserNode | null;
  outboundStream: MediaStream | null;
  threshold: VoiceTransmissionThreshold;
  manualThresholdDb: number;
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
  manualThresholdDb,
  isMuted,
}: UseTransmissionGateOptions): { isTransmitting: boolean; gateStateRef: RefObject<GateState> } {
  // If threshold is 'off', gate is always considered open
  const [gateOpen, setGateOpen] = useState<boolean>(true);

  const gateStateRef = useRef<GateState>(INITIAL_GATE_STATE);
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
    const failOpen = () => {
      setGateOpen(true);
      gateStateRef.current = closeGate(gateStateRef.current);
    };

    if (threshold === "off") {
      setGateOpen(true);
      return;
    }

    if (!localAnalyser) {
      // No analyser (mic not ready / AudioContext suspended): we CANNOT
      // measure the level, so the gate must fail OPEN — a closed gate here
      // would silently disable the outbound track and cause one-way audio
      // whenever the analyser's AudioContext is autoplay-blocked.
      failOpen();
      return;
    }

    if (isMuted) {
      // While muted the gate is irrelevant (track is disabled by mute), but
      // on the unmute TRANSITION re-arm it closed so transmission resumes
      // under the configured threshold instead of staying open from the
      // muted period.
      if (!prevMutedRef.current) {
        setGateOpen(false);
        gateStateRef.current = closeGate(gateStateRef.current);
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

    const onTick = () => {
      // Checked every tick: the AudioContext can be suspended at the start or
      // mid-session (autoplay policy, OS interruption, device switch) while the
      // analyser object stays the same. A suspended context yields only silence,
      // which would otherwise read as "below threshold" and mute an otherwise
      // healthy outbound track (one-way audio), so fail OPEN until it resumes.
      const ctxState = (localAnalyser.context as BaseAudioContext | undefined)?.state;
      if (ctxState && ctxState !== "running") {
        failOpen();
        return;
      }

      bufferRef.current = analyserBuffer(localAnalyser, bufferRef.current);

      const { levelDb } = calculateAnalyserLevel(localAnalyser, bufferRef.current);

      gateStateRef.current = stepGate(gateStateRef.current, levelDb, performance.now(), limits);
      // Set every tick, not only on a change: gateOpen starts true and failOpen
      // leaves it true while the state machine is closed, so a closed state
      // machine would otherwise never close the real gate. Same value = no render.
      setGateOpen(gateStateRef.current.openSince > 0);
    };

    // Use Web Worker timer so background-tab throttling does not freeze or delay gating
    const stopWorker = createWorkerInterval(onTick, GATE_POLL_INTERVAL_MS);

    return () => {
      stopWorker();
    };
  }, [localAnalyser, threshold, manualThresholdDb, isMuted]);

  return { isTransmitting: threshold === "off" ? !isMuted : !isMuted && gateOpen, gateStateRef };
}

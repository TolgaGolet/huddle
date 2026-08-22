import { useEffect, useMemo, useRef, useState } from "react";

/**
 * Visual voice-activity detection.
 *
 * Uses time-domain RMS level from `getByteTimeDomainData()` rather than an
 * all-frequency-bin FFT average, which was overly sensitive to keyboard/mouse
 * clicks and breath. Per-participant adaptive noise floors and separate
 * open/close thresholds with attack/release hangover prevent the indicator
 * from flickering around transients.
 *
 * IMPORTANT: this is strictly visual. It NEVER toggles `MediaStreamTrack
 * .enabled` or otherwise gates the outgoing audio, which would clip initial
 * consonants and produce the "1 second hearable, 1 second muted" chopping
 * the user reported.
 */

const POLL_INTERVAL = 100; // ms — frequent enough for responsive UI rings
const OPEN_THRESHOLD_DB = -42; // ~6.3% RMS; speech typically exceeds this
const CLOSE_THRESHOLD_DB = -48; // hysteresis prevents flicker near the threshold
const ATTACK_MS = 60; // open quickly when speech starts
const RELEASE_MS = 500; // hold open briefly after speech ends (hangover)
const NOISE_FLOOR_LEARN_RATE = 0.02; // slow adaptation so sustained speech doesn't raise the floor
const NOISE_FLOOR_MIN_DB = -70;
const NOISE_FLOOR_MAX_DB = -35;

interface VoiceState {
  levelDb: number;
  noiseFloorDb: number;
  openSince: number; // timestamp the gate opened (0 = closed)
  closedSince: number; // timestamp the gate closed (0 = open)
}

function rmsToDb(rms: number): number {
  if (rms <= 0) return -100;
  // Clamp to avoid log(0)/Infinity; 8-bit data is 0..255 centered at 128.
  const clamped = Math.max(rms, 1e-7);
  return 20 * Math.log10(clamped / 128);
}

export function useVoiceActivity(
  remoteAnalysers: Map<string, AnalyserNode>,
  localAnalyser: AnalyserNode | null,
  localId?: string,
) {
  const [speaking, setSpeaking] = useState<Set<string>>(new Set());

  const allAnalysers = useMemo(() => {
    const merged = new Map(remoteAnalysers);
    if (localId && localAnalyser) {
      merged.set(localId, localAnalyser);
    }
    return merged;
  }, [remoteAnalysers, localAnalyser, localId]);

  const analysersRef = useRef(allAnalysers);
  analysersRef.current = allAnalysers;

  const statesRef = useRef<Map<string, VoiceState>>(new Map());
  const bufferRef = useRef<Uint8Array | null>(null);

  useEffect(() => {
    const interval = setInterval(() => {
      const current = analysersRef.current;
      const states = statesRef.current;
      const now = performance.now();

      // Drop state for analysers that disappeared (peer left / device changed).
      for (const id of [...states.keys()]) {
        if (!current.has(id)) states.delete(id);
      }

      const nowSpeaking = new Set<string>();
      for (const [id, analyser] of current) {
        const binCount = analyser.fftSize;
        if (!bufferRef.current || bufferRef.current.length < binCount) {
          bufferRef.current = new Uint8Array(binCount);
        }
        const buf = bufferRef.current;
        analyser.getByteTimeDomainData(buf);

        // Compute RMS of the centered signal (8-bit PCM, midpoint 128).
        let sumSq = 0;
        for (let i = 0; i < binCount; i++) {
          const v = buf[i] - 128;
          sumSq += v * v;
        }
        const rms = Math.sqrt(sumSq / binCount);
        const levelDb = rmsToDb(rms);

        let st = states.get(id);
        if (!st) {
          st = {
            levelDb,
            noiseFloorDb: Math.max(Math.min(levelDb, NOISE_FLOOR_MAX_DB), NOISE_FLOOR_MIN_DB),
            openSince: 0,
            closedSince: now,
          };
          states.set(id, st);
        }

        // Adaptive noise floor: slowly track downward when quiet, never track
        // upward fast enough to suppress sustained speech.
        if (levelDb < st.noiseFloorDb) {
          st.noiseFloorDb = levelDb;
        } else {
          st.noiseFloorDb += (levelDb - st.noiseFloorDb) * NOISE_FLOOR_LEARN_RATE;
        }
        st.noiseFloorDb = Math.max(Math.min(st.noiseFloorDb, NOISE_FLOOR_MAX_DB), NOISE_FLOOR_MIN_DB);
        st.levelDb = levelDb;

        const openThr = Math.max(OPEN_THRESHOLD_DB, st.noiseFloorDb + 12);
        const closeThr = Math.max(CLOSE_THRESHOLD_DB, st.noiseFloorDb + 6);

        const isOpen = st.openSince > 0;
        if (isOpen) {
          // Hold open during release window even if level dips, then require
          // level above close threshold to stay open beyond hangover.
          const sinceOpen = now - st.openSince;
          if (sinceOpen < RELEASE_MS) {
            nowSpeaking.add(id);
          } else if (levelDb >= closeThr) {
            nowSpeaking.add(id);
          } else {
            st.openSince = 0;
            st.closedSince = now;
          }
        } else {
          // Require level above open threshold for the attack duration before
          // opening, to avoid transient clicks triggering the ring.
          if (levelDb >= openThr) {
            if (st.closedSince === 0 || now - st.closedSince >= ATTACK_MS) {
              st.openSince = now;
              nowSpeaking.add(id);
            } else {
              // still within attack window; don't open yet
            }
          } else {
            st.closedSince = now;
          }
        }
      }

      setSpeaking((prev) => {
        if (prev.size !== nowSpeaking.size) return nowSpeaking;
        for (const id of nowSpeaking) {
          if (!prev.has(id)) return nowSpeaking;
        }
        return prev;
      });
    }, POLL_INTERVAL);

    return () => clearInterval(interval);
  }, []);

  return speaking;
}

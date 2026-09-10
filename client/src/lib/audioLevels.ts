/**
 * Pure audio level calculations and dB conversions.
 * Shared between useVoiceActivity and useMicTelemetry.
 */

export const NOISE_FLOOR_LEARN_RATE = 0.02;
export const NOISE_FLOOR_MIN_DB = -70;
export const NOISE_FLOOR_MAX_DB = -35;

export const OPEN_THRESHOLD_DB = -42;
export const CLOSE_THRESHOLD_DB = -48;
export const ATTACK_MS = 60;
export const RELEASE_MS = 500;

export const THRESHOLD_LOW_OPEN_DB = -42;
export const THRESHOLD_LOW_CLOSE_DB = -47;

export const THRESHOLD_MEDIUM_OPEN_DB = -36;
export const THRESHOLD_MEDIUM_CLOSE_DB = -41;

export const THRESHOLD_HIGH_OPEN_DB = -30;
export const THRESHOLD_HIGH_CLOSE_DB = -35;

export const THRESHOLD_VERY_HIGH_OPEN_DB = -24;
export const THRESHOLD_VERY_HIGH_CLOSE_DB = -29;

export function getThresholdDb(
  threshold: "off" | "low" | "medium" | "high" | "very-high" | "manual",
  manualDb = -36,
): { openDb: number; closeDb: number } | null {
  if (threshold === "off") return null;
  if (threshold === "low") {
    return { openDb: THRESHOLD_LOW_OPEN_DB, closeDb: THRESHOLD_LOW_CLOSE_DB };
  }
  if (threshold === "medium") {
    return { openDb: THRESHOLD_MEDIUM_OPEN_DB, closeDb: THRESHOLD_MEDIUM_CLOSE_DB };
  }
  if (threshold === "high") {
    return { openDb: THRESHOLD_HIGH_OPEN_DB, closeDb: THRESHOLD_HIGH_CLOSE_DB };
  }
  if (threshold === "very-high") {
    return { openDb: THRESHOLD_VERY_HIGH_OPEN_DB, closeDb: THRESHOLD_VERY_HIGH_CLOSE_DB };
  }
  if (threshold === "manual") {
    const clamped = Math.max(-60, Math.min(-10, manualDb));
    return { openDb: clamped, closeDb: clamped - 5 };
  }
  return { openDb: THRESHOLD_MEDIUM_OPEN_DB, closeDb: THRESHOLD_MEDIUM_CLOSE_DB };
}

export function rmsToDb(rms: number): number {
  if (rms <= 0) return -100;
  // Clamp to avoid log(0)/Infinity; 8-bit data is 0..255 centered at 128.
  const clamped = Math.max(rms, 1e-7);
  return 20 * Math.log10(clamped / 128);
}

/**
 * Calculates RMS and level in dB from an AnalyserNode using time-domain data.
 */
export function calculateAnalyserLevel(analyser: AnalyserNode, buffer: Uint8Array): { rms: number; levelDb: number } {
  analyser.getByteTimeDomainData(buffer);
  const binCount = analyser.fftSize;

  let sumSq = 0;
  for (let i = 0; i < binCount; i++) {
    const v = buffer[i] - 128;
    sumSq += v * v;
  }
  const rms = Math.sqrt(sumSq / binCount);
  const levelDb = rmsToDb(rms);
  return { rms, levelDb };
}

/**
 * Updates an adaptive noise floor based on current level in dB.
 */
export function updateAdaptiveNoiseFloor(currentFloorDb: number, levelDb: number): number {
  let newFloor = currentFloorDb;
  if (levelDb < newFloor) {
    newFloor = levelDb;
  } else {
    newFloor += (levelDb - newFloor) * NOISE_FLOOR_LEARN_RATE;
  }
  return Math.max(Math.min(newFloor, NOISE_FLOOR_MAX_DB), NOISE_FLOOR_MIN_DB);
}

/**
 * Normalizes a decibel value from [-70, 0] dB to [0, 100] percentage for UI rendering.
 */
export function dbToPercentage(db: number, minDb = -70, maxDb = 0): number {
  if (db <= minDb) return 0;
  if (db >= maxDb) return 100;
  return Math.round(((db - minDb) / (maxDb - minDb)) * 100);
}

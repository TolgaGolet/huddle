import { useCallback, useEffect, useState } from "react";
import type { AudioSettingsState, VoiceTransmissionThreshold } from "../types";

const STORAGE_KEY = "huddle.audioSettings.v1";

const DEFAULT_SETTINGS: AudioSettingsState = {
  noiseCancellationEnabled: true,
  transmissionThreshold: "medium",
  manualThresholdDb: -36,
};

function loadSettings(): AudioSettingsState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return DEFAULT_SETTINGS;

    const noiseCancellationEnabled =
      typeof parsed.noiseCancellationEnabled === "boolean"
        ? parsed.noiseCancellationEnabled
        : DEFAULT_SETTINGS.noiseCancellationEnabled;

    const validThresholds: VoiceTransmissionThreshold[] = [
      "off",
      "low",
      "medium",
      "high",
      "very-high",
      "manual",
    ];
    const transmissionThreshold: VoiceTransmissionThreshold = validThresholds.includes(
      parsed.transmissionThreshold,
    )
      ? parsed.transmissionThreshold
      : DEFAULT_SETTINGS.transmissionThreshold;

    const manualThresholdDb =
      typeof parsed.manualThresholdDb === "number" && !Number.isNaN(parsed.manualThresholdDb)
        ? Math.max(-60, Math.min(-10, Math.round(parsed.manualThresholdDb)))
        : DEFAULT_SETTINGS.manualThresholdDb;

    return {
      noiseCancellationEnabled,
      transmissionThreshold,
      manualThresholdDb,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function saveSettings(settings: AudioSettingsState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Ignore storage quota or access errors
  }
}

export function useAudioSettings() {
  const [settings, setSettings] = useState<AudioSettingsState>(loadSettings);

  useEffect(() => {
    saveSettings(settings);
  }, [settings]);

  const setNoiseCancellationEnabled = useCallback((enabled: boolean) => {
    setSettings((prev) => {
      if (prev.noiseCancellationEnabled === enabled) return prev;
      return { ...prev, noiseCancellationEnabled: enabled };
    });
  }, []);

  const setTransmissionThreshold = useCallback((threshold: VoiceTransmissionThreshold) => {
    setSettings((prev) => {
      if (prev.transmissionThreshold === threshold) return prev;
      return { ...prev, transmissionThreshold: threshold };
    });
  }, []);

  const setManualThresholdDb = useCallback((db: number) => {
    const clamped = Math.max(-60, Math.min(-10, Math.round(db)));
    setSettings((prev) => {
      if (prev.manualThresholdDb === clamped) return prev;
      return { ...prev, manualThresholdDb: clamped };
    });
  }, []);

  return {
    settings,
    setNoiseCancellationEnabled,
    setTransmissionThreshold,
    setManualThresholdDb,
  };
}

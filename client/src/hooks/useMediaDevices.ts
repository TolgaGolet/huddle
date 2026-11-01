import { useEffect, useState, useCallback } from "react";
import { errorName, huddleWarn } from "../lib/huddleLog";

/**
 * Browsers leave `navigator.mediaDevices` undefined on insecure origins (plain
 * HTTP other than localhost). There's nothing to watch then, and acquiring the
 * mic reports the problem in its banner.
 */
export function watchDeviceChanges(onChange: () => void): () => void {
  const devices = navigator.mediaDevices;
  if (!devices) return () => {};
  devices.addEventListener("devicechange", onChange);
  return () => devices.removeEventListener("devicechange", onChange);
}

export function useMediaDevices() {
  const [audioInputs, setAudioInputs] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>("");

  const enumerate = useCallback(async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const inputs = devices.filter((d) => d.kind === "audioinput");
      setAudioInputs(inputs);
      if (!selectedDeviceId && inputs.length > 0) {
        setSelectedDeviceId(inputs[0].deviceId);
      }
    } catch (err) {
      huddleWarn("capture", { event: "enumerate-devices-failed", error: errorName(err) });
    }
  }, [selectedDeviceId]);

  useEffect(() => {
    enumerate();
    return watchDeviceChanges(enumerate);
  }, [enumerate]);

  return { audioInputs, selectedDeviceId, setSelectedDeviceId };
}

import { useCallback, useEffect, useRef, useState } from "react";
import { MicCapture } from "../lib/micCapture";
import type { MicError } from "../lib/micError";

interface UseMicrophoneOptions {
  isMuted: boolean;
  noiseCancellation: boolean;
  processStream: (raw: MediaStream) => Promise<MediaStream>;
  onDevice: (deviceId: string) => void;
  /** Runs after the mic is released on unmount. */
  onRelease: () => void;
}

/** React state around a `MicCapture`, acquiring on mount and releasing on unmount. */
export function useMicrophone(options: UseMicrophoneOptions) {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<MicError | null>(null);
  const [retrying, setRetrying] = useState(false);
  // Read when the capture needs them, so it never sees stale values.
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const [capture] = useState(
    () =>
      new MicCapture({
        getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
        processStream: (raw) => optionsRef.current.processStream(raw),
        isMuted: () => optionsRef.current.isMuted,
        noiseCancellation: () => optionsRef.current.noiseCancellation,
        onStream: setStream,
        onError: setError,
        onDevice: (deviceId) => optionsRef.current.onDevice(deviceId),
      }),
  );

  useEffect(() => {
    void capture.acquire();
    return () => {
      capture.dispose();
      optionsRef.current.onRelease();
    };
  }, [capture]);

  const retry = useCallback(async () => {
    if (retrying) return;
    setRetrying(true);
    await capture.retry();
    setRetrying(false);
  }, [retrying, capture]);

  // acquire stops the old raw tracks only after the new stream is confirmed,
  // avoiding a window with no active capture.
  const setDevice = useCallback((deviceId: string) => void capture.acquire(deviceId), [capture]);

  const setNoiseCancellation = useCallback(
    (enabled: boolean, deviceId: string | undefined) => capture.setNoiseCancellation(enabled, deviceId),
    [capture],
  );

  const dismissError = useCallback(() => capture.dismissError(), [capture]);

  return { stream, error, retrying, retry, setDevice, setNoiseCancellation, dismissError };
}

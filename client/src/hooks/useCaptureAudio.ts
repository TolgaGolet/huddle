import { useRef, useCallback, useState, useEffect } from "react";
import { AudioEngine, type AudioHealthListener } from "../lib/audioEngine";

/**
 * Capture-audio hook.
 *
 * Returns the browser-native `getUserMedia` stream as the outbound WebRTC
 * track. Native echo cancellation, noise suppression, and automatic gain
 * control are requested by the caller via getUserMedia constraints and run on
 * the browser's real-time audio thread, so background-tab throttling cannot
 * degrade outgoing voice.
 *
 * A lightweight Web Audio analyser is attached to the stream ONLY for the
 * local speaking indicator. The analyser path never gates, mutes, or alters
 * the outgoing track.
 */
export function useCaptureAudio() {
  const engineRef = useRef<AudioEngine | null>(null);
  const [localAnalyser, setLocalAnalyser] = useState<AnalyserNode | null>(null);
  const [needsAudioGesture, setNeedsAudioGesture] = useState(false);

  const getEngine = useCallback(() => {
    if (!engineRef.current) {
      engineRef.current = new AudioEngine();
    }
    return engineRef.current;
  }, []);

  // Forward engine health updates to React state so the UI can prompt the
  // user to re-enable audio after an autoplay/interruption block. Subscribing
  // on every render is cheap because the engine deduplicates listeners and
  // the returned unsubscribe is stable per call; this also guarantees we
  // attach after the engine is created by processStream().
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    const listener: AudioHealthListener = (needsGesture) => setNeedsAudioGesture(needsGesture);
    const off = engine.onHealth(listener);
    return off;
  });

  /**
   * Attach the analyser to the native microphone stream and return the stream
   * unchanged for direct WebRTC publishing. The caller owns the stream's
   * lifecycle; this hook only taps it for level analysis.
   */
  const processStream = useCallback(
    async (inputStream: MediaStream): Promise<MediaStream> => {
      const engine = getEngine();
      await engine.setInputStream(inputStream);
      setLocalAnalyser(engine.getAnalyser());
      return inputStream;
    },
    [getEngine],
  );

  /**
   * Retry resuming the AudioContext after an autoplay/interruption block.
   * Must be invoked from a user gesture on Safari/iOS. Does not affect the
   * outgoing native microphone track.
   */
  const resumeAudio = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine) return;
    await engine.resume();
    setNeedsAudioGesture(false);
  }, []);

  const cleanup = useCallback(() => {
    engineRef.current?.destroy();
    engineRef.current = null;
    setLocalAnalyser(null);
    setNeedsAudioGesture(false);
  }, []);

  return { processStream, localAnalyser, needsAudioGesture, resumeAudio, cleanup };
}

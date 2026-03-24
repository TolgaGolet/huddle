import { useRef, useCallback, useState } from "react";
import { AudioEngine } from "../lib/audioEngine";

export function useNoiseSuppression() {
  const engineRef = useRef<AudioEngine | null>(null);
  const [localAnalyser, setLocalAnalyser] = useState<AnalyserNode | null>(null);

  const getEngine = useCallback(() => {
    if (!engineRef.current) {
      engineRef.current = new AudioEngine();
    }
    return engineRef.current;
  }, []);

  const processStream = useCallback(
    async (inputStream: MediaStream): Promise<MediaStream> => {
      const engine = getEngine();
      await engine.setInputStream(inputStream);
      await engine.enableNoiseSuppression();
      setLocalAnalyser(engine.getAnalyser());
      return engine.outputStream;
    },
    [getEngine],
  );

  const setInputGain = useCallback(
    (value: number) => {
      getEngine().setInputGain(value);
    },
    [getEngine],
  );

  const cleanup = useCallback(() => {
    engineRef.current?.destroy();
    engineRef.current = null;
    setLocalAnalyser(null);
  }, []);

  return { processStream, setInputGain, localAnalyser, cleanup };
}

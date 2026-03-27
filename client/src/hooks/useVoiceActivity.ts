import { useEffect, useMemo, useRef, useState } from "react";

const THRESHOLD = 3;
const POLL_INTERVAL = 200;

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

  const bufferRef = useRef<Uint8Array | null>(null);

  useEffect(() => {
    const interval = setInterval(() => {
      const current = analysersRef.current;
      const nowSpeaking = new Set<string>();
      for (const [id, analyser] of current) {
        const binCount = analyser.frequencyBinCount;
        if (!bufferRef.current || bufferRef.current.length < binCount) {
          bufferRef.current = new Uint8Array(binCount);
        }
        analyser.getByteFrequencyData(bufferRef.current);
        let sum = 0;
        for (let i = 0; i < binCount; i++) sum += bufferRef.current[i];
        if (sum / binCount > THRESHOLD) nowSpeaking.add(id);
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

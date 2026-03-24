import { useEffect, useMemo, useRef, useState } from "react";

const THRESHOLD = 3;
const POLL_INTERVAL = 100;

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

  useEffect(() => {
    const interval = setInterval(() => {
      const current = analysersRef.current;
      const nowSpeaking = new Set<string>();
      for (const [id, analyser] of current) {
        const data = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteFrequencyData(data);
        const avg = data.reduce((a, b) => a + b, 0) / data.length;
        if (avg > THRESHOLD) nowSpeaking.add(id);
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

/** An AnalyserNode whose level a test sets. `amplitude` is 0-127: 0 reads as silence, 64 as about -6 dB. */
export function fakeAnalyser(contextState = "running") {
  const analyser = {
    fftSize: 8,
    amplitude: 0,
    context: { state: contextState },
    getByteTimeDomainData(buffer: Uint8Array) {
      buffer.fill(128 + analyser.amplitude);
    },
  };
  return analyser;
}

export const asAnalyser = (analyser: ReturnType<typeof fakeAnalyser>) => analyser as unknown as AnalyserNode;

export const LOUD = 64;
export const SILENT = 0;

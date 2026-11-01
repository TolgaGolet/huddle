// Stop every track of the given streams, once each. A clone()d track is
// independent of its source, so the raw capture and the outbound clone must
// both be stopped to release the microphone.
export function stopStreams(...streams: (MediaStream | null | undefined)[]): void {
  const tracks = new Set<MediaStreamTrack>();
  for (const stream of streams) {
    stream?.getTracks().forEach((t) => tracks.add(t));
  }
  tracks.forEach((t) => t.stop());
}

/**
 * Sets noise suppression on every track. Resolves true only if it took effect
 * on all of them, since a browser can accept the call and change nothing; one
 * that doesn't report the setting gets the benefit of the doubt. Rejects if the
 * browser refuses the constraint.
 */
export async function applyNoiseSuppression(tracks: MediaStreamTrack[], enabled: boolean): Promise<boolean> {
  if (!tracks.length || tracks.some((t) => typeof t.applyConstraints !== "function")) return false;
  await Promise.all(tracks.map((t) => t.applyConstraints({ noiseSuppression: enabled })));
  return tracks.every((t) => {
    const actual = t.getSettings().noiseSuppression;
    return actual === undefined || actual === enabled;
  });
}

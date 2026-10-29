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

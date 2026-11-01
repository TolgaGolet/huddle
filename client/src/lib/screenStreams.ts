export function withoutStream(streams: Map<string, MediaStream>, id: string): Map<string, MediaStream> {
  const next = new Map(streams);
  next.delete(id);
  return next;
}

/** Moves a stream to a new key, such as our socket id after a reconnect. */
export function rekeyStream(streams: Map<string, MediaStream>, from: string, to: string): Map<string, MediaStream> {
  const stream = streams.get(from);
  if (!stream) return streams;
  return withoutStream(streams, from).set(to, stream);
}

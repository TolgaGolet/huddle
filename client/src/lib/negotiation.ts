// Perfect-negotiation role: exactly one side of a pair is polite. Callers must
// pass the *live* socket id — it is undefined before "connect" and changes on
// every Socket.IO reconnect.
export function isPoliteFor(selfId: string, peerId: string): boolean {
  return selfId > peerId;
}

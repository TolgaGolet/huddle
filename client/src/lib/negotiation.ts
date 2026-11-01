// Perfect-negotiation role: exactly one side of a pair is polite. Callers must
// pass the *live* socket id — it is undefined before "connect" and changes on
// every Socket.IO reconnect.
export function isPoliteFor(selfId: string, peerId: string): boolean {
  return selfId > peerId;
}

// What to do with an inbound offer. A collision means we are making an offer or
// are mid-negotiation: the impolite side keeps its own offer, the polite side
// rolls back and accepts theirs.
export function resolveInboundOffer({
  isPolite,
  makingOffer,
  signalingState,
}: {
  isPolite: boolean;
  makingOffer: boolean;
  signalingState: RTCSignalingState;
}): "accept" | "rollback" | "ignore" {
  if (!makingOffer && signalingState === "stable") return "accept";
  return isPolite ? "rollback" : "ignore";
}

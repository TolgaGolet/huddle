const MAX_BUFFERED_CANDIDATES = 100;

/**
 * Adds to a list of candidates waiting to be applied. A peer can send them with no
 * limit and repeated ICE restarts add more, so the list is capped; the oldest are
 * the stalest, and far more than a real connection needs are kept.
 */
export function bufferCandidate(list: RTCIceCandidateInit[], candidate: RTCIceCandidateInit): void {
  list.push(candidate);
  if (list.length > MAX_BUFFERED_CANDIDATES) list.shift();
}

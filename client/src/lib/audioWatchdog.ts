/**
 * Directional audio-stall detection for WebRTC peer connections.
 *
 * The previous watchdog treated a peer as healthy when audio bytes advanced in
 * EITHER direction (`inBytes > prev.in || outBytes > prev.out`). That masked
 * genuinely one-way audio: if Brave kept sending while Firefox's inbound path
 * was dead, the advancing outbound counter continually cleared the silence
 * timer and recovery never ran. This module tracks each direction INDEPENDENTLY
 * so a stalled direction is detected even while the other is flowing.
 *
 * Design notes:
 *   - A direction is "stalled" only when BOTH its byte and packet counters are
 *     completely flat for the full stall window. RTP packets keep flowing (even
 *     for a muted/quiet speaker, via silence frames / Opus DTX) on a healthy
 *     path, so a truly flat counter indicates a broken path or a sender that
 *     stopped producing — not ordinary silence. This keeps false positives low.
 *   - `null` counters mean the browser did not expose that stat. A direction we
 *     cannot measure is reported as `unknown` and NEVER triggers recovery
 *     (important for cross-browser stat differences, notably Firefox).
 *   - A direction that is not negotiated (e.g. `recvonly`) is `idle` and never
 *     triggers recovery. Outbound is additionally idle while the local track is
 *     muted or transmission-gated closed, since the user intentionally disabled
 *     sending and a recovery would be disruptive.
 *   - Counter resets (bytes/packets decreasing after an ICE restart, SSRC
 *     change, or track swap) re-baseline the window instead of alarming.
 *
 * This module is intentionally pure (no DOM types) so it can be unit-tested in
 * isolation. `evaluateDirection` is the pure per-direction primitive;
 * `DirectionalAudioWatchdog` wraps it with per-peer state for use by
 * `useWebRTC`.
 */

export type Direction = "in" | "out";

export type DirectionStatus =
  /** Counters advanced since the previous sample. */
  | "progressing"
  /** Expected and measurable, but flat for the full window — recovery should run. */
  | "stalled"
  /** Expected and measurable, but the stall window has not elapsed yet. */
  | "measuring"
  /** Not expected right now (direction not negotiated, or outbound intentionally silent). */
  | "idle"
  /** The browser did not expose usable stats — cannot measure, never recovers. */
  | "unknown";

export interface DirectionSample {
  /** Cumulative RTP bytes for this direction, or `null` if unavailable. */
  bytes: number | null;
  /** Cumulative RTP packets for this direction, or `null` if unavailable. */
  packets: number | null;
}

export interface DirectionState {
  bytes: number | null;
  packets: number | null;
  /** Timestamp (ms) of the last observed progress (or when tracking began). */
  lastProgressAt: number;
  /** Whether a baseline sample has been recorded. */
  seeded: boolean;
}

export interface DirectionDecision {
  status: DirectionStatus;
  /** True when this direction has been flat for >= stallWindowMs and recovery should run. */
  shouldRecover: boolean;
  /** How long this direction has been flat, in ms (0 unless `measuring`/`stalled`). */
  flatForMs: number;
}

export interface WatchdogSample {
  in: DirectionSample;
  out: DirectionSample;
  /** The negotiated transceiver expects to receive remote audio. */
  expectsInbound: boolean;
  /** The negotiated transceiver expects to send local audio. */
  expectsOutbound: boolean;
  /** The local outbound track is live and enabled (not muted / gate-closed). */
  outboundTrackActive: boolean;
  /** Current timestamp in ms (e.g. `Date.now()`). */
  now: number;
}

export interface WatchdogDecision {
  in: DirectionDecision;
  out: DirectionDecision;
}

/** Default flat-window before a direction is considered stalled. */
export const DEFAULT_STALL_WINDOW_MS = 15000;

function freshState(): DirectionState {
  return { bytes: null, packets: null, lastProgressAt: 0, seeded: false };
}

/**
 * Pure per-direction stall evaluation. Given the previous state and a new
 * sample, returns the updated state and the decision for this tick. Never
 * mutates its inputs.
 */
export function evaluateDirection(
  state: DirectionState,
  sample: DirectionSample,
  expected: boolean,
  now: number,
  stallWindowMs: number,
): { state: DirectionState; decision: DirectionDecision } {
  const measurable = sample.bytes !== null || sample.packets !== null;

  if (!expected) {
    return { state: freshState(), decision: { status: "idle", shouldRecover: false, flatForMs: 0 } };
  }
  if (!measurable) {
    return { state: freshState(), decision: { status: "unknown", shouldRecover: false, flatForMs: 0 } };
  }

  if (!state.seeded) {
    return {
      state: { bytes: sample.bytes, packets: sample.packets, lastProgressAt: now, seeded: true },
      decision: { status: "measuring", shouldRecover: false, flatForMs: 0 },
    };
  }

  // Counter reset (ICE restart / SSRC change / track swap): re-baseline rather
  // than interpret the drop as a stall.
  const bytesReset = state.bytes !== null && sample.bytes !== null && sample.bytes < state.bytes;
  const packetsReset = state.packets !== null && sample.packets !== null && sample.packets < state.packets;
  if (bytesReset || packetsReset) {
    return {
      state: { bytes: sample.bytes, packets: sample.packets, lastProgressAt: now, seeded: true },
      decision: { status: "measuring", shouldRecover: false, flatForMs: 0 },
    };
  }

  const bytesProgress = state.bytes !== null && sample.bytes !== null && sample.bytes > state.bytes;
  const packetsProgress = state.packets !== null && sample.packets !== null && sample.packets > state.packets;
  const progressed = bytesProgress || packetsProgress;

  const nextState: DirectionState = {
    bytes: sample.bytes,
    packets: sample.packets,
    lastProgressAt: progressed ? now : state.lastProgressAt,
    seeded: true,
  };

  if (progressed) {
    return { state: nextState, decision: { status: "progressing", shouldRecover: false, flatForMs: 0 } };
  }

  const flatForMs = now - state.lastProgressAt;
  if (flatForMs >= stallWindowMs) {
    // Reset the window so the next recovery for this direction is a full window
    // away, preventing a recovery storm.
    return {
      state: { ...nextState, lastProgressAt: now },
      decision: { status: "stalled", shouldRecover: true, flatForMs },
    };
  }
  return { state: nextState, decision: { status: "measuring", shouldRecover: false, flatForMs } };
}

/**
 * Per-peer wrapper around {@link evaluateDirection}. Tracks inbound and outbound
 * audio progress independently so a flowing direction can never mask a stalled
 * one.
 */
export class DirectionalAudioWatchdog {
  private peers = new Map<string, { in: DirectionState; out: DirectionState }>();

  constructor(private readonly stallWindowMs: number = DEFAULT_STALL_WINDOW_MS) {}

  observe(peerId: string, sample: WatchdogSample): WatchdogDecision {
    const prev = this.peers.get(peerId) ?? { in: freshState(), out: freshState() };

    const inExpected = sample.expectsInbound;
    // Outbound is only watched while we actually intend to send (track live and
    // enabled). A muted / gate-closed sender is intentional silence, not a stall.
    const outExpected = sample.expectsOutbound && sample.outboundTrackActive;

    const inResult = evaluateDirection(prev.in, sample.in, inExpected, sample.now, this.stallWindowMs);
    const outResult = evaluateDirection(prev.out, sample.out, outExpected, sample.now, this.stallWindowMs);

    this.peers.set(peerId, { in: inResult.state, out: outResult.state });
    return { in: inResult.decision, out: outResult.decision };
  }

  /** Forget all tracking for a peer (peer removed / recreated). */
  reset(peerId: string): void {
    this.peers.delete(peerId);
  }

  /** Forget all tracking for every peer (e.g. full reconnect). */
  resetAll(): void {
    this.peers.clear();
  }

  /**
   * Re-baseline one direction after a recovery/negotiation so the effect of the
   * recovery is measured over a fresh window rather than re-triggering at once.
   */
  rebaseline(peerId: string, direction: Direction): void {
    const s = this.peers.get(peerId);
    if (!s) return;
    s[direction] = freshState();
  }
}
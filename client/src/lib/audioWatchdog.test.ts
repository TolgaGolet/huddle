import { describe, it, expect } from "vitest";
import {
  DirectionalAudioWatchdog,
  evaluateDirection,
  DEFAULT_STALL_WINDOW_MS,
  type DirectionState,
  type WatchdogSample,
} from "./audioWatchdog";

const fresh = (): DirectionState => ({ bytes: null, packets: null, lastProgressAt: 0, seeded: false });

function sample(over: Partial<WatchdogSample> = {}): WatchdogSample {
  return {
    in: { bytes: 100, packets: 10 },
    out: { bytes: 100, packets: 10 },
    expectsInbound: true,
    expectsOutbound: true,
    outboundTrackActive: true,
    now: 0,
    ...over,
  };
}

describe("evaluateDirection", () => {
  it("seeds a baseline on the first sample without alarming", () => {
    const { state, decision } = evaluateDirection(fresh(), { bytes: 10, packets: 1 }, true, 1000, 15000);
    expect(decision.status).toBe("measuring");
    expect(decision.shouldRecover).toBe(false);
    expect(state.seeded).toBe(true);
    expect(state.lastProgressAt).toBe(1000);
  });

  it("reports progressing and resets the flat timer when counters advance", () => {
    const seeded = evaluateDirection(fresh(), { bytes: 10, packets: 1 }, true, 0, 15000).state;
    const { decision } = evaluateDirection(seeded, { bytes: 20, packets: 2 }, true, 5000, 15000);
    expect(decision.status).toBe("progressing");
    expect(decision.shouldRecover).toBe(false);
    expect(decision.flatForMs).toBe(0);
  });

  it("advances on packet progress alone (muted/DTX sender still emits RTP)", () => {
    const seeded = evaluateDirection(fresh(), { bytes: 10, packets: 1 }, true, 0, 15000).state;
    // bytes flat, packets advanced — still healthy.
    const { decision } = evaluateDirection(seeded, { bytes: 10, packets: 5 }, true, 5000, 15000);
    expect(decision.status).toBe("progressing");
  });

  it("stalls only after the full window of zero progress in BOTH counters", () => {
    let state = evaluateDirection(fresh(), { bytes: 10, packets: 1 }, true, 0, 15000).state;
    // Still measuring just before the window elapses.
    let r = evaluateDirection(state, { bytes: 10, packets: 1 }, true, 14999, 15000);
    expect(r.decision.status).toBe("measuring");
    expect(r.decision.shouldRecover).toBe(false);
    state = r.state;
    // Window elapsed with no progress -> stalled.
    r = evaluateDirection(state, { bytes: 10, packets: 1 }, true, 15000, 15000);
    expect(r.decision.status).toBe("stalled");
    expect(r.decision.shouldRecover).toBe(true);
    expect(r.decision.flatForMs).toBeGreaterThanOrEqual(15000);
  });

  it("re-baselines after a stall so recovery does not storm every tick", () => {
    let state = evaluateDirection(fresh(), { bytes: 10, packets: 1 }, true, 0, 15000).state;
    const stalled = evaluateDirection(state, { bytes: 10, packets: 1 }, true, 15000, 15000);
    expect(stalled.decision.shouldRecover).toBe(true);
    state = stalled.state;
    // Immediately after recovery the timer restarts — not stalled again.
    const next = evaluateDirection(state, { bytes: 10, packets: 1 }, true, 15001, 15000);
    expect(next.decision.shouldRecover).toBe(false);
  });

  it("treats a counter reset (ICE restart / SSRC change) as re-baselining, not a stall", () => {
    let state = evaluateDirection(fresh(), { bytes: 1000, packets: 100 }, true, 0, 15000).state;
    // Counters drop after a restart.
    const r = evaluateDirection(state, { bytes: 5, packets: 1 }, true, 20000, 15000);
    expect(r.decision.status).toBe("measuring");
    expect(r.decision.shouldRecover).toBe(false);
    state = r.state;
    // And progress from the new baseline is tracked normally.
    const next = evaluateDirection(state, { bytes: 50, packets: 10 }, true, 21000, 15000);
    expect(next.decision.status).toBe("progressing");
  });

  it("never recovers a direction that cannot be measured (missing stats)", () => {
    const seeded = evaluateDirection(fresh(), { bytes: 10, packets: 1 }, true, 0, 15000).state;
    const r = evaluateDirection(seeded, { bytes: null, packets: null }, true, 999999, 15000);
    expect(r.decision.status).toBe("unknown");
    expect(r.decision.shouldRecover).toBe(false);
  });

  it("treats an un-negotiated direction as idle and never recovers it", () => {
    const r = evaluateDirection(fresh(), { bytes: 0, packets: 0 }, false, 999999, 15000);
    expect(r.decision.status).toBe("idle");
    expect(r.decision.shouldRecover).toBe(false);
  });
});

describe("DirectionalAudioWatchdog", () => {
  it("detects a stalled INBOUND direction even while OUTBOUND keeps flowing (one-way audio)", () => {
    const wd = new DirectionalAudioWatchdog(15000);
    const peerId = "p1";

    // Baseline.
    wd.observe(peerId, sample({ now: 0 }));
    // Outbound advances every tick; inbound stays flat. This is exactly the
    // Brave->Firefox one-way case the old OR-check masked.
    let decision = wd.observe(
      peerId,
      sample({ now: 15000, in: { bytes: 100, packets: 10 }, out: { bytes: 900, packets: 90 } }),
    );
    expect(decision.out.status).toBe("progressing");
    expect(decision.in.status).toBe("stalled");
    expect(decision.in.shouldRecover).toBe(true);
    expect(decision.out.shouldRecover).toBe(false);
  });

  it("detects a stalled OUTBOUND direction even while INBOUND keeps flowing", () => {
    const wd = new DirectionalAudioWatchdog(15000);
    const peerId = "p1";
    wd.observe(peerId, sample({ now: 0 }));
    const decision = wd.observe(
      peerId,
      sample({ now: 15000, in: { bytes: 900, packets: 90 }, out: { bytes: 100, packets: 10 } }),
    );
    expect(decision.in.status).toBe("progressing");
    expect(decision.out.status).toBe("stalled");
    expect(decision.out.shouldRecover).toBe(true);
    expect(decision.in.shouldRecover).toBe(false);
  });

  it("does not flag outbound when the local track is muted / gate-closed (intentional silence)", () => {
    const wd = new DirectionalAudioWatchdog(15000);
    const peerId = "p1";
    wd.observe(peerId, sample({ now: 0, outboundTrackActive: true }));
    const decision = wd.observe(
      peerId,
      sample({
        now: 20000,
        outboundTrackActive: false,
        in: { bytes: 500, packets: 50 },
        out: { bytes: 100, packets: 10 },
      }),
    );
    expect(decision.out.status).toBe("idle");
    expect(decision.out.shouldRecover).toBe(false);
  });

  it("does not flag inbound on a recv-only-inactive (idle) direction", () => {
    const wd = new DirectionalAudioWatchdog(15000);
    const peerId = "p1";
    wd.observe(peerId, sample({ now: 0, expectsInbound: true }));
    const decision = wd.observe(
      peerId,
      sample({ now: 20000, expectsInbound: false, in: { bytes: 100, packets: 10 } }),
    );
    expect(decision.in.status).toBe("idle");
    expect(decision.in.shouldRecover).toBe(false);
  });

  it("never recovers when the browser exposes no audio stats", () => {
    const wd = new DirectionalAudioWatchdog(15000);
    const peerId = "p1";
    wd.observe(peerId, sample({ now: 0 }));
    const decision = wd.observe(
      peerId,
      sample({
        now: 30000,
        in: { bytes: null, packets: null },
        out: { bytes: null, packets: null },
      }),
    );
    expect(decision.in.status).toBe("unknown");
    expect(decision.out.status).toBe("unknown");
    expect(decision.in.shouldRecover).toBe(false);
    expect(decision.out.shouldRecover).toBe(false);
  });

  it("tracks multiple peers independently", () => {
    const wd = new DirectionalAudioWatchdog(15000);
    wd.observe("a", sample({ now: 0 }));
    wd.observe("b", sample({ now: 0 }));
    const a = wd.observe("a", sample({ now: 15000, in: { bytes: 100, packets: 10 }, out: { bytes: 900, packets: 90 } }));
    const b = wd.observe("b", sample({ now: 15000, in: { bytes: 900, packets: 90 }, out: { bytes: 900, packets: 90 } }));
    expect(a.in.shouldRecover).toBe(true);
    expect(b.in.shouldRecover).toBe(false);
    expect(b.out.shouldRecover).toBe(false);
  });

  it("reset() clears a peer's tracking", () => {
    const wd = new DirectionalAudioWatchdog(15000);
    wd.observe("a", sample({ now: 0 }));
    wd.reset("a");
    // After reset the next sample is a fresh baseline, not a 15s stall.
    const d = wd.observe("a", sample({ now: 999999, in: { bytes: 100, packets: 10 }, out: { bytes: 100, packets: 10 } }));
    expect(d.in.status).toBe("measuring");
    expect(d.in.shouldRecover).toBe(false);
  });

  it("rebaseline() restarts a single direction's window", () => {
    const wd = new DirectionalAudioWatchdog(15000);
    wd.observe("a", sample({ now: 0 }));
    wd.rebaseline("a", "in");
    const d = wd.observe("a", sample({ now: 20000, in: { bytes: 100, packets: 10 }, out: { bytes: 900, packets: 90 } }));
    expect(d.in.status).toBe("measuring");
    expect(d.in.shouldRecover).toBe(false);
  });

  it("uses the default window when none is supplied", () => {
    expect(DEFAULT_STALL_WINDOW_MS).toBe(15000);
  });
});
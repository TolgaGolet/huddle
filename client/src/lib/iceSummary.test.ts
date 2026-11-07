import { describe, expect, it } from "vitest";
import { summarizeIce } from "./iceSummary";

const report = (stats: Record<string, unknown>[]) => ({ forEach: (fn: (s: unknown) => void) => stats.forEach(fn) });

const candidates = [
  { id: "L1", type: "local-candidate", candidateType: "host", protocol: "udp", address: "192.168.1.2", port: 5000 },
  { id: "L2", type: "local-candidate", candidateType: "srflx", protocol: "udp", address: "203.0.113.5", port: 6000 },
  { id: "R1", type: "remote-candidate", candidateType: "host", protocol: "udp", address: "abcd.local", port: 7000 },
  { id: "R2", type: "remote-candidate", candidateType: "prflx", protocol: "udp", address: "198.51.100.9", port: 8000 },
];

describe("summarizeIce", () => {
  it("counts candidates by type and pairs by state, and names the pair Chromium selected", () => {
    const summary = summarizeIce(
      report([
        ...candidates,
        { id: "P1", type: "candidate-pair", state: "failed", localCandidateId: "L1", remoteCandidateId: "R1" },
        { id: "P2", type: "candidate-pair", state: "succeeded", localCandidateId: "L2", remoteCandidateId: "R2" },
        { id: "T", type: "transport", selectedCandidatePairId: "P2" },
      ]),
    );

    expect(summary).toEqual({
      local: { "host/udp": 1, "srflx/udp": 1 },
      remote: { "host/udp": 1, "prflx/udp": 1 },
      pairs: { failed: 1, succeeded: 1 },
      selected: "srflx/prflx",
    });
  });

  it("finds Firefox's selected pair, and reports none when nothing connected", () => {
    const firefox = summarizeIce(
      report([...candidates, { id: "P1", type: "candidate-pair", state: "succeeded", selected: true, localCandidateId: "L1", remoteCandidateId: "R1" }]),
    );
    const failed = summarizeIce(report([...candidates, { id: "P1", type: "candidate-pair", state: "failed", localCandidateId: "L1", remoteCandidateId: "R1" }]));

    expect(firefox.selected).toBe("host/host");
    expect(failed.selected).toBeNull();
  });

  // huddleLog must never carry addresses, ports or mDNS names.
  it("leaves out every address and port", () => {
    const text = JSON.stringify(summarizeIce(report(candidates)));

    for (const leak of ["192.168", "203.0", "198.51", ".local", "5000", "6000", "7000", "8000"]) {
      expect(text).not.toContain(leak);
    }
  });
});

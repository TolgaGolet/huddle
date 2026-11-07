/** The part of an `RTCStatsReport` read here; fields vary by browser. */
interface StatsReportLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- stats are a per-type grab bag.
  forEach(callback: (stat: any) => void): void;
}

export interface IceSummary {
  /** e.g. `{ "host/udp": 2, "srflx/udp": 1 }` */
  local: Record<string, number>;
  remote: Record<string, number>;
  /** Candidate pairs by state, e.g. `{ failed: 4, succeeded: 1 }`. */
  pairs: Record<string, number>;
  /** `"<local type>/<remote type>"` of the pair in use, or null. */
  selected: string | null;
}

const count = (into: Record<string, number>, key: string) => {
  into[key] = (into[key] ?? 0) + 1;
};

const describeCandidate = (c: { candidateType?: string; protocol?: string } | undefined) =>
  `${c?.candidateType ?? "?"}/${c?.protocol ?? "?"}`;

/**
 * Why ICE did or didn't connect, as candidate types and pair states only. It
 * never reads addresses, ports or mDNS names, which `huddleLog` must not carry.
 */
export function summarizeIce(report: StatsReportLike): IceSummary {
  const summary: IceSummary = { local: {}, remote: {}, pairs: {}, selected: null };
  // Candidate id → type, to describe the selected pair.
  const candidateTypes = new Map<string, string | undefined>();
  const pairs: { id: string; state?: string; localCandidateId?: string; remoteCandidateId?: string; nominated?: boolean; selected?: boolean }[] = [];
  let selectedPairId: string | undefined;

  report.forEach((s) => {
    if (s.type === "local-candidate" || s.type === "remote-candidate") {
      candidateTypes.set(s.id, s.candidateType);
      count(s.type === "local-candidate" ? summary.local : summary.remote, describeCandidate(s));
    } else if (s.type === "candidate-pair") {
      pairs.push(s);
      count(summary.pairs, s.state ?? "?");
    } else if (s.type === "transport" && s.selectedCandidatePairId) {
      // Chromium names the pair in use on the transport.
      selectedPairId = s.selectedCandidatePairId;
    }
  });

  // Firefox marks it on the pair instead.
  const selected =
    pairs.find((p) => p.id === selectedPairId) ?? pairs.find((p) => p.selected) ?? pairs.find((p) => p.nominated && p.state === "succeeded");
  if (selected) {
    const local = candidateTypes.get(selected.localCandidateId ?? "");
    const remote = candidateTypes.get(selected.remoteCandidateId ?? "");
    summary.selected = `${local ?? "?"}/${remote ?? "?"}`;
  }
  return summary;
}

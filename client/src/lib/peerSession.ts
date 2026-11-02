import { bufferCandidate } from "./candidateBuffer";
import { describeStats, DirectionalAudioWatchdog, readAudioStats, type Direction } from "./audioWatchdog";
import { errorName, huddleLog, huddleWarn } from "./huddleLog";
import { isPoliteFor, resolveInboundOffer } from "./negotiation";
import type { ClientToServerEvents } from "../types";

const MAX_RESTARTS = 3;
const MAX_AUDIO_RECOVERIES = 2;
const IGNORED_OFFER_RECOVERY_MS = 5000;
const DISCONNECT_ESCALATION_MS = 8000;

// Structured stats log, development only.
//
// Firefox: `console.debug` output is shown by default in the console (unlike
// Chrome, which hides debug-level messages unless "Verbose" is selected), so the
// 5s sampler floods the Firefox console. Skip the periodic stats log entirely in
// Firefox; the event-driven watchdog / negotiation logs remain active everywhere.
const LOG_PERIODIC_STATS =
  import.meta.env.DEV &&
  !(typeof navigator !== "undefined" && /firefox/i.test(navigator.userAgent));

/** What a session needs from its owner; React state and socket wiring stay in `useWebRTC`. */
export interface PeerSessionHost {
  /** Bound to the socket that created the session. */
  emit<E extends "offer" | "answer" | "ice-candidate">(event: E, ...args: Parameters<ClientToServerEvents[E]>): void;
  getLocalStream(): MediaStream | null;
  onTrack(e: RTCTrackEvent): void;
  onConnectionState(state: RTCPeerConnectionState): void;
  /** Replace this session with a fresh one (the automated "rejoin fixes it"). */
  requestRecreate(): void;
}

export interface PeerSessionOptions {
  screenTrack?: MediaStreamTrack | null;
  /** Candidates that arrived before this session existed. */
  earlyCandidates?: RTCIceCandidateInit[];
}

/**
 * One remote peer: its `RTCPeerConnection` and all negotiation and recovery
 * state. A recreated peer is a new instance, so nothing can leak into it. Async
 * callbacks check `disposed` before touching the connection, so work queued for
 * a removed session can never affect its replacement.
 */
export class PeerSession {
  private disposed = false;
  private makingOffer = false;
  private pendingCandidates: RTCIceCandidateInit[];
  // Pending ICE candidates that failed to apply (e.g. arrived during an ICE
  // restart while the old remote description was still set). They are retried
  // once the peer returns to a stable signaling state.
  private retryCandidates: RTCIceCandidateInit[] = [];
  // Serializes SDP operations (setLocalDescription/setRemoteDescription and
  // answer creation) so concurrent offers cannot interleave.
  private sdpLock: Promise<unknown> = Promise.resolve();
  // ICE recovery state. `restartIce()` only schedules a new negotiation; the
  // actual offer/answer exchange happens through `onnegotiationneeded`. We
  // guard against re-entrant restarts and track how long the peer has been
  // disconnected so we can escalate after a bounded timeout.
  private iceRestarting = false;
  private disconnectedSince: number | null = null;
  // Consecutive failed ICE restarts, for exponential backoff and the
  // peer-recreation fallback (automates the manual "rejoin fixes it" fix).
  private restartFailures = 0;
  // Directional audio-stall watchdog. Tracks inbound and outbound RTP progress
  // INDEPENDENTLY so a flowing direction can never mask a stalled one (the old
  // `inBytes > prev.in || outBytes > prev.out` check let one-way audio persist
  // forever). Pure logic lives in `audioWatchdog.ts` and is unit-tested.
  private audioWatchdog = new DirectionalAudioWatchdog();
  // Recovery escalation bookkeeping per direction (bounded retries → recreate).
  private audioRecoveries: Record<Direction, number> = { in: 0, out: 0 };
  private screenSender: RTCRtpSender | null = null;

  constructor(
    readonly peerId: string,
    private readonly pc: RTCPeerConnection,
    private readonly host: PeerSessionHost,
    { screenTrack, earlyCandidates }: PeerSessionOptions = {},
  ) {
    this.pendingCandidates = earlyCandidates ?? [];

    const stream = host.getLocalStream();
    // Deterministic audio m-line: if we have a mic track, add it as a
    // `sendrecv` transceiver BEFORE the first setLocalDescription so the
    // initial offer always carries audio. If the mic is not ready yet,
    // create an explicit `sendrecv` (recv-capable) audio transceiver so the
    // remote side still negotiates an audio m-line we can later attach a
    // track to via replaceTrack — avoiding a stuck/absent audio m-line.
    const audioTrack = stream?.getAudioTracks()[0];
    if (stream && audioTrack) {
      pc.addTrack(audioTrack, stream);
    } else {
      pc.addTransceiver("audio", { direction: "sendrecv" });
    }
    huddleLog("peer", { event: "create", peerId, addedAudio: !!audioTrack });

    if (screenTrack) {
      this.addScreenTrack(screenTrack, new MediaStream([screenTrack]));
    }

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        host.emit("ice-candidate", { to: peerId, candidate: e.candidate.toJSON() });
      }
    };
    pc.ontrack = (e) => host.onTrack(e);
    pc.onconnectionstatechange = () => this.handleConnectionState();
    pc.onnegotiationneeded = () => this.negotiate();
  }

  dispose(): void {
    this.disposed = true;
    this.pc.close();
  }

  // Serialize SDP mutations. `onnegotiationneeded`, `handleOffer`, and
  // `handleAnswer` all touch local/remote descriptions; letting them interleave
  // (e.g. an answer landing while a polite rollback is in flight) is what leaves
  // a peer stuck in `have-local-offer`/`have-remote-offer` with no audio.
  private withSdpLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.sdpLock.then(fn, fn);
    this.sdpLock = next.catch(() => undefined);
    return next;
  }

  private handleConnectionState(): void {
    if (this.disposed) return;
    const { pc, peerId } = this;
    const state = pc.connectionState;
    huddleLog("connection", { peerId, state });
    this.host.onConnectionState(state);
    if (state === "connected") {
      // A successful connection resets the restart-failure ladder.
      this.restartFailures = 0;
      this.disconnectedSince = null;
      return;
    }
    if (state === "failed") {
      this.disconnectedSince = null;
      // Hard failure: restart ICE with exponential backoff. After
      // MAX_RESTARTS consecutive failures, tear the peer down and
      // recreate it from scratch (a fresh RTCPeerConnection + offer),
      // which is exactly the manual "rejoin" fix users resorted to.
      this.restartFailures += 1;
      const failures = this.restartFailures;
      if (failures > MAX_RESTARTS) {
        huddleWarn("connection", { peerId, event: "recreate-peer", failures });
        this.host.requestRecreate();
        return;
      }
      if (this.iceRestarting) return;
      this.iceRestarting = true;
      // Backoff: 2s, 4s, 8s (capped).
      const delay = Math.min(2000 * 2 ** (failures - 1), 8000);
      setTimeout(() => {
        // The peer may have been removed/recreated while we backed off.
        if (this.disposed) return;
        this.iceRestarting = false;
        if (pc.connectionState === "failed") {
          try {
            pc.restartIce();
          } catch {
            /* restart may throw if negotiation is in flight */
          }
        }
      }, delay);
      return;
    }
    if (state === "disconnected") {
      // Track when we became disconnected so the stats sampler can
      // escalate to an ICE restart after a bounded timeout.
      if (this.disconnectedSince === null) {
        this.disconnectedSince = Date.now();
      }
      return;
    }
    // connecting / new / closed
    this.disconnectedSince = null;
  }

  private async negotiate(): Promise<void> {
    const { pc, peerId } = this;
    // Serialize against in-flight SDP mutations on this peer.
    await this.withSdpLock(async () => {
      if (this.disposed) return;
      try {
        // Idempotency/state guard: never create a local offer while the
        // signaling state is mid-negotiation (e.g. have-remote-offer after
        // a rollback). Doing so throws InvalidStateError and can leave the
        // audio m-line unnegotiated.
        if (pc.signalingState !== "stable") {
          huddleLog("negotiate", { peerId, event: "skip-offer", signalingState: pc.signalingState });
          // Re-arm: retry the offer once the peer returns to stable, so a
          // skipped negotiation is never silently lost.
          pc.addEventListener(
            "signalingstatechange",
            () => {
              if (pc.signalingState === "stable" && pc.connectionState !== "closed") {
                void this.negotiate();
              }
            },
            { once: true },
          );
          return;
        }
        this.makingOffer = true;
        await pc.setLocalDescription();
        huddleLog("negotiate", {
          peerId,
          event: "offer",
          signalingState: pc.signalingState,
          hasAudioSender: pc.getSenders().some((s) => s.track?.kind === "audio"),
        });
        this.host.emit("offer", { to: peerId, offer: pc.localDescription! });
      } catch (err) {
        huddleWarn("negotiate", { peerId, event: "offer-error", error: errorName(err) });
      } finally {
        this.makingOffer = false;
      }
    });
  }

  private async flushCandidates(): Promise<void> {
    const candidates = this.pendingCandidates;
    this.pendingCandidates = [];
    await this.applyCandidates(candidates);
  }

  // Candidates that failed to apply (typically new-generation candidates
  // arriving while the old remote description was still set during an ICE
  // restart). Retried once the peer is stable — losing these was the root
  // cause of the endless `failed` restart loop.
  private async flushRetryCandidates(): Promise<void> {
    const candidates = this.retryCandidates;
    this.retryCandidates = [];
    await this.applyCandidates(candidates);
  }

  private async applyCandidates(candidates: RTCIceCandidateInit[]): Promise<void> {
    for (const c of candidates) {
      try {
        await this.pc.addIceCandidate(new RTCIceCandidate(c));
      } catch {
        // Stale generation (e.g. ICE restart raced the flush): keep it for
        // the next stable transition instead of dropping it forever.
        bufferCandidate(this.retryCandidates, c);
      }
    }
  }

  /** `selfId` is the live socket id; a reconnect disposes the session, so it can't go stale. */
  handleOffer(offer: RTCSessionDescriptionInit, selfId: string): Promise<void> {
    const { pc, peerId: from } = this;
    return this.withSdpLock(async () => {
      if (this.disposed) return;
      try {
        const isPolite = isPoliteFor(selfId, from);
        const action = resolveInboundOffer({
          isPolite,
          makingOffer: this.makingOffer,
          signalingState: pc.signalingState,
        });

        if (action === "ignore") {
          // Impolite side: keep our offer and ignore the conflicting inbound one.
          // Its candidates aren't filtered: any that fail to apply just wait in
          // retryCandidates.
          huddleLog("negotiate", { from, event: "ignore-offer", isPolite, signalingState: pc.signalingState });
          // Recovery: if our own offer is never answered (the remote may
          // have given up), force a renegotiation after a grace period so
          // the peer cannot dead-end in `have-local-offer` forever.
          setTimeout(() => {
            if (
              !this.disposed &&
              pc.signalingState === "have-local-offer" &&
              pc.connectionState !== "connected"
            ) {
              huddleWarn("negotiate", { peerId: from, event: "ignore-offer-recovery" });
              try {
                pc.restartIce();
              } catch {
                /* negotiation may be in flight */
              }
            }
          }, IGNORED_OFFER_RECOVERY_MS);
          return;
        }

        if (action === "rollback") {
          // Polite side: roll back our local offer so we can accept theirs.
          try {
            await pc.setLocalDescription({ type: "rollback" });
          } catch (err) {
            // Rollback can fail if state is already stable/closed; continue best-effort.
            huddleWarn("negotiate", { from, event: "rollback-failed", error: errorName(err) });
          }
        }

        await pc.setRemoteDescription(offer);
        await this.flushCandidates();
        await this.flushRetryCandidates();
        await pc.setLocalDescription();
        huddleLog("negotiate", {
          from,
          event: "answer",
          signalingState: pc.signalingState,
          hasAudioSender: pc.getSenders().some((s) => s.track?.kind === "audio"),
        });
        this.host.emit("answer", { to: from, answer: pc.localDescription! });
      } catch (err) {
        huddleWarn("negotiate", { from, event: "offer-handling-error", error: errorName(err) });
      }
    });
  }

  handleAnswer(answer: RTCSessionDescriptionInit): Promise<void> {
    const { pc, peerId: from } = this;
    return this.withSdpLock(async () => {
      if (this.disposed) return;
      try {
        if (pc.signalingState === "stable") {
          huddleLog("negotiate", { from, event: "answer-ignored-stable" });
          return;
        }
        await pc.setRemoteDescription(answer);
        await this.flushCandidates();
        await this.flushRetryCandidates();
        huddleLog("negotiate", { from, event: "answer-applied", signalingState: pc.signalingState });
      } catch (err) {
        huddleWarn("negotiate", { from, event: "answer-error", error: errorName(err) });
      }
    });
  }

  async addCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    if (!this.pc.remoteDescription) {
      bufferCandidate(this.pendingCandidates, candidate);
      return;
    }
    try {
      await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch {
      // The candidate belongs to a newer ICE generation than the currently
      // applied remote description (e.g. mid-restart). Buffer it and retry
      // once signaling is stable — never drop it permanently.
      bufferCandidate(this.retryCandidates, candidate);
    }
  }

  attachLocalTrack(newTrack: MediaStreamTrack, stream: MediaStream): void {
    const { pc, peerId } = this;
    if (pc.connectionState === "closed") return;
    // Prefer replacing the track on an existing audio transceiver. A
    // transceiver created without a track (mic not ready at peer creation)
    // has a sender with NO track, so matching on `s.track?.kind` misses it
    // — that bug fell through to `addTrack`, creating a DUPLICATE audio
    // m-line and a renegotiation instead of the intended seamless
    // replaceTrack, leaving the remote side with a dead first m-line.
    const audioTransceiver = pc
      .getTransceivers()
      .find((t) => t.receiver.track?.kind === "audio" && !t.sender.track);
    const audioSender =
      audioTransceiver?.sender ??
      pc.getSenders().find((s) => s.track?.kind === "audio");
    if (audioSender) {
      if (audioTransceiver && audioTransceiver.direction !== "sendrecv") {
        try { audioTransceiver.direction = "sendrecv"; } catch { /* ignore */ }
      }
      // If the sender already has a track (set by the previous effect), replace it.
      // If it was created empty (addTransceiver without a track), replaceTrack
      // succeeds without renegotiation.
      huddleLog("audio", { peerId, event: "replaceTrack" });
      audioSender.replaceTrack(newTrack).catch((err) => {
        huddleWarn("audio", { peerId, event: "replaceTrack-error", error: errorName(err) });
      });
    } else {
      try {
        pc.addTrack(newTrack, stream);
        huddleLog("audio", { peerId, event: "addTrack" });
      } catch (err) {
        huddleWarn("audio", { peerId, event: "addTrack-error", error: errorName(err) });
      }
    }
  }

  addScreenTrack(track: MediaStreamTrack, stream: MediaStream): void {
    this.screenSender = this.pc.addTrack(track, stream);
  }

  removeScreenTrack(): void {
    if (!this.screenSender) return;
    try { this.pc.removeTrack(this.screenSender); } catch { /* already removed */ }
    this.screenSender = null;
  }

  /**
   * Recover a single stalled audio direction. Kept separate from the stats
   * sampler so the sampler stays focused on measurement.
   *
   * Escalation is bounded to avoid recovery storms and infinite recreate loops:
   *   1. Re-sync the audio transceiver (force `sendrecv`, re-attach our track).
   *   2. `restartIce()` to force a fresh negotiation / candidate run.
   *   3. After `MAX_AUDIO_RECOVERIES` stalled windows in the same direction,
   *      tear the peer down and recreate it — the automated equivalent of the
   *      manual "rejoin fixes it" workaround.
   * The per-direction counter resets whenever that direction shows progress.
   */
  private recoverOneWayAudio(dir: Direction, flatForMs: number): void {
    const { pc, peerId } = this;
    this.audioRecoveries[dir] += 1;
    const attempt = this.audioRecoveries[dir];

    huddleWarn("watchdog", {
      peerId,
      event: "one-way-audio",
      dir,
      flatForMs,
      attempt,
    });

    if (attempt > MAX_AUDIO_RECOVERIES) {
      huddleWarn("watchdog", { peerId, event: "recreate-peer", dir, attempt });
      this.host.requestRecreate();
      return;
    }

    try {
      // Re-sync the audio transceiver: ensure it is bidirectional and that our
      // live microphone track is attached (a trackless sender sends nothing).
      const track = this.host.getLocalStream()?.getAudioTracks()[0] ?? null;
      for (const tx of pc.getTransceivers()) {
        if (tx.receiver.track?.kind !== "audio") continue;
        if (tx.direction !== "sendrecv") {
          try {
            tx.direction = "sendrecv";
          } catch {
            /* ignore */
          }
        }
        if (track && tx.sender.track !== track) {
          tx.sender.replaceTrack(track).catch(() => {
            /* restartIce below will retry */
          });
        }
      }
      // Force a fresh negotiation / candidate run for the broken path.
      this.audioWatchdog.rebaseline(dir);
      pc.restartIce();
    } catch (err) {
      huddleWarn("watchdog", { peerId, event: "renegotiate-error", dir, error: errorName(err) });
    }
  }

  /**
   * Sample WebRTC stats and escalate ICE recovery when the peer stays
   * disconnected beyond a bounded timeout. All stat fields are feature-detected
   * because support differs across Chromium, Firefox, and Safari. Samples are
   * logged to the console as structured diagnostics; no media content is
   * captured.
   */
  async sampleStats(): Promise<void> {
    const { pc, peerId } = this;
    if (this.disposed) return;
    if (this.escalateIfDisconnected()) return;

    if (pc.connectionState !== "connected") return;

    let report: RTCStatsReport;
    try {
      report = await pc.getStats();
    } catch {
      return;
    }
    // The peer may have been removed while the stats were being collected.
    if (this.disposed) return;

    const audio = readAudioStats(report);

    // --- Recovery watchdog: detect audio broken in ONE direction ----------
    // Inbound and outbound RTP progress are tracked INDEPENDENTLY. A stuck or
    // one-way audio path keeps `connectionState === "connected"` (the ICE
    // transport is alive) while audio dies in one direction. The old check
    // (`inBytes > prev.in || outBytes > prev.out`) treated progress in EITHER
    // direction as healthy, so one-way audio was masked forever.
    //
    // `DirectionalAudioWatchdog` decides per direction, tolerating counter
    // resets (ICE restarts) and browser stat gaps (missing stats are
    // "unknown", never recovered). Outbound is only watched while the local
    // track is live and enabled, so a muted / gate-closed sender is treated
    // as intentional silence rather than a stall.
    const now = Date.now();
    const outboundTrack = this.host.getLocalStream()?.getAudioTracks()[0] ?? null;
    const audioTransceiver = pc.getTransceivers().find((t) => t.receiver.track?.kind === "audio");
    const negotiatedDirection = audioTransceiver?.currentDirection ?? audioTransceiver?.direction;
    const outboundTrackActive = !!outboundTrack && outboundTrack.enabled && outboundTrack.readyState === "live";
    const decision = this.audioWatchdog.observe({
      in: audio.in,
      out: audio.out,
      expectsInbound: negotiatedDirection === "sendrecv" || negotiatedDirection === "recvonly",
      expectsOutbound: negotiatedDirection === "sendrecv" || negotiatedDirection === "sendonly",
      outboundTrackActive,
      now,
    });

    for (const dir of ["in", "out"] as const) {
      const d = decision[dir];
      if (d.status === "stalled" && d.shouldRecover) {
        this.recoverOneWayAudio(dir, d.flatForMs);
        // Recovery may have replaced this session.
        if (this.disposed) return;
      } else if (d.status === "progressing") {
        // This direction recovered — clear its escalation ladder.
        this.audioRecoveries[dir] = 0;
      }
    }

    if (LOG_PERIODIC_STATS) {
      console.debug("[huddle:webrtc-stats]", {
        peerId,
        state: pc.connectionState,
        ...describeStats(report),
        watchdog: {
          in: decision.in.status,
          out: decision.out.status,
          negotiatedDirection,
          outboundTrackActive,
        },
      });
    }
  }

  /** Escalates a prolonged disconnection to an ICE restart; true if it has lasted that long. */
  private escalateIfDisconnected(): boolean {
    const since = this.disconnectedSince;
    if (since === null || Date.now() - since <= DISCONNECT_ESCALATION_MS) return false;
    if (!this.iceRestarting) {
      this.iceRestarting = true;
      try {
        this.pc.restartIce();
      } catch {
        /* negotiation may be in flight */
      }
      setTimeout(() => {
        if (this.disposed) return;
        this.iceRestarting = false;
      }, 2000);
    }
    return true;
  }
}

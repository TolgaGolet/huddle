import { errorName, huddleLog } from "./huddleLog";
import { classifyMicError, micErrorAfterTrackEnded, type MicError } from "./micError";
import { applyNoiseSuppression, stopStreams } from "./micStreams";

export interface MicCaptureOptions {
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  /** Hands the raw capture to the local analyser. */
  processStream: (raw: MediaStream) => Promise<MediaStream>;
  isMuted: () => boolean;
  noiseCancellation: () => boolean;
  onStream: (stream: MediaStream) => void;
  onError: (error: MicError | null) => void;
  onDevice: (deviceId: string) => void;
}

export function isNoiseCancellationSupported(): boolean {
  return Boolean(
    typeof navigator !== "undefined" &&
      navigator.mediaDevices?.getSupportedConstraints?.()?.noiseSuppression,
  );
}

/**
 * Build browser-compatible audio constraints that request native WebRTC
 * processing (echo cancellation, noise suppression, automatic gain control).
 *
 * These constraints are treated as hints: each browser may honor or ignore
 * them depending on platform/hardware. They are the same class of processing
 * used by Google Meet / Zoom and, unlike a page-owned AudioWorklet, continue
 * to run on the browser's real-time audio thread when the tab is backgrounded.
 *
 * `advanced`/`exact` are avoided for processing flags so a browser that does
 * not support a constraint still returns a usable track. Device selection
 * uses `exact` so switching devices is honored.
 */
export function buildAudioConstraints(deviceId: string | undefined, noiseCancellation: boolean): MediaTrackConstraints {
  const constraints: MediaTrackConstraints = {
    echoCancellation: true,
    noiseSuppression: noiseCancellation,
    autoGainControl: true,
  };
  if (deviceId) {
    constraints.deviceId = { exact: deviceId };
  }
  return constraints;
}

// Surface the browser-reported capture settings in development so
// noise-suppression capability can be distinguished from request.
function debugCaptureSettings(raw: MediaStream): void {
  if (!import.meta.env.DEV) return;
  const settings = raw.getAudioTracks()[0]?.getSettings();
  const supported = navigator.mediaDevices?.getSupportedConstraints?.() ?? {};
  console.debug("[huddle:capture]", {
    deviceId: settings?.deviceId,
    echoCancellation: settings?.echoCancellation,
    noiseSuppression: settings?.noiseSuppression,
    autoGainControl: settings?.autoGainControl,
    sampleRate: settings?.sampleRate,
    channelCount: settings?.channelCount,
    supportedEchoCancellation: supported.echoCancellation,
    supportedNoiseSuppression: supported.noiseSuppression,
    supportedAutoGainControl: supported.autoGainControl,
  });
}

/** Owns the microphone: acquisition, device switches, and recovery when a track ends. */
export class MicCapture {
  private raw: MediaStream | null = null;
  // The outbound clone is independent of the raw track and must be stopped separately.
  private outbound: MediaStream | null = null;
  // Generation guard: only the newest acquisition may install its stream.
  // Stale getUserMedia completions (e.g. from a superseded device switch)
  // are stopped instead of overwriting the active capture.
  private generation = 0;
  // The device retry asks for: the one that failed, unless it has gone away.
  private retryDeviceId: string | undefined;
  private error: MicError | null = null;

  constructor(private readonly options: MicCaptureOptions) {}

  private setError(error: MicError | null): void {
    this.error = error;
    this.options.onError(error);
  }

  dismissError(): void {
    this.setError(null);
  }

  /** Resolves true only if this acquisition became the active capture. */
  async acquire(deviceId?: string, noiseCancellation = this.options.noiseCancellation()): Promise<boolean> {
    const gen = ++this.generation;
    const startedAt = performance.now();
    try {
      const raw = await this.options.getUserMedia({
        audio: buildAudioConstraints(deviceId, noiseCancellation),
      });
      huddleLog("capture", {
        event: "getUserMedia-resolved",
        gen,
        elapsedMs: Math.round(performance.now() - startedAt),
        requestedDevice: !!deviceId,
      });
      // A newer acquisition superseded this one; discard the stale stream.
      if (gen !== this.generation) {
        stopStreams(raw);
        return false;
      }
      // Stop the previously active raw tracks before replacing, now that
      // the new stream is confirmed good.
      if (this.raw && this.raw !== raw) {
        stopStreams(this.raw);
      }
      this.raw = raw;

      debugCaptureSettings(raw);

      const processed = await this.options.processStream(raw);
      if (gen !== this.generation) return false;

      // Clone the native capture track specifically for the outbound WebRTC stream.
      // This decouples outbound transmission gating (track.enabled) from the localAnalyser
      // tap. Setting outboundTrack.enabled = false silences transmission without silencing
      // the raw analyser input, allowing the gate to reopen when speech resumes.
      const rawAudioTrack = raw.getAudioTracks()[0];
      const outboundTrack = rawAudioTrack ? rawAudioTrack.clone() : null;
      const outboundStream = outboundTrack ? new MediaStream([outboundTrack]) : processed;

      const outboundAudioTrack = outboundStream.getAudioTracks()[0];
      if (outboundAudioTrack) {
        outboundAudioTrack.enabled = !this.options.isMuted();
      }

      // Clean up previously active outbound tracks
      if (this.outbound && this.outbound !== raw) {
        stopStreams(this.outbound);
      }
      this.outbound = outboundStream;

      this.options.onStream(outboundStream);
      this.setError(null);
      this.retryDeviceId = undefined;
      // Set here, not when the user picks, so the picker only ever shows the
      // device in use, including after a fallback to the default one.
      const activeDeviceId = rawAudioTrack?.getSettings().deviceId;
      if (activeDeviceId) this.options.onDevice(activeDeviceId);
      // Unplugged, or revoked by the browser. stop() doesn't fire this, so our
      // own device switches and leaving don't reach it.
      rawAudioTrack?.addEventListener("ended", () => {
        if (this.raw !== raw) return;
        huddleLog("capture", { event: "track-ended" });
        void this.acquire().then((recovered) => {
          if (!recovered && this.raw === raw) this.setError(micErrorAfterTrackEnded(this.error));
        });
      });
      huddleLog("capture", {
        event: "localStream-committed",
        gen,
        elapsedMs: Math.round(performance.now() - startedAt),
      });
      return true;
    } catch (err) {
      huddleLog("capture", { event: "getUserMedia-failed", error: errorName(err) });
      if (gen !== this.generation) return false;
      const error = classifyMicError(err);
      const stillCapturing = this.outbound?.getAudioTracks()[0]?.readyState === "live";
      this.setError(stillCapturing ? "switch-failed" : error);
      this.retryDeviceId = error === "not-found" ? undefined : deviceId;
      return false;
    }
  }

  retry(): Promise<boolean> {
    return this.acquire(this.retryDeviceId);
  }

  async setNoiseCancellation(enabled: boolean, deviceId: string | undefined): Promise<void> {
    // Peers receive the outbound clone, and constraints apply per track.
    const tracks = [this.raw, this.outbound].flatMap((stream) => stream?.getAudioTracks() ?? []);
    try {
      if (await applyNoiseSuppression(tracks, enabled)) {
        huddleLog("capture", {
          event: "applyConstraints-noiseSuppression-success",
          enabled,
        });
        return;
      }
      huddleLog("capture", { event: "applyConstraints-not-applied-fallback-reacquire" });
    } catch (err) {
      huddleLog("capture", {
        event: "applyConstraints-failed-fallback-reacquire",
        error: errorName(err),
      });
    }

    // Fallback: reacquire mic with new constraints. Chromium accepts the call
    // above without changing anything, and hands a new capture of an open device
    // that device's old processing, so the current capture must close first.
    stopStreams(this.raw, this.outbound);
    void this.acquire(deviceId, enabled);
  }

  /**
   * Releases the mic. Invalidates any in-flight acquisition so a late getUserMedia
   * resolve stops its own stream instead of reopening the mic after leaving.
   */
  dispose(): void {
    this.generation++;
    stopStreams(this.raw, this.outbound);
    this.raw = null;
    this.outbound = null;
  }
}

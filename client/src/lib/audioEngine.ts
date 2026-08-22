/**
 * Audio engine for Huddle.
 *
 * Design goals:
 *   - The outbound WebRTC microphone track is the browser-native
 *     `getUserMedia` track. Native echo cancellation, noise suppression, and
 *     automatic gain control run on the browser's real-time audio thread and
 *     continue to run when the tab is backgrounded. This is the same approach
 *     used by Google Meet / Zoom and avoids the "robotic voice" / periodic
 *     muting regression caused by routing outbound audio through a page-owned
 *     `MediaStreamAudioDestinationNode` that can be starved when the tab is
 *     hidden.
 *   - Web Audio is used ONLY for the local analyser that drives the speaking
 *     indicator. If the AudioContext is suspended/interrupted, the speaking
 *     indicator may stop updating, but the outgoing microphone track is
 *     unaffected.
 *   - Make AudioContext.resume() failures observable so callers can surface a
 *     user-gesture "enable audio" recovery path on autoplay-restricted
 *     browsers (notably Safari/iOS). Recovery never touches the outgoing
 *     native track.
 */

/** Neutral gain multiplier. 100% in the UI maps to 1.0 (no boost). */
const UNITY_GAIN = 1.0;

export type AudioHealthListener = (needsGesture: boolean) => void;

/**
 * Local analyser engine.
 *
 * Wraps a minimal Web Audio graph (`MediaStreamSource -> AnalyserNode`) used
 * only for visual voice-activity detection. It does NOT produce the outbound
 * stream; the caller publishes the original native `getUserMedia` stream
 * directly to WebRTC.
 */
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private healthListeners = new Set<AudioHealthListener>();

  private notifyHealth(needsGesture: boolean) {
    for (const l of this.healthListeners) {
      try {
        l(needsGesture);
      } catch {
        /* listener errors must not break audio */
      }
    }
  }

  /** Subscribe to audio-health updates. Returns an unsubscribe function. */
  onHealth(listener: AudioHealthListener): () => void {
    this.healthListeners.add(listener);
    return () => this.healthListeners.delete(listener);
  }

  private getContext(): AudioContext {
    if (!this.ctx) {
      // Request 48 kHz for consistent analyser behavior; the browser may
      // choose a different rate depending on hardware/OS.
      this.ctx = new AudioContext({ sampleRate: 48000 });
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 512;
    }
    return this.ctx;
  }

  getAnalyser(): AnalyserNode | null {
    return this.analyser;
  }

  /**
   * Attach a microphone stream to the analyser. The stream itself is returned
   * unchanged by the caller; this method only taps it for level analysis.
   */
  async setInputStream(stream: MediaStream) {
    const ctx = this.getContext();
    if (ctx.state === "suspended") {
      try {
        await ctx.resume();
      } catch {
        this.notifyHealth(true);
      }
    }

    if (this.source) this.source.disconnect();
    this.source = ctx.createMediaStreamSource(stream);
    this.source.connect(this.analyser!);
  }

  /**
   * Explicitly resume the AudioContext after an autoplay/interruption block.
   * Must be invoked from a user gesture on Safari/iOS. Does not affect the
   * outgoing native microphone track.
   */
  async resume(): Promise<void> {
    const ctx = this.getContext();
    if (ctx.state === "suspended") {
      try {
        await ctx.resume();
      } catch {
        this.notifyHealth(true);
      }
    }
  }

  destroy() {
    this.source?.disconnect();
    this.analyser?.disconnect();
    this.healthListeners.clear();
    this.ctx?.close();
    this.ctx = null;
    this.source = null;
    this.analyser = null;
  }
}

export class RemoteAudioManager {
  private ctx: AudioContext | null = null;
  private gains = new Map<string, GainNode>();
  private analysers = new Map<string, AnalyserNode>();
  private sources = new Map<string, MediaStreamAudioSourceNode>();
  private audioElements = new Map<string, HTMLAudioElement>();
  private keepAliveOsc: OscillatorNode | null = null;
  private healthListeners = new Set<AudioHealthListener>();

  private startKeepAliveNode(ctx: AudioContext) {
    if (this.keepAliveOsc) return;
    const osc = ctx.createOscillator();
    const silentGain = ctx.createGain();
    silentGain.gain.value = 0;
    osc.connect(silentGain);
    silentGain.connect(ctx.destination);
    osc.start();
    this.keepAliveOsc = osc;
  }

  private notifyHealth(needsGesture: boolean) {
    for (const l of this.healthListeners) {
      try {
        l(needsGesture);
      } catch {
        /* listener errors must not break audio */
      }
    }
  }

  /** Subscribe to remote-audio-health updates (e.g. autoplay blocked). */
  onHealth(listener: AudioHealthListener): () => void {
    this.healthListeners.add(listener);
    return () => this.healthListeners.delete(listener);
  }

  /**
   * Attempt to resume playback after an autoplay/interruption block. Must be
   * called from a user gesture on Safari/iOS. Safe to call repeatedly.
   */
  async resumePlayback(): Promise<boolean> {
    if (!this.ctx) return false;
    const ctx = this.getContext();
    try {
      if (ctx.state === "suspended") await ctx.resume();
    } catch {
      /* will be retried on next gesture */
    }
    let anyPlayed = false;
    for (const audio of this.audioElements.values()) {
      try {
        await audio.play();
        anyPlayed = true;
      } catch {
        /* still blocked; caller may retry */
      }
    }
    this.notifyHealth(false);
    return anyPlayed;
  }

  private getContext(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.startKeepAliveNode(this.ctx);
    }
    return this.ctx;
  }

  addStream(peerId: string, stream: MediaStream): void {
    this.removeStream(peerId);

    const ctx = this.getContext();
    if (ctx.state === "suspended") {
      ctx.resume().catch(() => this.notifyHealth(true));
    }

    // A silent HTMLAudioElement activates the MediaStream in Firefox/Safari
    // so createMediaStreamSource can produce audio. volume=0 keeps the
    // element's own output inaudible while still forcing the browser to
    // actively decode the stream (muted=true skips decoding entirely and
    // breaks the pipeline).
    const audio = new Audio();
    audio.srcObject = stream;
    audio.volume = 0;
    audio.play().catch(() => this.notifyHealth(true));

    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;

    // Firefox may output WebRTC audio as a 2-channel stream with data only
    // in the left channel (instead of true mono). Force the analyser to
    // collapse everything to 1 channel first so the downstream upmix works.
    analyser.channelCount = 1;
    analyser.channelCountMode = "explicit";
    analyser.channelInterpretation = "speakers";

    const gain = ctx.createGain();
    gain.gain.value = UNITY_GAIN;
    gain.channelCount = 2;
    gain.channelCountMode = "explicit";
    gain.channelInterpretation = "speakers";

    source.connect(analyser);
    analyser.connect(gain);
    gain.connect(ctx.destination);

    this.sources.set(peerId, source);
    this.analysers.set(peerId, analyser);
    this.gains.set(peerId, gain);
    this.audioElements.set(peerId, audio);
  }

  getAnalysers(): Map<string, AnalyserNode> {
    return this.analysers;
  }

  setVolume(peerId: string, value: number) {
    const gain = this.gains.get(peerId);
    if (gain && this.ctx) {
      gain.gain.setTargetAtTime(value, this.ctx.currentTime, 0.01);
    }
  }

  removeStream(peerId: string) {
    this.sources.get(peerId)?.disconnect();
    this.analysers.get(peerId)?.disconnect();
    this.gains.get(peerId)?.disconnect();
    const audio = this.audioElements.get(peerId);
    if (audio) {
      audio.pause();
      audio.srcObject = null;
      audio.load();
    }
    this.sources.delete(peerId);
    this.analysers.delete(peerId);
    this.gains.delete(peerId);
    this.audioElements.delete(peerId);
  }

  destroy() {
    this.keepAliveOsc?.stop();
    this.keepAliveOsc?.disconnect();
    this.keepAliveOsc = null;
    const ids = [...this.sources.keys()];
    for (const id of ids) {
      this.removeStream(id);
    }
    this.healthListeners.clear();
    this.ctx?.close();
    this.ctx = null;
  }
}

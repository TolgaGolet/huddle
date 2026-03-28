import {
  loadRnnoise,
  RnnoiseWorkletNode,
} from "@sapphi-red/web-noise-suppressor";

const GAIN_BOOST = 3.5;

/**
 * Prevents browsers from throttling or suspending audio processing when the
 * tab loses focus.  Critical for voice-chat apps used alongside full-screen
 * games where the browser window is never the active foreground window.
 *
 * Four complementary strategies cover Chrome, Edge, Brave, Firefox and Safari:
 *
 *   1. AudioContext `statechange` – auto-resume on suspend / interrupt
 *   2. `visibilitychange` + Page Lifecycle `resume` – resume on tab refocus
 *   3. Web Lock – prevents Chrome Energy Saver from freezing the tab
 *   4. Inline Worker heartbeat (1 Hz) – Worker timers are never throttled,
 *      so the postMessage wakes the main thread to resume the context even
 *      under aggressive background-tab timer throttling
 */
class BackgroundGuard {
  private lockRelease: (() => void) | null = null;
  private worker: Worker | null = null;

  private resumeCtx = () => {
    const s = this.ctx.state as string;
    if (s === "suspended" || s === "interrupted") {
      this.ctx.resume().catch(() => {});
    }
  };

  constructor(private ctx: AudioContext) {
    ctx.addEventListener("statechange", this.resumeCtx);
    document.addEventListener("visibilitychange", this.resumeCtx);
    document.addEventListener("resume", this.resumeCtx);
    this.acquireLock();
    this.startHeartbeat();
  }

  private acquireLock() {
    if (!navigator?.locks) return;
    navigator.locks
      .request(`huddle-audio-${performance.now()}`, () =>
        new Promise<void>((r) => {
          this.lockRelease = r;
        }),
      )
      .catch(() => {});
  }

  private startHeartbeat() {
    try {
      const blob = new Blob(["setInterval(()=>postMessage(0),1000)"], {
        type: "application/javascript",
      });
      const url = URL.createObjectURL(blob);
      this.worker = new Worker(url);
      URL.revokeObjectURL(url);
      this.worker.onmessage = this.resumeCtx;
    } catch {
      /* inline workers may be blocked by CSP */
    }
  }

  destroy() {
    this.ctx.removeEventListener("statechange", this.resumeCtx);
    document.removeEventListener("visibilitychange", this.resumeCtx);
    document.removeEventListener("resume", this.resumeCtx);
    this.worker?.terminate();
    this.worker = null;
    this.lockRelease?.();
    this.lockRelease = null;
  }
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private gainNode: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private destination: MediaStreamAudioDestinationNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private rnnoiseNode: RnnoiseWorkletNode | null = null;
  private rnnoiseReady = false;
  private keepAliveOsc: OscillatorNode | null = null;
  private guard: BackgroundGuard | null = null;

  /**
   * A permanently running silent oscillator keeps Chromium's audio render
   * thread ticking at full rate even when the browser window is in the
   * background. Without it, Chromium starves the AudioWorklet render thread
   * when the tab loses focus, causing robotic/glitchy audio output.
   */
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

  private getContext(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext({ sampleRate: 48000 });
      this.guard = new BackgroundGuard(this.ctx);
      this.startKeepAliveNode(this.ctx);
      this.gainNode = this.ctx.createGain();
      this.gainNode.gain.value = GAIN_BOOST;
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 256;
      this.destination = this.ctx.createMediaStreamDestination();
      this.gainNode.connect(this.destination);
    }
    return this.ctx;
  }

  get outputStream(): MediaStream {
    this.getContext();
    return this.destination!.stream;
  }

  getAnalyser(): AnalyserNode | null {
    return this.analyser;
  }

  setInputGain(value: number) {
    if (this.gainNode && this.ctx) {
      this.gainNode.gain.setTargetAtTime(value * GAIN_BOOST, this.ctx.currentTime, 0.01);
    }
  }

  private rebuildGraph() {
    if (!this.source || !this.gainNode || !this.analyser || !this.destination) return;
    this.source.disconnect();
    this.rnnoiseNode?.disconnect();
    this.analyser.disconnect();
    this.gainNode.disconnect();

    if (this.rnnoiseReady && this.rnnoiseNode) {
      this.source.connect(this.rnnoiseNode);
      this.rnnoiseNode.connect(this.analyser);
    } else {
      this.source.connect(this.analyser);
    }
    this.analyser.connect(this.gainNode);
    this.gainNode.connect(this.destination);
  }

  async setInputStream(stream: MediaStream) {
    const ctx = this.getContext();
    if (ctx.state === "suspended") await ctx.resume();

    if (this.source) this.source.disconnect();
    this.source = ctx.createMediaStreamSource(stream);
    this.rebuildGraph();
  }

  async enableNoiseSuppression() {
    if (this.rnnoiseReady) return;

    const ctx = this.getContext();
    try {
      const wasmBinary = await loadRnnoise({
        url: "/rnnoise.wasm",
        simdUrl: "/rnnoise_simd.wasm",
      });

      await ctx.audioWorklet.addModule("/noise-suppressor-worklet.js");

      this.rnnoiseNode = new RnnoiseWorkletNode(ctx, {
        maxChannels: 1,
        wasmBinary,
      });

      this.rnnoiseReady = true;
      this.rebuildGraph();
    } catch (err) {
      console.warn("Noise suppression unavailable:", err);
    }
  }

  destroy() {
    this.guard?.destroy();
    this.guard = null;
    this.keepAliveOsc?.stop();
    this.keepAliveOsc?.disconnect();
    this.keepAliveOsc = null;
    this.source?.disconnect();
    this.rnnoiseNode?.destroy();
    this.analyser?.disconnect();
    this.gainNode?.disconnect();
    this.ctx?.close();
    this.ctx = null;
  }
}

export class RemoteAudioManager {
  private ctx: AudioContext | null = null;
  private gains = new Map<string, GainNode>();
  private analysers = new Map<string, AnalyserNode>();
  private sources = new Map<string, MediaStreamAudioSourceNode>();
  private audioElements = new Map<string, HTMLAudioElement>();
  private keepAliveOsc: OscillatorNode | null = null;
  private guard: BackgroundGuard | null = null;

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

  private getContext(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.guard = new BackgroundGuard(this.ctx);
      this.startKeepAliveNode(this.ctx);
    }
    return this.ctx;
  }

  addStream(peerId: string, stream: MediaStream): void {
    this.removeStream(peerId);

    const ctx = this.getContext();
    if (ctx.state === "suspended") {
      ctx.resume();
    }

    // A silent HTMLAudioElement activates the MediaStream in Firefox/Safari
    // so createMediaStreamSource can produce audio.  volume=0 keeps the
    // element's own output inaudible while still forcing the browser to
    // actively decode the stream (muted=true skips decoding entirely and
    // breaks the pipeline).
    const audio = new Audio();
    audio.srcObject = stream;
    audio.volume = 0;
    audio.play().catch(() => {});

    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;

    // Firefox may output WebRTC audio as a 2-channel stream with data only
    // in the left channel (instead of true mono).  Force the analyser to
    // collapse everything to 1 channel first so the downstream upmix works.
    analyser.channelCount = 1;
    analyser.channelCountMode = "explicit";
    analyser.channelInterpretation = "speakers";

    const gain = ctx.createGain();
    gain.gain.value = GAIN_BOOST;
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
      gain.gain.setTargetAtTime(value * GAIN_BOOST, this.ctx.currentTime, 0.01);
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
    this.guard?.destroy();
    this.guard = null;
    this.keepAliveOsc?.stop();
    this.keepAliveOsc?.disconnect();
    this.keepAliveOsc = null;
    const ids = [...this.sources.keys()];
    for (const id of ids) {
      this.removeStream(id);
    }
    this.ctx?.close();
    this.ctx = null;
  }
}

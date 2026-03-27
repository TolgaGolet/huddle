import {
  loadRnnoise,
  RnnoiseWorkletNode,
} from "@sapphi-red/web-noise-suppressor";

const GAIN_BOOST = 3.5;

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private gainNode: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private destination: MediaStreamAudioDestinationNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private rnnoiseNode: RnnoiseWorkletNode | null = null;
  private rnnoiseReady = false;
  private lockReleaser: (() => void) | null = null;
  private keepAliveHandler: (() => void) | null = null;

  private acquireKeepAlive() {
    if (navigator.locks) {
      navigator.locks.request("huddle-local-audio", () =>
        new Promise<void>((resolve) => { this.lockReleaser = resolve; }),
      );
    }
    this.keepAliveHandler = () => {
      if (this.ctx && this.ctx.state === "suspended") this.ctx.resume();
    };
    document.addEventListener("visibilitychange", this.keepAliveHandler);
    window.addEventListener("focus", this.keepAliveHandler);
  }

  private releaseKeepAlive() {
    this.lockReleaser?.();
    this.lockReleaser = null;
    if (this.keepAliveHandler) {
      document.removeEventListener("visibilitychange", this.keepAliveHandler);
      window.removeEventListener("focus", this.keepAliveHandler);
      this.keepAliveHandler = null;
    }
  }

  private getContext(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext({ sampleRate: 48000 });
      this.ctx.onstatechange = () => {
        if (this.ctx && this.ctx.state === "suspended") this.ctx.resume();
      };
      this.acquireKeepAlive();
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
    this.releaseKeepAlive();
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
  private lockReleaser: (() => void) | null = null;
  private keepAliveHandler: (() => void) | null = null;

  private acquireKeepAlive() {
    if (navigator.locks) {
      navigator.locks.request("huddle-remote-audio", () =>
        new Promise<void>((resolve) => { this.lockReleaser = resolve; }),
      );
    }
    this.keepAliveHandler = () => {
      if (this.ctx && this.ctx.state === "suspended") this.ctx.resume();
    };
    document.addEventListener("visibilitychange", this.keepAliveHandler);
    window.addEventListener("focus", this.keepAliveHandler);
  }

  private releaseKeepAlive() {
    this.lockReleaser?.();
    this.lockReleaser = null;
    if (this.keepAliveHandler) {
      document.removeEventListener("visibilitychange", this.keepAliveHandler);
      window.removeEventListener("focus", this.keepAliveHandler);
      this.keepAliveHandler = null;
    }
  }

  private getContext(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.ctx.onstatechange = () => {
        if (this.ctx && this.ctx.state === "suspended") this.ctx.resume();
      };
      this.acquireKeepAlive();
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
    this.releaseKeepAlive();
    const ids = [...this.sources.keys()];
    for (const id of ids) {
      this.removeStream(id);
    }
    this.ctx?.close();
    this.ctx = null;
  }
}

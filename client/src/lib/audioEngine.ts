import {
  loadRnnoise,
  RnnoiseWorkletNode,
} from "@sapphi-red/web-noise-suppressor";

const GAIN_BOOST = 4;

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private gainNode: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private destination: MediaStreamAudioDestinationNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private rnnoiseNode: RnnoiseWorkletNode | null = null;
  private rnnoiseReady = false;

  private getContext(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext({ sampleRate: 48000 });
      this.gainNode = this.ctx.createGain();
      this.gainNode.gain.value = GAIN_BOOST;
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 512;
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
    this.source?.disconnect();
    this.rnnoiseNode?.destroy();
    this.analyser?.disconnect();
    this.gainNode?.disconnect();
    this.ctx?.close();
    this.ctx = null;
  }
}

export class RemoteAudioManager {
  private ctx: AudioContext;
  private gains = new Map<string, GainNode>();
  private analysers = new Map<string, AnalyserNode>();
  private sources = new Map<string, MediaStreamAudioSourceNode>();

  constructor() {
    this.ctx = new AudioContext();
  }

  addStream(peerId: string, stream: MediaStream): HTMLAudioElement {
    const audio = new Audio();
    audio.srcObject = stream;
    audio.volume = 0;
    audio.autoplay = true;

    const source = this.ctx.createMediaStreamSource(stream);
    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 512;
    const gain = this.ctx.createGain();
    gain.gain.value = GAIN_BOOST;

    source.connect(analyser);
    analyser.connect(gain);
    gain.connect(this.ctx.destination);

    this.sources.set(peerId, source);
    this.analysers.set(peerId, analyser);
    this.gains.set(peerId, gain);

    return audio;
  }

  getAnalysers(): Map<string, AnalyserNode> {
    return this.analysers;
  }

  setVolume(peerId: string, value: number) {
    const gain = this.gains.get(peerId);
    if (gain) {
      gain.gain.setTargetAtTime(value * GAIN_BOOST, this.ctx.currentTime, 0.01);
    }
  }

  removeStream(peerId: string) {
    this.sources.get(peerId)?.disconnect();
    this.analysers.get(peerId)?.disconnect();
    this.gains.get(peerId)?.disconnect();
    this.sources.delete(peerId);
    this.analysers.delete(peerId);
    this.gains.delete(peerId);
  }

  destroy() {
    for (const [id] of this.sources) {
      this.removeStream(id);
    }
    this.ctx.close();
  }
}

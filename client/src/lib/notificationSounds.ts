let ctx: AudioContext | null = null;

function getContext(): AudioContext {
  if (!ctx || ctx.state === "closed") {
    ctx = new AudioContext();
  }
  return ctx;
}

function playTone(frequencies: number[], duration: number, volume = 0.15) {
  const ac = getContext();
  if (ac.state === "suspended") ac.resume();

  const gain = ac.createGain();
  gain.connect(ac.destination);
  gain.gain.setValueAtTime(volume, ac.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + duration);

  const stepDuration = duration / frequencies.length;
  frequencies.forEach((freq, i) => {
    const osc = ac.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(freq, ac.currentTime + i * stepDuration);
    osc.connect(gain);
    osc.start(ac.currentTime + i * stepDuration);
    osc.stop(ac.currentTime + (i + 1) * stepDuration);
  });
}

export function playJoinSound() {
  playTone([440, 580], 0.25, 0.12);
}

export function playLeaveSound() {
  playTone([480, 360], 0.25, 0.10);
}

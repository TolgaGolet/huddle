let ctx: AudioContext | null = null;

function getContext(): AudioContext {
  if (!ctx || ctx.state === "closed") {
    ctx = new AudioContext();
  }
  return ctx;
}

/**
 * Scales every cue together, so their relative loudness stays as tuned below.
 * Pure sines at the original levels were often lost under call audio; even
 * the loudest cue stays well under 1, so two overlapping cues can't clip.
 */
export const CUE_LOUDNESS = 3;

function playTone(frequencies: number[], duration: number, volume: number) {
  const ac = getContext();
  if (ac.state === "suspended") ac.resume();

  const gain = ac.createGain();
  gain.connect(ac.destination);
  gain.gain.setValueAtTime(volume * CUE_LOUDNESS, ac.currentTime);
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

/**
 * Urgent three-note descending cue for an unexpected disconnection
 * (transport loss), distinct from the calm two-note leave sound.
 */
export function playDisconnectedSound() {
  playTone([600, 450, 300], 0.45, 0.12);
}

export function playMuteSound() {
  playTone([520, 340], 0.14, 0.08);
}

export function playUnmuteSound() {
  playTone([340, 560], 0.14, 0.08);
}

/** Short, subtle two-note cue for an incoming chat message. */
export function playMessageSound() {
  playTone([660, 880], 0.18, 0.10);
}

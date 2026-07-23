/**
 * All sound is synthesized with the Web Audio API — no audio files.
 * The AudioContext is created on the first user gesture (Start) and kept
 * for the life of the page; iOS suspends it in the background, so we
 * resume() on visibilitychange.
 */

let ctx: AudioContext | null = null;

export function unlockAudio(): void {
  if (!ctx) {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    ctx = new Ctor();
  }
  if (ctx.state === 'suspended') void ctx.resume();
  // Play a silent tick so iOS treats the context as user-activated.
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  gain.gain.value = 0.0001;
  osc.connect(gain).connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + 0.01);
}

export function resumeAudioIfNeeded(): void {
  if (ctx && ctx.state === 'suspended') void ctx.resume();
}

interface ToneSpec {
  freq: number;
  /** seconds */
  duration: number;
  /** seconds offset from now */
  at?: number;
  volume?: number;
  type?: OscillatorType;
}

/** Short attack/release envelope on every tone so there are no clicks. */
function tone({ freq, duration, at = 0, volume = 0.5, type = 'sine' }: ToneSpec): void {
  if (!ctx) return;
  const t0 = ctx.currentTime + at;
  const attack = 0.008;
  const release = Math.min(0.06, duration / 2);
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0, t0);
  gain.gain.linearRampToValueAtTime(volume, t0 + attack);
  gain.gain.setValueAtTime(volume, t0 + duration - release);
  gain.gain.linearRampToValueAtTime(0, t0 + duration);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + duration + 0.02);
}

/** Short high blip for each countdown second (3, 2, 1). */
export function cueCountdownBeep(): void {
  tone({ freq: 1320, duration: 0.09, volume: 0.45, type: 'square' });
}

/** Longer, lower "go" tone at zero / start-set. */
export function cueGo(): void {
  tone({ freq: 620, duration: 0.35, volume: 0.6, type: 'square' });
}

/** Repeating alarm while waiting for the user to start the next set. */
export function cueAlarm(): void {
  tone({ freq: 880, duration: 0.12, volume: 0.55, type: 'square' });
  tone({ freq: 660, duration: 0.18, at: 0.14, volume: 0.6, type: 'square' });
}

/** Distinct two-tone cue when a new exercise begins. */
export function cueNewExercise(): void {
  tone({ freq: 660, duration: 0.14, volume: 0.55, type: 'triangle' });
  tone({ freq: 990, duration: 0.2, at: 0.16, volume: 0.55, type: 'triangle' });
}

/** Three-note ascending motif on workout complete. */
export function cueComplete(): void {
  tone({ freq: 523.25, duration: 0.16, volume: 0.55, type: 'triangle' }); // C5
  tone({ freq: 659.25, duration: 0.16, at: 0.18, volume: 0.55, type: 'triangle' }); // E5
  tone({ freq: 783.99, duration: 0.34, at: 0.36, volume: 0.6, type: 'triangle' }); // G5
}

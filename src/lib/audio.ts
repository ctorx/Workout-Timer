/**
 * All sound is synthesized with the Web Audio API — no audio files.
 *
 * Why sounds are scheduled ahead: browsers throttle or stop JavaScript
 * timers when the page is hidden, minimized or covered by another window,
 * but the audio clock keeps running. Cues placed on the audio timeline in
 * advance (see lib/cuePlan.ts) therefore fire on time even while the page
 * is in the background.
 *
 * Why there is a keep-alive tone: a page that is producing sound counts as
 * "playing audio", which stops Chrome (desktop and Android) from throttling
 * and freezing it. The tone is 30 Hz at about -56 dB, which is below what
 * phone speakers can reproduce and below human hearing at that pitch.
 */

let ctx: AudioContext | null = null;

function getCtor(): typeof AudioContext | undefined {
  if (typeof window === 'undefined') return undefined;
  return (
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  );
}

/** Creates or resumes the context. Call from a user gesture (tap). */
export function unlockAudio(): void {
  if (!ctx) {
    const Ctor = getCtor();
    if (!Ctor) return;
    ctx = new Ctor();
  }
  attachPendingListeners();
  if (ctx.state !== 'running') void ctx.resume().catch(() => undefined);
  // A silent blip so iOS treats the context as user-activated.
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  gain.gain.value = 0.0001;
  osc.connect(gain).connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + 0.01);
}

export function resumeAudioIfNeeded(): void {
  if (ctx && ctx.state !== 'running') void ctx.resume().catch(() => undefined);
}

export function audioIsReady(): boolean {
  return ctx !== null && ctx.state === 'running';
}

/** Calls `cb` whenever the context starts or stops running. */
export function onAudioStateChange(cb: () => void): void {
  if (ctx) ctx.addEventListener('statechange', cb);
  else pendingStateListeners.push(cb);
}
const pendingStateListeners: (() => void)[] = [];
function attachPendingListeners(): void {
  if (!ctx) return;
  while (pendingStateListeners.length > 0) ctx.addEventListener('statechange', pendingStateListeners.shift()!);
}

/* ------------------------------ tones ------------------------------- */

interface ToneSpec {
  freq: number;
  /** seconds */
  duration: number;
  /** seconds offset from the base time */
  at?: number;
  volume?: number;
  type?: OscillatorType;
}

interface Voice {
  osc: OscillatorNode;
  gain: GainNode;
  /** Audio-clock time the voice starts. */
  startAt: number;
}

/** Voices placed ahead of time; cancelled when the player state changes. */
const scheduled = new Set<Voice>();

/** Short attack/release envelope on every tone so there are no clicks. */
function tone(
  { freq, duration, at = 0, volume = 0.5, type = 'sine' }: ToneSpec,
  base?: number,
  track = false,
): void {
  if (!ctx) return;
  attachPendingListeners();
  const t0 = (base ?? ctx.currentTime) + at;
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
  if (track) {
    const voice: Voice = { osc, gain, startAt: t0 };
    scheduled.add(voice);
    osc.onended = () => scheduled.delete(voice);
  }
}

export type CueKind = 'beep' | 'go' | 'alarm' | 'new_exercise' | 'complete';

const CUES: Record<CueKind, ToneSpec[]> = {
  /** Short high blip for each countdown second. */
  beep: [{ freq: 1320, duration: 0.09, volume: 0.45, type: 'square' }],
  /** Longer, lower "go" tone. */
  go: [{ freq: 620, duration: 0.35, volume: 0.6, type: 'square' }],
  /** Repeating alarm while waiting for the user to start the next set. */
  alarm: [
    { freq: 880, duration: 0.12, volume: 0.55, type: 'square' },
    { freq: 660, duration: 0.18, at: 0.14, volume: 0.6, type: 'square' },
  ],
  /** Distinct two-tone cue when a new exercise begins. */
  new_exercise: [
    { freq: 660, duration: 0.14, volume: 0.55, type: 'triangle' },
    { freq: 990, duration: 0.2, at: 0.16, volume: 0.55, type: 'triangle' },
  ],
  /** Three-note ascending motif on workout complete. */
  complete: [
    { freq: 523.25, duration: 0.16, volume: 0.55, type: 'triangle' },
    { freq: 659.25, duration: 0.16, at: 0.18, volume: 0.55, type: 'triangle' },
    { freq: 783.99, duration: 0.34, at: 0.36, volume: 0.6, type: 'triangle' },
  ],
};

/** Plays a cue now. */
export function playCue(kind: CueKind): void {
  if (!ctx) return;
  for (const spec of CUES[kind]) tone(spec);
}

/**
 * Places a cue on the audio timeline at a wall-clock time. Cues more than
 * 300 ms in the past are dropped instead of played late.
 */
export function scheduleCue(kind: CueKind, atEpochMs: number, nowMs = Date.now()): void {
  if (!ctx) return;
  const offset = (atEpochMs - nowMs) / 1000;
  if (offset < -0.3) return;
  const base = ctx.currentTime + Math.max(0, offset);
  for (const spec of CUES[kind]) tone(spec, base, true);
}

/**
 * Removes every cue placed with scheduleCue that has not started yet.
 * A cue that is already sounding is left to finish.
 */
export function cancelScheduledCues(): void {
  const now = ctx?.currentTime ?? 0;
  for (const v of scheduled) {
    if (v.startAt <= now) continue;
    scheduled.delete(v);
    try {
      v.osc.onended = null;
      v.osc.stop();
    } catch {
      // already stopped
    }
    v.gain.disconnect();
  }
}

/* ---------------------------- keep-alive ---------------------------- */

let keepAlive: Voice | null = null;

export function startKeepAlive(): void {
  if (!ctx || keepAlive) return;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.value = 30;
  gain.gain.value = 0.0015;
  osc.connect(gain).connect(ctx.destination);
  osc.start();
  keepAlive = { osc, gain, startAt: 0 };
}

export function stopKeepAlive(): void {
  if (!keepAlive) return;
  try {
    keepAlive.osc.stop();
  } catch {
    // already stopped
  }
  keepAlive.gain.disconnect();
  keepAlive = null;
}

/* Backwards-compatible named cues (Settings uses them for a sound test). */
export const cueCountdownBeep = (): void => playCue('beep');
export const cueGo = (): void => playCue('go');
export const cueAlarm = (): void => playCue('alarm');
export const cueNewExercise = (): void => playCue('new_exercise');
export const cueComplete = (): void => playCue('complete');

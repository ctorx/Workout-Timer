/**
 * Decides which sounds belong on the audio timeline for a player state.
 * Pure function: the runtime schedules whatever this returns.
 *
 * - Rest: a tick at each configured second before the end, then the alarm
 *   at the end, repeating every ALARM_INTERVAL_MS. Between exercises the
 *   first alarm pulse is replaced by the "new exercise" chime.
 * - Alarm (awaiting_set): pulses continue from when rest ended.
 * - Every other state: silence.
 */
import type { PlayerPhase, TimerSnapshot } from '@/types';
import type { CueKind } from '@/lib/audio';

export interface CueInput {
  phase: PlayerPhase;
  timer: TimerSnapshot;
  beepsAt: number[];
  alarmIntervalMs: number;
}

export interface PlannedCue {
  kind: CueKind;
  atMs: number;
}

/** Cues with atMs in [fromMs, toMs), in time order. */
export function planCues(input: CueInput, fromMs: number, toMs: number): PlannedCue[] {
  const { phase, timer, beepsAt, alarmIntervalMs } = input;
  const out: PlannedCue[] = [];
  const push = (kind: CueKind, atMs: number) => {
    if (atMs >= fromMs && atMs < toMs) out.push({ kind, atMs });
  };
  const alarmsFrom = (startMs: number, firstPulse: number) => {
    const first = Math.max(firstPulse, Math.ceil((fromMs - startMs) / alarmIntervalMs));
    for (let k = first; ; k++) {
      const at = startMs + k * alarmIntervalMs;
      if (at >= toMs) break;
      push('alarm', at);
    }
  };

  if ((phase === 'rest_set' || phase === 'rest_exercise') && timer.kind === 'countdown' && timer.endsAt !== null) {
    const end = timer.endsAt;
    for (const b of [...beepsAt].sort((a, z) => z - a)) {
      if (b > 0) push('beep', end - b * 1000);
    }
    if (phase === 'rest_exercise') {
      push('new_exercise', end);
      alarmsFrom(end, 1);
    } else {
      alarmsFrom(end, 0);
    }
  } else if (phase === 'awaiting_set' && timer.kind === 'elapsed' && timer.startedAt !== null) {
    alarmsFrom(timer.startedAt, 0);
  }
  return out.sort((a, b) => a.atMs - b.atMs);
}

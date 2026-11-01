import { describe, expect, it } from 'vitest';
import { planCues, type CueInput } from '@/lib/cuePlan';
import type { TimerSnapshot } from '@/types';

const END = 100_000;

function countdown(endsAt: number): TimerSnapshot {
  return { kind: 'countdown', endsAt, duration: 60_000, startedAt: null, pausedRemaining: null, pausedElapsed: null };
}

function input(over: Partial<CueInput>): CueInput {
  return { phase: 'rest_set', timer: countdown(END), beepsAt: [3, 2, 1], alarmIntervalMs: 1000, ...over };
}

describe('planCues', () => {
  it('rest between sets: ticks before the end, then a repeating alarm', () => {
    const cues = planCues(input({}), 0, END + 2_500);
    expect(cues).toEqual([
      { kind: 'beep', atMs: END - 3000 },
      { kind: 'beep', atMs: END - 2000 },
      { kind: 'beep', atMs: END - 1000 },
      { kind: 'alarm', atMs: END },
      { kind: 'alarm', atMs: END + 1000 },
      { kind: 'alarm', atMs: END + 2000 },
    ]);
  });

  it('rest between exercises: chime at the end, alarm from one second later', () => {
    const cues = planCues(input({ phase: 'rest_exercise' }), END - 500, END + 1_500);
    expect(cues).toEqual([
      { kind: 'new_exercise', atMs: END },
      { kind: 'alarm', atMs: END + 1000 },
    ]);
  });

  it('alarm state keeps pulsing from when rest ended', () => {
    const timer: TimerSnapshot = {
      kind: 'elapsed',
      endsAt: null,
      duration: null,
      startedAt: END,
      pausedRemaining: null,
      pausedElapsed: null,
    };
    const cues = planCues(input({ phase: 'awaiting_set', timer }), END + 1_500, END + 4_000);
    expect(cues.map((c) => c.atMs)).toEqual([END + 2000, END + 3000]);
  });

  it('only returns cues inside the window', () => {
    expect(planCues(input({}), END - 1_500, END - 500)).toEqual([{ kind: 'beep', atMs: END - 1000 }]);
  });

  it('is silent while working, ready, paused or complete', () => {
    for (const phase of ['set_active', 'ready', 'paused', 'complete'] as const) {
      expect(planCues(input({ phase }), 0, END * 2)).toEqual([]);
    }
  });
});

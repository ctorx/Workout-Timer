import { describe, expect, it } from 'vitest';
import {
  computeStreaks,
  computeProgressions,
  sessionsInLastDays,
  sessionVolume,
  formatVolume,
  sessionCompletionPercent,
} from '@/lib/stats';
import type { Session } from '@/types';

function makeSession(overrides: Partial<Session>): Session {
  return {
    id: Math.random().toString(36).slice(2),
    workoutId: 'w-1',
    workoutName: 'Push A',
    startedAt: '2026-07-20T10:00:00.000Z',
    endedAt: '2026-07-20T10:40:00.000Z',
    status: 'completed',
    durationSeconds: 2400,
    totalRestSeconds: 600,
    exercises: [],
    ...overrides,
  };
}

function withSets(weight: number, unit: 'lb' | 'kg', reps: number[]): Session['exercises'] {
  return [
    {
      exerciseId: 'e-1',
      name: 'Bench Press',
      targetSets: reps.length,
      outcome: 'completed',
      sets: reps.map((r, i) => ({
        setIndex: i,
        targetReps: 8,
        actualReps: r,
        weight,
        unit,
        outcome: r > 0 ? ('completed' as const) : ('skipped' as const),
        startedAt: '2026-07-20T10:00:00.000Z',
        completedAt: '2026-07-20T10:01:00.000Z',
        workSeconds: 30,
        restSeconds: 60,
      })),
    },
  ];
}

describe('volume', () => {
  it('sums weight × actual reps per unit, keeping units separate', () => {
    const s = makeSession({
      exercises: [...withSets(100, 'lb', [8, 8]), ...withSets(40, 'kg', [10])],
    });
    const v = sessionVolume(s);
    expect(v.lb).toBe(1600);
    expect(v.kg).toBe(400);
    expect(formatVolume(v)).toBe('1,600 lb + 400 kg');
  });

  it('completion percent counts completed sets against targets', () => {
    const s = makeSession({ exercises: withSets(100, 'lb', [8, 0, 8, 8]) });
    expect(sessionCompletionPercent(s)).toBe(75);
  });
});

describe('streaks', () => {
  // Sundays anchor the weeks: 2026-07-19, 2026-07-12, 2026-07-05 are Sundays.
  const now = new Date('2026-07-23T12:00:00');

  it('counts consecutive weeks with a completed non-optional workout', () => {
    const sessions = [
      makeSession({ startedAt: '2026-07-21T10:00:00' }), // this week
      makeSession({ startedAt: '2026-07-14T10:00:00' }), // last week
      makeSession({ startedAt: '2026-07-07T10:00:00' }), // two weeks ago
      makeSession({ startedAt: '2026-06-01T10:00:00' }), // long ago (broken)
    ];
    const { current, longest } = computeStreaks(sessions, new Set(), now);
    expect(current).toBe(3);
    expect(longest).toBe(3);
  });

  it('a streak survives when this week has no session yet', () => {
    const sessions = [makeSession({ startedAt: '2026-07-14T10:00:00' })];
    expect(computeStreaks(sessions, new Set(), now).current).toBe(1);
  });

  it('ignores optional workouts and abandoned sessions', () => {
    const sessions = [
      makeSession({ startedAt: '2026-07-21T10:00:00', workoutId: 'opt-1' }),
      makeSession({ startedAt: '2026-07-20T10:00:00', status: 'abandoned' }),
    ];
    expect(computeStreaks(sessions, new Set(['opt-1']), now).current).toBe(0);
  });
});

describe('recent counts', () => {
  it('counts completed sessions in the window', () => {
    const now = new Date('2026-07-23T12:00:00');
    const sessions = [
      makeSession({ startedAt: '2026-07-22T10:00:00' }),
      makeSession({ startedAt: '2026-07-10T10:00:00' }),
      makeSession({ startedAt: '2026-05-01T10:00:00' }),
      makeSession({ startedAt: '2026-07-21T10:00:00', status: 'abandoned' }),
    ];
    expect(sessionsInLastDays(sessions, 7, now)).toBe(1);
    expect(sessionsInLastDays(sessions, 30, now)).toBe(2);
  });
});

describe('per-exercise progression', () => {
  it('tracks heaviest weight, best set volume and a per-session series', () => {
    const s1 = makeSession({
      id: 'a',
      startedAt: '2026-07-01T10:00:00',
      exercises: withSets(100, 'lb', [8, 8]),
    });
    const s2 = makeSession({
      id: 'b',
      startedAt: '2026-07-08T10:00:00',
      exercises: withSets(110, 'lb', [8, 6]),
    });
    const [p] = computeProgressions([s2, s1]);
    expect(p!.name).toBe('Bench Press');
    expect(p!.heaviestWeight).toBe(110);
    expect(p!.bestSetVolume).toBe(110 * 8);
    expect(p!.volumeSeries.map((v) => v.volume)).toEqual([1600, 110 * 14]);
    expect(p!.sessionCount).toBe(2);
  });

  it('skipped sets contribute nothing', () => {
    const s = makeSession({ exercises: withSets(100, 'lb', [0, 0]) });
    expect(computeProgressions([s])).toHaveLength(0);
  });
});

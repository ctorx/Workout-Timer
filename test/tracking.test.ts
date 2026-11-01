import { describe, expect, it } from 'vitest';
import {
  e1rm,
  exerciseBests,
  exerciseHistory,
  formatPerformance,
  isPersonalRecord,
  lastPerformance,
  readyToProgress,
} from '@/lib/stats';
import type { Session, SetLog } from '@/types';

function set(setIndex: number, weight: number, reps: number): SetLog {
  return {
    setIndex,
    targetReps: 8,
    actualReps: reps,
    weight,
    unit: 'lb',
    outcome: reps > 0 ? 'completed' : 'skipped',
    startedAt: '2026-10-01T10:00:00.000Z',
    completedAt: '2026-10-01T10:00:30.000Z',
    workSeconds: 30,
    restSeconds: 90,
  };
}

function session(id: string, date: string, sets: SetLog[], name = 'Flat DB Press'): Session {
  return {
    id,
    workoutId: 'w',
    workoutName: 'Upper A',
    startedAt: date,
    endedAt: date,
    status: 'completed',
    durationSeconds: 1800,
    totalRestSeconds: 600,
    exercises: [{ exerciseId: 'e-press', name, targetSets: 4, sets, outcome: 'completed' }],
  };
}

const older = session('s1', '2026-10-20T10:00:00.000Z', [set(0, 120, 6), set(1, 120, 6), set(2, 120, 6), set(3, 120, 5)]);
const newer = session('s2', '2026-10-27T10:00:00.000Z', [set(0, 120, 7), set(1, 120, 6), set(2, 120, 6), set(3, 120, 6)]);

describe('strength tracking', () => {
  it('estimates a one-rep max that rises with reps or weight', () => {
    expect(e1rm(100, 0)).toBe(0);
    expect(e1rm(0, 10)).toBe(0);
    expect(e1rm(120, 7)).toBeGreaterThan(e1rm(120, 6));
    expect(e1rm(130, 6)).toBeGreaterThan(e1rm(120, 6));
  });

  it('finds the most recent performance and formats it compactly', () => {
    const last = lastPerformance([older, newer], 'e-press', 'Flat DB Press');
    expect(last?.sessionId).toBe('s2');
    expect(formatPerformance(last!.sets)).toBe('120 × 7 · 6 · 6 · 6');
  });

  it('excludes the session in progress and matches by name when ids differ', () => {
    const last = lastPerformance([older, newer], 'other-id', 'flat db press', 's2');
    expect(last?.sessionId).toBe('s1');
  });

  it('flags a record only when it beats earlier history', () => {
    const bests = exerciseBests([older], 'e-press', 'Flat DB Press');
    expect(isPersonalRecord(set(0, 120, 7), bests)).toBe(true);
    expect(isPersonalRecord(set(0, 120, 6), bests)).toBe(false);
    expect(isPersonalRecord(set(0, 120, 7), exerciseBests([], 'e-press', 'Flat DB Press'))).toBe(false);
  });

  it('bodyweight records compare reps', () => {
    const bw = session('b1', '2026-10-20T10:00:00.000Z', [set(0, 0, 10), set(1, 0, 12)], 'Pullups');
    const bests = exerciseBests([bw], null, 'Pullups');
    expect(isPersonalRecord(set(0, 0, 13), bests)).toBe(true);
    expect(isPersonalRecord(set(0, 0, 12), bests)).toBe(false);
  });

  it('is ready to add weight only when every planned set hits the target at one weight', () => {
    expect(readyToProgress([set(0, 120, 8), set(1, 120, 8), set(2, 120, 9), set(3, 120, 8)], 4, 8)).toBe(true);
    expect(readyToProgress([set(0, 120, 8), set(1, 120, 8), set(2, 120, 8), set(3, 120, 7)], 4, 8)).toBe(false);
    expect(readyToProgress([set(0, 120, 8), set(1, 120, 8), set(2, 120, 8)], 4, 8)).toBe(false);
    expect(readyToProgress([set(0, 120, 8), set(1, 110, 8)], 2, 8)).toBe(false);
  });

  it('builds a per-session history for an exercise, oldest first', () => {
    const h = exerciseHistory([newer, older], 'Flat DB Press');
    expect(h.map((p) => p.sessionId)).toEqual(['s1', 's2']);
    expect(h[1]!.totalReps).toBe(25);
    expect(h[1]!.bestE1rm).toBeCloseTo(e1rm(120, 7));
  });
});

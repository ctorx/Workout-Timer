import { describe, expect, it } from 'vitest';
import {
  exerciseHistory,
  formatLoad,
  formatRepTarget,
  isPlateau,
  progressionAdvice,
  repRange,
  weightStepFor,
} from '@/lib/stats';
import { validateExercise } from '@/lib/validation';
import { parseImportFile } from '@/lib/importExport';
import type { Exercise, Session, SetLog } from '@/types';

const SETTINGS = { weightStepLb: 5, weightStepKg: 2.5 };

function exercise(over: Partial<Exercise> = {}): Exercise {
  return {
    id: 'e',
    name: 'Flat DB Press',
    weight: 120,
    unit: 'lb',
    sets: 4,
    targetReps: 8,
    repsMax: 12,
    pairedDumbbells: true,
    restBetweenSets: 90,
    restAfterExercise: 120,
    ...over,
  };
}

function sets(weight: number, reps: number[], rir?: (number | undefined)[]): SetLog[] {
  return reps.map((r, i) => {
    const s: SetLog = {
      setIndex: i,
      targetReps: 8,
      actualReps: r,
      weight,
      unit: 'lb',
      outcome: r > 0 ? 'completed' : 'skipped',
      startedAt: '2026-10-01T10:00:00.000Z',
      completedAt: '2026-10-01T10:00:30.000Z',
      workSeconds: 30,
      restSeconds: 90,
    };
    const v = rir?.[i];
    if (v !== undefined) s.rir = v;
    return s;
  });
}

describe('rep range and weight step', () => {
  it('a missing top of range means a single target', () => {
    expect(repRange({ targetReps: 8 })).toEqual({ min: 8, max: 8 });
    expect(formatRepTarget({ targetReps: 8 })).toBe('8');
    expect(formatRepTarget({ targetReps: 8, repsMax: 12 })).toBe('8–12');
  });

  it('pairs of dumbbells step by two dumbbell sizes unless the exercise sets its own step', () => {
    expect(weightStepFor({ unit: 'lb', pairedDumbbells: true }, SETTINGS)).toBe(10);
    expect(weightStepFor({ unit: 'lb' }, SETTINGS)).toBe(5);
    expect(weightStepFor({ unit: 'kg', pairedDumbbells: true }, SETTINGS)).toBe(5);
    expect(weightStepFor({ unit: 'lb', pairedDumbbells: true, weightStep: 20 }, SETTINGS)).toBe(20);
  });

  it('shows the per-dumbbell weight for pairs', () => {
    expect(formatLoad(120, { unit: 'lb', pairedDumbbells: true })).toBe('120 lb (2 × 60)');
    expect(formatLoad(35, { unit: 'lb' })).toBe('35 lb');
    expect(formatLoad(0, { unit: 'lb' })).toBe('Bodyweight');
  });
});

describe('double progression advice', () => {
  const ex = exercise();
  const step = weightStepFor(ex, SETTINGS);

  it('works up through the range before adding weight', () => {
    const a = progressionAdvice(sets(120, [6, 6, 6, 5]), ex, step);
    expect(a?.kind).toBe('build');
    if (a?.kind === 'build') {
      expect(a.goal).toBe(12);
      expect(a.lowest).toBe(5);
    }
  });

  it('adds one step when every set reaches the top of the range', () => {
    const a = progressionAdvice(sets(120, [12, 12, 13, 12], [2, 2, 1, 1]), ex, step);
    expect(a).toMatchObject({ kind: 'increase', from: 120, to: 130 });
    expect(a?.message).toContain('130 lb (2 × 65)');
    expect(a?.message).toContain('aim for 8+ reps');
  });

  it('repeats the weight when a top-of-range set was taken to failure', () => {
    const a = progressionAdvice(sets(120, [12, 12, 12, 12], [2, 1, 1, 0]), ex, step);
    expect(a?.kind).toBe('repeat');
  });

  it('treats unlogged effort as not to failure', () => {
    const a = progressionAdvice(sets(120, [12, 12, 12, 12]), ex, step);
    expect(a?.kind).toBe('increase');
  });

  it('a single target behaves like a range of one', () => {
    const single = exercise({ repsMax: undefined, pairedDumbbells: undefined, weight: 35 });
    expect(progressionAdvice(sets(35, [8, 8, 8, 8]), single, 5)).toMatchObject({ kind: 'increase', to: 40 });
  });

  it('gives no advice when sets are missing or weights are mixed', () => {
    expect(progressionAdvice(sets(120, [12, 12, 12]), ex, step)).toBeNull();
    const mixed = [...sets(120, [12, 12]), ...sets(110, [12, 12]).map((s, i) => ({ ...s, setIndex: i + 2 }))];
    expect(progressionAdvice(mixed, ex, step)).toBeNull();
  });

  it('bodyweight exercises suggest raising the range instead of a weight', () => {
    const bw = exercise({ weight: 0, targetReps: 10, repsMax: 15, pairedDumbbells: undefined, sets: 3 });
    expect(progressionAdvice(sets(0, [15, 16, 15]), bw, 5)?.kind).toBe('raise-reps');
  });
});

describe('plateau detection', () => {
  function session(id: string, day: number, weight: number, reps: number[]): Session {
    return {
      id,
      workoutId: 'w',
      workoutName: 'Upper A',
      startedAt: `2026-10-${String(day).padStart(2, '0')}T10:00:00.000Z`,
      endedAt: null,
      status: 'completed',
      durationSeconds: 1,
      totalRestSeconds: 0,
      exercises: [{ exerciseId: 'e', name: 'Flat DB Press', targetSets: 4, sets: sets(weight, reps), outcome: 'completed' }],
    };
  }

  it('needs four sessions and flags three without a new best', () => {
    const base = [session('a', 1, 120, [8, 8, 8, 8])];
    const flat = [session('b', 4, 120, [8, 7, 7, 7]), session('c', 8, 120, [8, 8, 7, 7]), session('d', 11, 120, [7, 7, 7, 7])];
    expect(isPlateau(exerciseHistory(flat, 'Flat DB Press'))).toBe(false);
    expect(isPlateau(exerciseHistory([...base, ...flat], 'Flat DB Press'))).toBe(true);
    const better = [...flat.slice(0, 2), session('e', 11, 120, [9, 8, 8, 8])];
    expect(isPlateau(exerciseHistory([...base, ...better], 'Flat DB Press'))).toBe(false);
  });
});

describe('editing and importing the new fields', () => {
  it('rejects a range whose top is below the bottom', () => {
    expect(validateExercise(exercise({ repsMax: 6 })).targetReps).toBeDefined();
    expect(validateExercise(exercise()).targetReps).toBeUndefined();
    expect(validateExercise(exercise({ weightStep: 0 })).weight).toBeDefined();
  });

  it('imports files with and without the new fields', () => {
    const file = (ex: Partial<Exercise>) =>
      JSON.stringify({
        app: 'workout-timer',
        schemaVersion: 1,
        exportedAt: '2026-11-01T00:00:00.000Z',
        kind: 'workouts',
        settings: null,
        sessions: null,
        workouts: [
          {
            id: 'w',
            name: 'Upper A',
            dayOfWeek: 1,
            optional: false,
            order: 0,
            createdAt: 'x',
            updatedAt: 'x',
            exercises: [{ ...exercise(), ...ex }],
          },
        ],
      });
    expect(() => parseImportFile(file({ repsMax: undefined, pairedDumbbells: undefined }))).not.toThrow();
    expect(() => parseImportFile(file({ weightStep: 10 }))).not.toThrow();
    expect(() => parseImportFile(file({ pairedDumbbells: 'yes' as unknown as boolean }))).toThrow();
  });
});

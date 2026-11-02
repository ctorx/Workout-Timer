import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import {
  bodyLoadFor,
  exerciseBests,
  exerciseHistory,
  formatLoad,
  formatPerformance,
  formatSetWeight,
  isPersonalRecord,
  progressionAdvice,
  resolveBodyLoads,
  sessionVolume,
  setLoad,
} from '@/lib/stats';
import { validateExercise } from '@/lib/validation';
import { parseImportFile } from '@/lib/importExport';
import { usePlayerStore } from '@/stores/player';
import { useSettingsStore } from '@/stores/settings';
import type { Exercise, Session, SetLog, Workout } from '@/types';

const BW = { bodyweight: 180, bodyweightUnit: 'lb' as const };

function pullUp(over: Partial<Exercise> = {}): Exercise {
  return {
    id: 'pu',
    name: 'Pull-up',
    weight: 0,
    unit: 'lb',
    sets: 3,
    targetReps: 6,
    repsMax: 10,
    bodyweightShare: 1,
    restBetweenSets: 90,
    restAfterExercise: 120,
    ...over,
  };
}

function set(weight: number, reps: number, extra: Partial<SetLog> = {}): SetLog {
  return {
    setIndex: 0,
    targetReps: 6,
    actualReps: reps,
    weight,
    unit: 'lb',
    outcome: reps > 0 ? 'completed' : 'skipped',
    startedAt: '2026-10-01T10:00:00.000Z',
    completedAt: '2026-10-01T10:00:30.000Z',
    workSeconds: 30,
    restSeconds: 90,
    ...extra,
  };
}

function session(id: string, date: string, sets: SetLog[], share?: number): Session {
  return {
    id,
    workoutId: 'w',
    workoutName: 'Pull day',
    startedAt: date,
    endedAt: date,
    status: 'completed',
    exercises: [
      {
        exerciseId: 'pu',
        name: 'Pull-up',
        targetSets: sets.length,
        ...(share ? { bodyweightShare: share } : {}),
        sets: sets.map((s, i) => ({ ...s, setIndex: i })),
        outcome: 'completed',
      },
    ],
    durationSeconds: 600,
    totalRestSeconds: 300,
  };
}

describe('bodyweight load', () => {
  it('is bodyweight times share, converted to the exercise unit', () => {
    expect(bodyLoadFor(1, 'lb', BW)).toBe(180);
    expect(bodyLoadFor(0.65, 'lb', BW)).toBe(117);
    expect(bodyLoadFor(1, 'kg', BW)).toBeCloseTo(81.6, 1);
    expect(bodyLoadFor(1, 'lb', { bodyweight: 0, bodyweightUnit: 'lb' })).toBeUndefined();
    expect(bodyLoadFor(undefined, 'lb', BW)).toBeUndefined();
  });

  it('adds added weight and subtracts assistance', () => {
    expect(setLoad(set(25, 5, { bodyLoad: 180 }))).toBe(205);
    expect(setLoad(set(-40, 5, { bodyLoad: 180 }))).toBe(140);
    expect(setLoad(set(135, 5))).toBe(135);
  });

  it('reads clearly', () => {
    const ex = pullUp();
    expect(formatLoad(0, ex)).toBe('Bodyweight');
    expect(formatLoad(25, ex)).toBe('Bodyweight + 25 lb');
    expect(formatLoad(-40, ex)).toBe('40 lb assist');
    expect(formatSetWeight(set(25, 5, { bodyLoad: 180 }))).toBe('BW+25 lb');
    expect(formatSetWeight(set(-40, 5))).toBe('BW−40 lb');
    expect(formatSetWeight(set(0, 5, { bodyLoad: 180 }))).toBe('BW');
    expect(formatSetWeight(set(135, 5))).toBe('135 lb');
    expect(formatPerformance([set(25, 6, { bodyLoad: 180 }), set(25, 5, { bodyLoad: 180 })])).toBe('BW+25 × 6 · 5');
    expect(formatPerformance([set(0, 8, { bodyLoad: 180 }), set(0, 7, { bodyLoad: 180 })])).toBe('8 · 7');
  });
});

describe('history with bodyweight', () => {
  // Old sessions were logged before the exercise was marked as bodyweight.
  const sessions = [
    session('a', '2026-09-01T10:00:00.000Z', [set(-40, 8), set(-40, 8)]),
    session('b', '2026-09-08T10:00:00.000Z', [set(0, 6), set(0, 5)]),
    session('c', '2026-09-15T10:00:00.000Z', [set(25, 5, { bodyLoad: 175 })], 1),
  ];
  const resolved = resolveBodyLoads(sessions, () => 1, BW);

  it('fills in older sets from the current bodyweight, but keeps a captured one', () => {
    expect(resolved[0]!.exercises[0]!.sets[0]!.bodyLoad).toBe(180);
    expect(resolved[2]!.exercises[0]!.sets[0]!.bodyLoad).toBe(175);
    // Stored sessions are untouched.
    expect(sessions[0]!.exercises[0]!.sets[0]!.bodyLoad).toBeUndefined();
  });

  it('does nothing without a bodyweight or for plain exercises', () => {
    expect(resolveBodyLoads(sessions, () => 1, { bodyweight: 0, bodyweightUnit: 'lb' })).toBe(sessions);
    expect(resolveBodyLoads(sessions, () => undefined, BW)[0]).toBe(sessions[0]);
  });

  it('keeps one continuous trend from assisted to weighted', () => {
    const h = exerciseHistory(resolved, 'Pull-up');
    expect(h.map((p) => p.topWeight)).toEqual([140, 180, 200]);
    expect(h.every((p) => p.bestE1rm > 0)).toBe(true);
    expect(h[2]!.bestE1rm).toBeGreaterThan(h[1]!.bestE1rm);
  });

  it('counts bodyweight in volume and records', () => {
    expect(sessionVolume(resolved[1]!).lb).toBe(180 * 11);
    const bests = exerciseBests(resolved.slice(0, 2), 'pu', 'Pull-up');
    expect(isPersonalRecord(set(25, 5, { bodyLoad: 180 }), bests)).toBe(true);
    expect(isPersonalRecord(set(-40, 5, { bodyLoad: 180 }), bests)).toBe(false);
  });
});

describe('advice for bodyweight exercises', () => {
  it('assisted sets step toward no assistance, never past it', () => {
    const ex = pullUp({ weight: -40 });
    const top = [set(-40, 10), set(-40, 10), set(-40, 10)];
    expect(progressionAdvice(top, ex, 15)).toMatchObject({ kind: 'increase', to: -25 });
    const nearly = [set(-5, 10), set(-5, 10), set(-5, 10)];
    expect(progressionAdvice(nearly, ex, 15)).toMatchObject({ kind: 'increase', to: 0 });
  });

  it('added weight steps up like any weighted lift', () => {
    const top = [set(25, 10), set(25, 10), set(25, 10)];
    expect(progressionAdvice(top, pullUp({ weight: 25 }), 5)).toMatchObject({ kind: 'increase', to: 30 });
  });

  it('plain bodyweight still suggests raising the range', () => {
    const top = [set(0, 10), set(0, 10), set(0, 10)];
    expect(progressionAdvice(top, pullUp(), 5)?.kind).toBe('raise-reps');
  });
});

describe('editing and importing bodyweight exercises', () => {
  it('allows negative weight only on bodyweight exercises', () => {
    expect(validateExercise(pullUp({ weight: -40 })).weight).toBeUndefined();
    expect(validateExercise(pullUp({ weight: -40, bodyweightShare: undefined })).weight).toBeDefined();
    expect(validateExercise(pullUp({ bodyweightShare: 1.5 })).bodyweightShare).toBeDefined();
    expect(validateExercise(pullUp({ bodyweightShare: 0.65 })).bodyweightShare).toBeUndefined();
  });

  it('imports bodyweight fields', () => {
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
            name: 'Pull day',
            dayOfWeek: 1,
            optional: false,
            order: 0,
            createdAt: 'x',
            updatedAt: 'x',
            exercises: [{ ...pullUp(), ...ex }],
          },
        ],
      });
    expect(() => parseImportFile(file({ weight: -40 }))).not.toThrow();
    expect(() => parseImportFile(file({ weight: -40, bodyweightShare: undefined }))).toThrow();
    expect(() => parseImportFile(file({ bodyweightShare: 2 }))).toThrow();
  });
});

describe('the player captures bodyweight on each set', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  const T0 = 1_000_000_000;
  const workout: Workout = {
    id: 'w',
    name: 'Pull day',
    dayOfWeek: 1,
    optional: false,
    order: 0,
    createdAt: new Date(T0).toISOString(),
    updatedAt: new Date(T0).toISOString(),
    exercises: [pullUp({ sets: 2, weight: -40 })],
  };

  it('logs added or assisted weight with the bodyweight part', () => {
    useSettingsStore().update({ bodyweight: 180, bodyweightUnit: 'lb' });
    const p = usePlayerStore();
    p.start(workout, T0);
    expect(p.session!.exercises[0]!.bodyweightShare).toBe(1);
    p.completeSet(T0 + 30_000);
    p.setPendingWeight(-30);
    p.endRest(T0 + 60_000);
    const logged = p.session!.exercises[0]!.sets[0]!;
    expect(logged.weight).toBe(-30);
    expect(logged.bodyLoad).toBe(180);
  });

  it('leaves the bodyweight part out when no bodyweight is set', () => {
    const p = usePlayerStore();
    p.start(workout, T0);
    p.completeSet(T0 + 30_000);
    p.endRest(T0 + 60_000);
    const logged = p.session!.exercises[0]!.sets[0]!;
    expect(logged.weight).toBe(-40);
    expect(logged.bodyLoad).toBeUndefined();
  });
});

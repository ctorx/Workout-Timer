import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { ALARM_INTERVAL_MS, usePlayerStore } from '@/stores/player';
import { useSessionsStore } from '@/stores/sessions';
import type { PersistedPlayerState, Workout } from '@/types';
import { SCHEMA_VERSION } from '@/types';
import { sessionVolume } from '@/lib/stats';

const T0 = 1_000_000_000;

function makeWorkout(overrides: Partial<Workout> = {}): Workout {
  return {
    id: 'w1',
    name: 'Test workout',
    dayOfWeek: 1,
    optional: false,
    order: 0,
    createdAt: new Date(T0).toISOString(),
    updatedAt: new Date(T0).toISOString(),
    exercises: [
      {
        id: 'e1',
        name: 'Bench press',
        weight: 100,
        unit: 'lb',
        sets: 2,
        targetReps: 8,
        restBetweenSets: 60,
        restAfterExercise: 120,
      },
      {
        id: 'e2',
        name: 'Push-up',
        weight: 0,
        unit: 'lb',
        sets: 1,
        targetReps: 5,
        restBetweenSets: 30,
        restAfterExercise: 90, // last exercise: must never run
      },
    ],
    ...overrides,
  };
}

/** Start workout and begin the first set. */
function beginFirstSet(p: ReturnType<typeof usePlayerStore>, w = makeWorkout()): number {
  p.start(w, T0);
  expect(p.phase).toBe('awaiting_set');
  p.startNextSet(T0 + 1000);
  expect(p.phase).toBe('set_active');
  return T0 + 1000;
}

beforeEach(() => {
  setActivePinia(createPinia());
});

describe('start', () => {
  it('opens on awaiting_set; Start next set begins work', () => {
    const p = usePlayerStore();
    expect(p.start(makeWorkout(), T0)).toBe(true);
    expect(p.phase).toBe('awaiting_set');
    p.startNextSet(T0 + 500);
    expect(p.phase).toBe('set_active');
    p.tick(T0 + 1500);
    expect(p.elapsedMs).toBe(1000);
  });

  it('refuses to start an empty workout', () => {
    const p = usePlayerStore();
    expect(p.start(makeWorkout({ exercises: [] }), T0)).toBe(false);
    expect(p.phase).toBe('idle');
  });
});

describe('the full happy path', () => {
  it('walks a two-exercise workout with manual start after each rest', () => {
    const p = usePlayerStore();
    let t = beginFirstSet(p);

    // set 1
    t += 30_000;
    p.completeSet(t);
    expect(p.phase).toBe('rest_set');
    expect(p.setIndex).toBe(1);

    // rest ends → awaiting_set (does NOT auto-start work)
    t += 60_000;
    p.tick(t);
    expect(p.phase).toBe('awaiting_set');
    expect(p.session!.exercises[0]!.sets[0]).toMatchObject({
      actualReps: 8,
      restSeconds: 60,
      outcome: 'completed',
    });

    // user stops the alarm and starts set 2
    p.startNextSet(t + 2000);
    expect(p.phase).toBe('set_active');

    t += 2000 + 25_000;
    p.completeSet(t);
    expect(p.phase).toBe('rest_exercise');

    t += 120_000;
    p.tick(t);
    expect(p.phase).toBe('awaiting_set');
    expect(p.exerciseIndex).toBe(1);

    p.startNextSet(t + 500);
    t += 500 + 20_000;
    p.completeSet(t);
    expect(p.phase).toBe('complete');

    const s = p.session!;
    expect(s.status).toBe('completed');
    expect(s.exercises[0]!.sets).toHaveLength(2);
    expect(s.exercises[1]!.sets).toHaveLength(1);
    expect(s.exercises[1]!.sets[0]!.restSeconds).toBe(0);
    expect(sessionVolume(s).lb).toBe(100 * 8 * 2);
  });
});

describe('rest never auto-starts the next set', () => {
  it('rest expiry parks on awaiting_set until Start next set', () => {
    const p = usePlayerStore();
    const t = beginFirstSet(p);
    p.completeSet(t + 10_000);
    p.setReps(6);
    p.tick(t + 10_000 + 60_000);
    expect(p.phase).toBe('awaiting_set');
    expect(p.session!.exercises[0]!.sets[0]!.actualReps).toBe(6);
    // still waiting — work has not started
    p.tick(t + 10_000 + 60_000 + 30_000);
    expect(p.phase).toBe('awaiting_set');
    p.startNextSet(t + 10_000 + 60_000 + 30_000);
    expect(p.phase).toBe('set_active');
  });

  it('zero rest also waits for Start next set', () => {
    const w = makeWorkout();
    w.exercises[0]!.restBetweenSets = 0;
    const p = usePlayerStore();
    const t = beginFirstSet(p, w);
    p.completeSet(t + 10_000);
    expect(p.phase).toBe('awaiting_set');
    expect(p.setIndex).toBe(1);
  });
});

describe('alarm during awaiting_set', () => {
  it('re-fires alarm pulses until the user starts the set', () => {
    const p = usePlayerStore();
    const events: string[] = [];
    p.onEvent((e) => events.push(e));
    p.start(makeWorkout(), T0);
    events.length = 0;
    // enterAwaitingSet from rest
    p.startNextSet(T0);
    p.completeSet(T0 + 10_000);
    events.length = 0;
    p.tick(T0 + 10_000 + 60_000); // rest ends → alarm
    expect(events.filter((e) => e === 'alarm').length).toBeGreaterThanOrEqual(1);

    const awaitStart = T0 + 10_000 + 60_000;
    events.length = 0;
    p.tick(awaitStart + ALARM_INTERVAL_MS + 10);
    p.tick(awaitStart + ALARM_INTERVAL_MS * 2 + 10);
    expect(events.filter((e) => e === 'alarm').length).toBeGreaterThanOrEqual(2);

    events.length = 0;
    p.startNextSet(awaitStart + ALARM_INTERVAL_MS * 3);
    expect(p.phase).toBe('set_active');
    p.tick(awaitStart + ALARM_INTERVAL_MS * 5);
    expect(events.filter((e) => e === 'alarm')).toHaveLength(0);
  });
});

describe('countdown beeps from 5 seconds', () => {
  it('beeps at 5, 4, 3, 2, 1 during rest', () => {
    const p = usePlayerStore();
    const events: string[] = [];
    p.onEvent((e) => events.push(e));
    const t = beginFirstSet(p);
    p.completeSet(t + 10_000);
    events.length = 0;
    const restStart = t + 10_000;
    for (let ms = 54_000; ms <= 60_100; ms += 100) p.tick(restStart + ms);
    expect(events.filter((e) => e === 'beep')).toHaveLength(5);
  });
});

describe('pause and resume', () => {
  it('freezes a rest countdown and resumes with the same remaining time', () => {
    const p = usePlayerStore();
    const t = beginFirstSet(p);
    p.completeSet(t + 10_000);
    const restStart = t + 10_000;
    p.tick(restStart + 40_000);
    p.pause(restStart + 40_000);
    expect(p.remainingMs).toBe(20_000);
    p.tick(restStart + 1_000_000);
    expect(p.remainingMs).toBe(20_000);
    const resumeAt = restStart + 2_000_000;
    p.resume(resumeAt);
    p.tick(resumeAt + 20_000);
    expect(p.phase).toBe('awaiting_set');
  });
});

describe('backgrounded rest expiry', () => {
  it('a rest that expired while backgrounded lands on awaiting_set', () => {
    const p = usePlayerStore();
    const t = beginFirstSet(p);
    p.completeSet(t + 10_000);
    const restStart = t + 10_000;
    p.tick(restStart + 600_000);
    expect(p.phase).toBe('awaiting_set');
    expect(p.session!.exercises[0]!.sets[0]!.restSeconds).toBe(60);
  });
});

describe('transport controls', () => {
  it('skip set logs skipped and enters rest (or awaiting when rest is 0)', () => {
    const p = usePlayerStore();
    const t = beginFirstSet(p);
    p.skipSet(t + 5_000);
    expect(p.phase).toBe('rest_set');
    p.tick(t + 5_000 + 60_000);
    expect(p.phase).toBe('awaiting_set');
    expect(p.session!.exercises[0]!.sets[0]!.outcome).toBe('skipped');
  });

  it('skip exercise on the final exercise completes the workout', () => {
    const p = usePlayerStore();
    const t = beginFirstSet(p);
    p.skipExercise(t + 5_000);
    expect(p.phase).toBe('awaiting_set');
    expect(p.exerciseIndex).toBe(1);
    p.skipExercise(t + 6_000);
    expect(p.phase).toBe('complete');
  });

  it('previous set is disabled at exercise 0, set 0', () => {
    const p = usePlayerStore();
    beginFirstSet(p);
    expect(p.canPreviousSet).toBe(false);
  });

  it('previous set during rest re-enters that set', () => {
    const p = usePlayerStore();
    const t = beginFirstSet(p);
    p.completeSet(t + 10_000);
    p.previousSet(t + 15_000);
    expect(p.phase).toBe('set_active');
    expect(p.setIndex).toBe(0);
    expect(p.session!.exercises[0]!.sets).toHaveLength(0);
  });
});

describe('rest adjustments', () => {
  it('shortening below zero ends rest into awaiting_set', () => {
    const p = usePlayerStore();
    const t = beginFirstSet(p);
    p.completeSet(t + 10_000);
    p.tick(t + 10_000 + 55_000);
    p.adjustRest(-15, t + 10_000 + 55_000);
    expect(p.phase).toBe('awaiting_set');
  });
});

describe('stop / abandon', () => {
  it('saves a partial session from mid-rest', async () => {
    const p = usePlayerStore();
    const sessions = useSessionsStore();
    const t = beginFirstSet(p);
    p.completeSet(t + 10_000);
    await p.abandon(t + 15_000);
    expect(p.phase).toBe('abandoned');
    expect(sessions.sessions[0]!.status).toBe('abandoned');
    expect(sessions.sessions[0]!.exercises[0]!.sets).toHaveLength(1);
  });
});

describe('single exercise, single set', () => {
  it('completes after one set with no rest screens', () => {
    const w = makeWorkout({
      exercises: [
        {
          id: 'only',
          name: 'Deadlift',
          weight: 200,
          unit: 'lb',
          sets: 1,
          targetReps: 5,
          restBetweenSets: 90,
          restAfterExercise: 120,
        },
      ],
    });
    const p = usePlayerStore();
    const t = beginFirstSet(p, w);
    p.completeSet(t + 20_000);
    expect(p.phase).toBe('complete');
  });
});

describe('persistence round trip', () => {
  it('hydrating mid-rest restores remaining time; overdue rest → awaiting_set', () => {
    const p = usePlayerStore();
    const t = beginFirstSet(p);
    p.completeSet(t + 10_000);
    p.setReps(7);
    p.tick(t + 10_000 + 20_000);

    const snapshot = JSON.parse(
      JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        savedAt: new Date(t + 30_000).toISOString(),
        phase: p.phase,
        pausedFrom: p.pausedFrom,
        workout: p.workout,
        session: p.session,
        exerciseIndex: p.exerciseIndex,
        setIndex: p.setIndex,
        pending: p.pending,
        pendingReps: p.pendingReps,
        restStartedAt: p.restStartedAt,
        timer: p.timer,
      }),
    ) as PersistedPlayerState;

    setActivePinia(createPinia());
    const q = usePlayerStore();
    q.hydrate(snapshot, t + 10_000 + 30_000);
    expect(q.phase).toBe('rest_set');
    expect(q.remainingMs).toBe(30_000);
    expect(q.pendingReps).toBe(7);

    setActivePinia(createPinia());
    const r = usePlayerStore();
    r.hydrate(JSON.parse(JSON.stringify(snapshot)) as PersistedPlayerState, t + 10_000 + 100_000);
    expect(r.phase).toBe('awaiting_set');
    expect(r.session!.exercises[0]!.sets[0]!.actualReps).toBe(7);
  });
});

import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { ALARM_INTERVAL_MS, REST_TICKS_AT, usePlayerStore } from '@/stores/player';
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
        restAfterExercise: 90,
      },
    ],
    ...overrides,
  };
}

function beginFirstSet(p: ReturnType<typeof usePlayerStore>, w = makeWorkout()): number {
  p.start(w, T0);
  expect(p.phase).toBe('set_active');
  return T0;
}

beforeEach(() => {
  setActivePinia(createPinia());
});

describe('simple loop', () => {
  it('Start workout begins set 1 immediately', () => {
    const p = usePlayerStore();
    expect(p.start(makeWorkout(), T0)).toBe(true);
    expect(p.phase).toBe('set_active');
  });

  it('Set complete → rest → ticks 3-2-1 → alarm at 0 → Stop alarm starts next set', () => {
    const p = usePlayerStore();
    const events: string[] = [];
    p.onEvent((e) => events.push(e));
    let t = beginFirstSet(p);

    t += 30_000;
    p.completeSet(t);
    expect(p.phase).toBe('rest_set');
    p.setReps(7);

    events.length = 0;
    const restStart = t;
    for (let ms = 56_000; ms <= 60_000; ms += 100) p.tick(restStart + ms);

    expect(REST_TICKS_AT).toEqual([3, 2, 1]);
    expect(events.filter((e) => e === 'beep')).toHaveLength(3);
    expect(p.phase).toBe('awaiting_set');
    expect(events.filter((e) => e === 'alarm').length).toBeGreaterThanOrEqual(1);
    expect(p.session!.exercises[0]!.sets[0]!.actualReps).toBe(7);

    // Alarm keeps going until stopped
    events.length = 0;
    p.tick(restStart + 60_000 + ALARM_INTERVAL_MS + 10);
    p.tick(restStart + 60_000 + ALARM_INTERVAL_MS * 2 + 10);
    expect(events.filter((e) => e === 'alarm').length).toBeGreaterThanOrEqual(2);

    // Stop alarm → set 2 work timer
    p.startNextSet(restStart + 60_000 + ALARM_INTERVAL_MS * 3);
    expect(p.phase).toBe('set_active');
    expect(p.setIndex).toBe(1);
  });

  it('same rest→alarm behavior between exercises', () => {
    const q = usePlayerStore();
    let t = beginFirstSet(q);
    q.completeSet(t + 10_000);
    q.tick(t + 10_000 + 60_000);
    q.startNextSet(t + 10_000 + 60_000 + 500);
    q.completeSet(t + 10_000 + 60_000 + 500 + 10_000); // last set of ex1 → rest_exercise
    expect(q.phase).toBe('rest_exercise');
    const awaitAt = t + 10_000 + 60_000 + 500 + 10_000 + 120_000;
    q.tick(awaitAt);
    expect(q.phase).toBe('awaiting_set');
    expect(q.exerciseIndex).toBe(1);
    q.startNextSet(awaitAt + 500);
    expect(q.phase).toBe('set_active');
  });

  it('skip set never rests and never alarms; lands ready on the next set', () => {
    const p = usePlayerStore();
    const events: string[] = [];
    p.onEvent((e) => events.push(e));
    const t = beginFirstSet(p);
    p.skipSet(t + 5_000);
    expect(p.phase).toBe('ready');
    expect(p.setIndex).toBe(1);
    expect(p.session!.exercises[0]!.sets[0]!.outcome).toBe('skipped');
    expect(events.filter((e) => e === 'alarm')).toHaveLength(0);
    p.toggleTimer(t + 6_000); // tapping the timer starts the set
    expect(p.phase).toBe('set_active');
    expect(p.elapsedMs).toBe(0);
  });

  it('skip during rest skips the upcoming set shown on screen and keeps the logged one', () => {
    const p = usePlayerStore();
    const events: string[] = [];
    p.onEvent((e) => events.push(e));
    const t = beginFirstSet(p);
    p.completeSet(t + 10_000);
    expect(p.phase).toBe('rest_set');
    expect(p.setIndex).toBe(1); // the screen shows set 2 as up next
    p.setReps(6);
    events.length = 0;
    p.skipSet(t + 15_000);
    expect(p.phase).toBe('ready');
    expect(p.exerciseIndex).toBe(1);
    expect(p.setIndex).toBe(0);
    const sets = p.session!.exercises[0]!.sets;
    expect(sets.map((s) => [s.setIndex, s.outcome, s.actualReps])).toEqual([
      [0, 'completed', 6],
      [1, 'skipped', 0],
    ]);
    expect(events.filter((e) => e === 'alarm')).toHaveLength(0);
  });

  it('skip exercise logs the unlogged sets as skipped and lands ready on the next exercise', () => {
    const p = usePlayerStore();
    const events: string[] = [];
    p.onEvent((e) => events.push(e));
    const t = beginFirstSet(p);
    p.skipExercise(t + 1_000);
    expect(p.phase).toBe('ready');
    expect(p.exerciseIndex).toBe(1);
    expect(p.setIndex).toBe(0);
    expect(p.session!.exercises[0]!.sets.every((s) => s.outcome === 'skipped')).toBe(true);
    expect(events.filter((e) => e === 'alarm')).toHaveLength(0);
  });

  it('timer toggle pauses and resumes work', () => {
    const p = usePlayerStore();
    const t = beginFirstSet(p);
    p.tick(t + 4_000);
    expect(p.elapsedMs).toBe(4_000);
    p.toggleTimer(t + 4_000);
    expect(p.phase).toBe('paused');
    expect(p.elapsedMs).toBe(4_000);
    p.tick(t + 20_000); // wall clock advances while paused
    expect(p.elapsedMs).toBe(4_000);
    p.toggleTimer(t + 20_000);
    expect(p.phase).toBe('set_active');
    expect(p.elapsedMs).toBe(4_000);
  });

  it('full workout end to end', () => {
    const p = usePlayerStore();
    let t = beginFirstSet(p);
    p.completeSet((t += 30_000));
    p.tick((t += 60_000));
    p.startNextSet((t += 1000));
    p.completeSet((t += 25_000));
    p.tick((t += 120_000));
    p.startNextSet((t += 500));
    p.completeSet((t += 20_000));
    expect(p.phase).toBe('complete');
    expect(sessionVolume(p.session!).lb).toBe(100 * 8 * 2);
  });
});

describe('navigation never deletes data', () => {
  it('jumping ahead, then finishing, wraps back to the sets that were left open', () => {
    const p = usePlayerStore();
    let t = beginFirstSet(p);
    p.jumpTo({ exerciseIndex: 1, setIndex: 0 }, (t += 1_000));
    expect(p.phase).toBe('ready');
    p.startSet((t += 1_000));
    p.completeSet((t += 20_000));
    // The next open set is back at the first exercise, after the exercise rest.
    expect(p.phase).toBe('rest_exercise');
    expect(p.exerciseIndex).toBe(0);
    expect(p.setIndex).toBe(0);
    p.tick((t += 90_000));
    expect(p.phase).toBe('awaiting_set');
    expect(p.session!.exercises[1]!.sets).toHaveLength(1);
  });

  it('back during rest redoes the set just finished; its log stays until redone', () => {
    const p = usePlayerStore();
    let t = beginFirstSet(p);
    p.completeSet((t += 10_000));
    p.setReps(5);
    p.goBack((t += 2_000));
    expect(p.phase).toBe('ready');
    expect(p.setIndex).toBe(0);
    expect(p.session!.exercises[0]!.sets[0]!.actualReps).toBe(5);
    expect(p.currentSetPreviousLog?.actualReps).toBe(5);
    p.startSet((t += 1_000));
    p.completeSet((t += 10_000));
    expect(p.pendingReps).toBe(5); // starts from what was logged before
    p.setReps(8);
    p.tick((t += 60_000));
    const sets = p.session!.exercises[0]!.sets;
    expect(sets).toHaveLength(1);
    expect(sets[0]!.actualReps).toBe(8);
  });

  it('back outside rest moves to the previous set without touching logs', () => {
    const p = usePlayerStore();
    let t = beginFirstSet(p);
    p.completeSet((t += 10_000));
    p.tick((t += 60_000));
    expect(p.setIndex).toBe(1);
    p.goBack((t += 1_000));
    expect(p.phase).toBe('ready');
    expect(p.setIndex).toBe(0);
    expect(p.session!.exercises[0]!.sets).toHaveLength(1);
  });

  it('back is disabled on the very first set', () => {
    const p = usePlayerStore();
    beginFirstSet(p);
    expect(p.canGoBack).toBe(false);
  });

  it('plan shows a status for every set', () => {
    const p = usePlayerStore();
    const t = beginFirstSet(p);
    p.completeSet(t + 10_000);
    const statuses = p.plan.map((e) => e.sets.map((s) => s.status));
    expect(statuses).toEqual([['pending', 'current'], ['open']]);
  });
});

describe('tracking', () => {
  it('end rest commits the log and starts the next set at once', () => {
    const p = usePlayerStore();
    let t = beginFirstSet(p);
    p.completeSet((t += 10_000));
    p.endRest((t += 20_000));
    expect(p.phase).toBe('set_active');
    expect(p.setIndex).toBe(1);
    expect(p.session!.exercises[0]!.sets[0]!.restSeconds).toBe(20);
  });

  it('weight and effort are logged; a weight change carries to later sets', () => {
    const p = usePlayerStore();
    let t = beginFirstSet(p);
    p.completeSet((t += 10_000));
    p.setPendingWeight(110);
    p.setPendingRir(2);
    p.tick((t += 60_000));
    const first = p.session!.exercises[0]!.sets[0]!;
    expect(first.weight).toBe(110);
    expect(first.rir).toBe(2);
    expect(p.currentWeight).toBe(110);
    p.startSet((t += 500));
    p.completeSet((t += 10_000));
    expect(p.pendingWeight).toBe(110);
    expect(p.pendingRir).toBeNull();
  });

  it('a logged set can be corrected afterwards', () => {
    const p = usePlayerStore();
    let t = beginFirstSet(p);
    p.completeSet((t += 10_000));
    p.tick((t += 60_000));
    p.editLoggedSet(0, 0, { actualReps: 0 });
    expect(p.session!.exercises[0]!.sets[0]!.outcome).toBe('skipped');
    p.editLoggedSet(0, 0, { actualReps: 7, weight: 95, rir: 1 });
    const set = p.session!.exercises[0]!.sets[0]!;
    expect([set.outcome, set.actualReps, set.weight, set.rir]).toEqual(['completed', 7, 95, 1]);
  });

  it('countdown ticks follow the configured seconds', () => {
    const p = usePlayerStore();
    p.setCountdownBeeps([5, 1]);
    const events: string[] = [];
    p.onEvent((e) => events.push(e));
    const t = beginFirstSet(p);
    p.completeSet(t + 10_000);
    events.length = 0;
    for (let ms = 50_000; ms < 60_000; ms += 100) p.tick(t + 10_000 + ms);
    expect(events.filter((e) => e === 'beep')).toHaveLength(2);
  });
});

describe('edge cases', () => {
  it('refuses empty workout', () => {
    const p = usePlayerStore();
    expect(p.start(makeWorkout({ exercises: [] }), T0)).toBe(false);
  });

  it('zero rest still alarms until Stop alarm', () => {
    const w = makeWorkout();
    w.exercises[0]!.restBetweenSets = 0;
    const p = usePlayerStore();
    const t = beginFirstSet(p, w);
    p.completeSet(t + 10_000);
    expect(p.phase).toBe('awaiting_set');
  });

  it('rest expiry while backgrounded lands on alarm', () => {
    const p = usePlayerStore();
    const t = beginFirstSet(p);
    p.completeSet(t + 10_000);
    p.tick(t + 10_000 + 600_000);
    expect(p.phase).toBe('awaiting_set');
  });

  it('abandon mid-rest saves the pending set', async () => {
    const p = usePlayerStore();
    const sessions = useSessionsStore();
    const t = beginFirstSet(p);
    p.completeSet(t + 10_000);
    await p.abandon(t + 15_000);
    expect(sessions.sessions[0]!.exercises[0]!.sets).toHaveLength(1);
  });

  it('hydrate mid-rest, overdue → alarm', () => {
    const p = usePlayerStore();
    const t = beginFirstSet(p);
    p.completeSet(t + 10_000);
    p.setReps(7);
    p.tick(t + 10_000 + 20_000);
    const snapshot = JSON.parse(
      JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        savedAt: new Date().toISOString(),
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
    const r = usePlayerStore();
    r.hydrate(snapshot, t + 10_000 + 100_000);
    expect(r.phase).toBe('awaiting_set');
    expect(r.session!.exercises[0]!.sets[0]!.actualReps).toBe(7);
  });

  it('hydrate maps the old paused-at-0:00 skip state to ready', () => {
    const p = usePlayerStore();
    const t = beginFirstSet(p);
    const legacy = {
      schemaVersion: SCHEMA_VERSION,
      savedAt: new Date().toISOString(),
      phase: 'paused',
      pausedFrom: 'set_active',
      workout: p.workout,
      session: p.session,
      exerciseIndex: 0,
      setIndex: 1,
      pending: null,
      pendingReps: 0,
      restStartedAt: null,
      timer: {
        kind: 'elapsed',
        endsAt: null,
        duration: null,
        startedAt: t,
        pausedRemaining: null,
        pausedElapsed: 0,
      },
    };
    setActivePinia(createPinia());
    const r = usePlayerStore();
    r.hydrate(JSON.parse(JSON.stringify(legacy)) as PersistedPlayerState, t + 5_000);
    expect(r.phase).toBe('ready');
    expect(r.weightOverrides).toEqual([null, null]);
  });
});

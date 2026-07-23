import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { usePlayerStore, INTRO_SECONDS } from '@/stores/player';
import { useSessionsStore } from '@/stores/sessions';
import type { PersistedPlayerState, Workout } from '@/types';
import { SCHEMA_VERSION } from '@/types';
import { sessionVolume } from '@/lib/stats';

const T0 = 1_000_000_000; // arbitrary epoch anchor
const INTRO_MS = INTRO_SECONDS * 1000;

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

beforeEach(() => {
  setActivePinia(createPinia());
});

describe('start and intro', () => {
  it('enters exercise_intro with a 5 s countdown', () => {
    const p = usePlayerStore();
    expect(p.start(makeWorkout(), T0)).toBe(true);
    expect(p.phase).toBe('exercise_intro');
    expect(p.exerciseIndex).toBe(0);
    expect(p.setIndex).toBe(0);
    p.tick(T0 + 1000);
    expect(p.remainingMs).toBe(INTRO_MS - 1000);
  });

  it('refuses to start an empty workout', () => {
    const p = usePlayerStore();
    expect(p.start(makeWorkout({ exercises: [] }), T0)).toBe(false);
    expect(p.phase).toBe('idle');
  });

  it('intro auto-advances to set_active at 0, or on Skip', () => {
    const p = usePlayerStore();
    p.start(makeWorkout(), T0);
    p.tick(T0 + INTRO_MS);
    expect(p.phase).toBe('set_active');

    setActivePinia(createPinia());
    const q = usePlayerStore();
    q.start(makeWorkout(), T0);
    q.skipIntro(T0 + 2000);
    expect(q.phase).toBe('set_active');
  });
});

describe('the full happy path', () => {
  it('walks a two-exercise workout end to end with correct logs', () => {
    const p = usePlayerStore();
    p.start(makeWorkout(), T0);

    // intro -> set 1
    let t = T0 + INTRO_MS;
    p.tick(t);
    expect(p.phase).toBe('set_active');

    // set 1 takes 30 s
    t += 30_000;
    p.completeSet(t);
    expect(p.phase).toBe('rest_set');
    expect(p.remainingMs).toBe(60_000);
    expect(p.setIndex).toBe(1); // cursor is on the next set during rest

    // rest runs to zero -> auto-commits target reps
    t += 60_000;
    p.tick(t);
    expect(p.phase).toBe('set_active');

    // set 2 takes 25 s
    t += 25_000;
    p.completeSet(t);
    expect(p.phase).toBe('rest_exercise');
    expect(p.remainingMs).toBe(120_000);
    expect(p.exerciseIndex).toBe(1);

    // rest ends -> intro of exercise 2 -> set
    t += 120_000;
    p.tick(t);
    expect(p.phase).toBe('exercise_intro');
    t += INTRO_MS;
    p.tick(t);
    expect(p.phase).toBe('set_active');

    // final set: restAfterExercise of the last exercise never runs
    t += 20_000;
    p.completeSet(t);
    expect(p.phase).toBe('complete');

    const s = p.session!;
    expect(s.status).toBe('completed');
    expect(s.endedAt).toBe(new Date(t).toISOString());
    const [a, b] = s.exercises;
    expect(a!.sets).toHaveLength(2);
    expect(a!.outcome).toBe('completed');
    expect(a!.sets[0]).toMatchObject({
      setIndex: 0,
      targetReps: 8,
      actualReps: 8,
      weight: 100,
      unit: 'lb',
      outcome: 'completed',
      workSeconds: 30,
      restSeconds: 60,
    });
    expect(a!.sets[1]).toMatchObject({ workSeconds: 25, restSeconds: 120 });
    expect(b!.sets).toHaveLength(1);
    expect(b!.sets[0]!.restSeconds).toBe(0);
    expect(s.durationSeconds).toBe(Math.round((t - T0) / 1000));
    expect(s.totalRestSeconds).toBe(180);
    expect(sessionVolume(s).lb).toBe(100 * 8 * 2);
  });
});

describe('rep logging during rest', () => {
  function toFirstRest(p: ReturnType<typeof usePlayerStore>): number {
    p.start(makeWorkout(), T0);
    p.tick(T0 + INTRO_MS);
    const t = T0 + INTRO_MS + 30_000;
    p.completeSet(t);
    return t;
  }

  it('pre-fills target reps and commits the stepper value on Done, skipping remaining rest', () => {
    const p = usePlayerStore();
    const t = toFirstRest(p);
    expect(p.pendingReps).toBe(8);
    p.setReps(6);
    p.finishRest(t + 25_000);
    expect(p.phase).toBe('set_active');
    const log = p.session!.exercises[0]!.sets[0]!;
    expect(log.actualReps).toBe(6);
    expect(log.restSeconds).toBe(25); // actual rest taken, not planned
  });

  it('auto-commits the displayed value when rest reaches 0 untouched', () => {
    const p = usePlayerStore();
    const t = toFirstRest(p);
    p.tick(t + 60_000);
    expect(p.session!.exercises[0]!.sets[0]!.actualReps).toBe(8);
  });

  it('a stepper value of 0 records the set as skipped', () => {
    const p = usePlayerStore();
    const t = toFirstRest(p);
    p.setReps(0);
    p.finishRest(t + 10_000);
    expect(p.session!.exercises[0]!.sets[0]!.outcome).toBe('skipped');
  });
});

describe('zero-length rests pass straight through', () => {
  it('restBetweenSets = 0 goes directly to the next set', () => {
    const w = makeWorkout();
    w.exercises[0]!.restBetweenSets = 0;
    const p = usePlayerStore();
    p.start(w, T0);
    p.tick(T0 + INTRO_MS);
    p.completeSet(T0 + INTRO_MS + 10_000);
    expect(p.phase).toBe('set_active');
    expect(p.setIndex).toBe(1);
    const log = p.session!.exercises[0]!.sets[0]!;
    expect(log.actualReps).toBe(8);
    expect(log.restSeconds).toBe(0);
  });

  it('restAfterExercise = 0 goes directly to the next exercise intro', () => {
    const w = makeWorkout();
    w.exercises[0]!.restAfterExercise = 0;
    const p = usePlayerStore();
    p.start(w, T0);
    p.tick(T0 + INTRO_MS);
    let t = T0 + INTRO_MS;
    p.completeSet((t += 10_000)); // set 1 -> rest_set
    p.tick((t += 60_000)); // -> set 2
    p.completeSet((t += 10_000)); // last set, zero rest after
    expect(p.phase).toBe('exercise_intro');
    expect(p.exerciseIndex).toBe(1);
  });
});

describe('pause and resume', () => {
  it('freezes a countdown exactly and resumes with the same remaining time', () => {
    const p = usePlayerStore();
    p.start(makeWorkout(), T0);
    p.tick(T0 + INTRO_MS);
    p.completeSet(T0 + INTRO_MS + 10_000);
    const restStart = T0 + INTRO_MS + 10_000;

    p.tick(restStart + 40_000); // 20 s remaining
    p.pause(restStart + 40_000);
    expect(p.phase).toBe('paused');
    expect(p.remainingMs).toBe(20_000);

    // A very long pause changes nothing.
    p.tick(restStart + 1_000_000);
    expect(p.remainingMs).toBe(20_000);

    const resumeAt = restStart + 2_000_000;
    p.resume(resumeAt);
    expect(p.phase).toBe('rest_set');
    p.tick(resumeAt + 19_999);
    expect(p.phase).toBe('rest_set');
    p.tick(resumeAt + 20_000);
    expect(p.phase).toBe('set_active');
  });

  it('freezes an elapsed work timer and excludes paused time from workSeconds', () => {
    const p = usePlayerStore();
    p.start(makeWorkout(), T0);
    p.tick(T0 + INTRO_MS);
    const workStart = T0 + INTRO_MS;
    p.pause(workStart + 10_000);
    p.resume(workStart + 500_000);
    p.completeSet(workStart + 505_000);
    expect(p.pending!.workSeconds).toBe(15); // 10 s before + 5 s after the pause
  });
});

describe('backgrounded expiry and multi-boundary catch-up', () => {
  it('a rest that expired while backgrounded resolves on return', () => {
    const p = usePlayerStore();
    p.start(makeWorkout(), T0);
    p.tick(T0 + INTRO_MS);
    p.completeSet(T0 + INTRO_MS + 10_000);
    const restStart = T0 + INTRO_MS + 10_000;
    // Backgrounded for far longer than the 60 s rest.
    p.tick(restStart + 600_000);
    expect(p.phase).toBe('set_active');
    // The set's clock started at the rest boundary, not at return time.
    expect(p.elapsedMs).toBe(600_000 - 60_000);
    expect(p.session!.exercises[0]!.sets[0]!.restSeconds).toBe(60);
  });

  it('crosses multiple boundaries in order: rest end -> intro end -> active set', () => {
    const p = usePlayerStore();
    p.start(makeWorkout(), T0);
    p.tick(T0 + INTRO_MS);
    let t = T0 + INTRO_MS;
    p.completeSet((t += 10_000)); // rest_set 60 s
    p.tick((t += 60_000)); // set 2
    p.completeSet((t += 10_000)); // rest_exercise 120 s
    const restStart = t;

    // Away past the whole rest AND the next exercise's 5 s intro.
    p.tick(restStart + 120_000 + INTRO_MS + 7_000);
    expect(p.phase).toBe('set_active');
    expect(p.exerciseIndex).toBe(1);
    expect(p.elapsedMs).toBe(7_000); // anchored at the intro boundary
  });
});

describe('transport controls', () => {
  function toSetActive(p: ReturnType<typeof usePlayerStore>, w = makeWorkout()): number {
    p.start(w, T0);
    p.tick(T0 + INTRO_MS);
    return T0 + INTRO_MS;
  }

  it('skip set logs 0 reps, skipped, and advances as if completed', () => {
    const p = usePlayerStore();
    const t = toSetActive(p);
    p.skipSet(t + 5_000);
    expect(p.phase).toBe('rest_set'); // same transition as a completed set
    p.finishRest(t + 6_000);
    const log = p.session!.exercises[0]!.sets[0]!;
    expect(log.outcome).toBe('skipped');
    expect(log.actualReps).toBe(0);
    expect(p.setIndex).toBe(1);
  });

  it('skip exercise logs all remaining sets as skipped and moves to the next intro', () => {
    const p = usePlayerStore();
    const t = toSetActive(p);
    p.skipExercise(t + 5_000);
    expect(p.phase).toBe('exercise_intro');
    expect(p.exerciseIndex).toBe(1);
    const a = p.session!.exercises[0]!;
    expect(a.sets).toHaveLength(2);
    expect(a.sets.every((x) => x.outcome === 'skipped')).toBe(true);
  });

  it('skip exercise on the final exercise completes the workout', () => {
    const p = usePlayerStore();
    const t = toSetActive(p);
    p.skipExercise(t + 5_000); // -> exercise 2 intro
    p.skipExercise(t + 6_000); // final exercise -> complete
    expect(p.phase).toBe('complete');
  });

  it('every set skipped -> completed session, skipped outcomes, volume 0', () => {
    const p = usePlayerStore();
    const t = toSetActive(p);
    p.skipExercise(t + 1_000);
    p.skipExercise(t + 2_000);
    const s = p.session!;
    expect(s.status).toBe('completed');
    expect(s.exercises.every((e) => e.outcome === 'skipped')).toBe(true);
    expect(sessionVolume(s).lb).toBe(0);
    expect(sessionVolume(s).kg).toBe(0);
  });

  it('previous set is disabled at exercise 0, set 0', () => {
    const p = usePlayerStore();
    toSetActive(p);
    expect(p.canPreviousSet).toBe(false);
    p.previousSet(T0 + INTRO_MS + 1_000); // no crash, no change
    expect(p.phase).toBe('set_active');
    expect(p.setIndex).toBe(0);
  });

  it('previous set during rest discards the pending log and re-enters that set', () => {
    const p = usePlayerStore();
    const t = toSetActive(p);
    p.completeSet(t + 10_000);
    expect(p.setIndex).toBe(1);
    p.previousSet(t + 15_000);
    expect(p.phase).toBe('set_active');
    expect(p.setIndex).toBe(0);
    expect(p.pending).toBeNull();
    expect(p.session!.exercises[0]!.sets).toHaveLength(0); // discarded
  });

  it('previous set at set 0 re-enters the last set of the previous exercise', () => {
    const p = usePlayerStore();
    const t = toSetActive(p);
    p.skipExercise(t + 1_000); // -> exercise 2 intro
    p.previousSet(t + 2_000);
    expect(p.exerciseIndex).toBe(0);
    expect(p.setIndex).toBe(1);
    expect(p.phase).toBe('set_active');
    // The re-entered set's old log is discarded; earlier ones kept.
    expect(p.session!.exercises[0]!.sets.map((x) => x.setIndex)).toEqual([0]);
  });

  it('previous exercise jumps to set 0 of the previous exercise and discards re-entered logs', () => {
    const p = usePlayerStore();
    let t = toSetActive(p);
    p.completeSet((t += 10_000));
    p.tick((t += 60_000));
    p.completeSet((t += 10_000)); // -> rest_exercise, cursor on exercise 2
    p.tick((t += 120_000)); // exercise 2 intro
    p.tick((t += INTRO_MS)); // exercise 2 set active
    p.previousExercise((t += 2_000));
    expect(p.exerciseIndex).toBe(0);
    expect(p.setIndex).toBe(0);
    expect(p.phase).toBe('exercise_intro');
    expect(p.session!.exercises[0]!.sets).toHaveLength(0);
    expect(p.session!.exercises[1]!.sets).toHaveLength(0);
  });

  it('previous exercise is disabled at exercise 0', () => {
    const p = usePlayerStore();
    toSetActive(p);
    expect(p.canPreviousExercise).toBe(false);
  });
});

describe('rest adjustments', () => {
  it('+30 s extends and −15 s shortens the current countdown only', () => {
    const p = usePlayerStore();
    p.start(makeWorkout(), T0);
    p.tick(T0 + INTRO_MS);
    const t = T0 + INTRO_MS + 10_000;
    p.completeSet(t);
    p.adjustRest(30, t + 1_000);
    expect(p.remainingMs).toBe(89_000);
    p.adjustRest(-15, t + 2_000);
    expect(p.remainingMs).toBe(73_000);
  });

  it('shortening below zero completes the rest immediately', () => {
    const p = usePlayerStore();
    p.start(makeWorkout(), T0);
    p.tick(T0 + INTRO_MS);
    const t = T0 + INTRO_MS + 10_000;
    p.completeSet(t);
    p.tick(t + 55_000); // 5 s remaining
    p.adjustRest(-15, t + 55_000);
    expect(p.phase).toBe('set_active');
    expect(p.session!.exercises[0]!.sets).toHaveLength(1);
  });
});

describe('stop / abandon', () => {
  it('saves a partial session, committing an in-flight pending set', async () => {
    const p = usePlayerStore();
    const sessions = useSessionsStore();
    p.start(makeWorkout(), T0);
    p.tick(T0 + INTRO_MS);
    const t = T0 + INTRO_MS + 10_000;
    p.completeSet(t); // resting; set 1 pending
    await p.abandon(t + 5_000);
    expect(p.phase).toBe('abandoned');
    expect(sessions.sessions).toHaveLength(1);
    const saved = sessions.sessions[0]!;
    expect(saved.status).toBe('abandoned');
    expect(saved.exercises[0]!.sets).toHaveLength(1);
    expect(saved.exercises[0]!.outcome).toBe('partial');
    expect(saved.exercises[1]!.outcome).toBe('skipped'); // never reached
  });
});

describe('single exercise, single set (edge 11.1)', () => {
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
    p.start(w, T0);
    p.tick(T0 + INTRO_MS);
    p.completeSet(T0 + INTRO_MS + 20_000);
    expect(p.phase).toBe('complete');
    expect(p.session!.exercises[0]!.sets[0]!.restSeconds).toBe(0);
  });
});

describe('audio cue events', () => {
  it('emits beep at 3, 2, 1 and go at 0 during a rest countdown', () => {
    const p = usePlayerStore();
    const events: string[] = [];
    p.onEvent((e) => events.push(e));
    p.start(makeWorkout(), T0);
    p.tick(T0 + INTRO_MS);
    const t = T0 + INTRO_MS + 10_000;
    p.completeSet(t);
    events.length = 0; // ignore start/intro cues

    // Render loop at 100 ms from 4 s remaining through expiry.
    for (let ms = 56_000; ms <= 60_100; ms += 100) p.tick(t + ms);

    expect(events.filter((e) => e === 'beep')).toHaveLength(3);
    expect(events.filter((e) => e === 'go')).toHaveLength(1);
    expect(events[events.length - 1]).toBe('go');
  });

  it('stays silent when catching up long-expired boundaries', () => {
    const p = usePlayerStore();
    const events: string[] = [];
    p.start(makeWorkout(), T0);
    p.tick(T0 + INTRO_MS);
    const t = T0 + INTRO_MS + 10_000;
    p.completeSet(t);
    p.onEvent((e) => events.push(e));
    p.tick(t + 600_000); // rest expired 9 minutes ago
    expect(events).toHaveLength(0);
  });
});

describe('persistence round trip (crash / refresh / killed tab)', () => {
  it('hydrating a mid-rest snapshot restores the exact remaining time', () => {
    const p = usePlayerStore();
    p.start(makeWorkout(), T0);
    p.tick(T0 + INTRO_MS);
    const t = T0 + INTRO_MS + 10_000;
    p.completeSet(t);
    p.setReps(7);
    p.tick(t + 20_000); // 40 s of rest left

    const snapshot = JSON.parse(
      JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        savedAt: new Date(t + 20_000).toISOString(),
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

    // Fresh app instance (new pinia): the tab was killed.
    setActivePinia(createPinia());
    const q = usePlayerStore();
    q.hydrate(snapshot, t + 30_000);
    expect(q.phase).toBe('rest_set');
    expect(q.remainingMs).toBe(30_000);
    expect(q.pendingReps).toBe(7);

    // And if it was killed for longer than the rest, it resolves forward.
    setActivePinia(createPinia());
    const r = usePlayerStore();
    r.hydrate(JSON.parse(JSON.stringify(snapshot)) as PersistedPlayerState, t + 100_000);
    expect(r.phase).toBe('set_active');
    expect(r.session!.exercises[0]!.sets[0]!.actualReps).toBe(7);
  });
});

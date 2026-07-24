/**
 * The player: a headless finite state machine driving the workout.
 *
 * Simple loop (same between sets and between exercises):
 *   set_active (work timer) → Set complete → rest (enter reps) →
 *   ticks at 3, 2, 1 → alarm at 0 (awaiting_set) → user stops alarm →
 *   next set_active → …
 *
 * Rest never auto-starts the next set. Alarm keeps firing until the user
 * taps Stop alarm. Skip set / skip exercise never enter rest and never
 * ring the alarm — they jump to the next set paused at 0:00;
 * the user taps the timer to start.
 * Time is wall-clock based (no setInterval accumulation).
 */
import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import type {
  Exercise,
  PendingSet,
  PersistedPlayerState,
  PlayerPhase,
  Session,
  SetLog,
  TimerSnapshot,
  Workout,
} from '@/types';
import { SCHEMA_VERSION } from '@/types';
import { uuid } from '@/lib/id';
import {
  clearPlayerState,
  savePlayerState,
  StorageWriteError,
} from '@/lib/persistence';
import { useSessionsStore } from '@/stores/sessions';

/** How often the post-rest alarm re-fires until the user stops it. */
export const ALARM_INTERVAL_MS = 1000;

/** Rest countdown ticks — always 3, 2, 1 then alarm at 0. */
export const REST_TICKS_AT = [3, 2, 1];

export type PlayerEventType = 'beep' | 'go' | 'alarm' | 'new_exercise' | 'complete';

const TIMED_PHASES: PlayerPhase[] = [
  'awaiting_set',
  'set_active',
  'rest_set',
  'rest_exercise',
  'exercise_intro',
];
const REST_PHASES: PlayerPhase[] = ['rest_set', 'rest_exercise'];

function emptyTimer(): TimerSnapshot {
  return {
    kind: null,
    endsAt: null,
    duration: null,
    startedAt: null,
    pausedRemaining: null,
    pausedElapsed: null,
  };
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export const usePlayerStore = defineStore('player', () => {
  const phase = ref<PlayerPhase>('idle');
  const pausedFrom = ref<PlayerPhase | null>(null);
  const workout = ref<Workout | null>(null);
  const session = ref<Session | null>(null);
  const exerciseIndex = ref(0);
  const setIndex = ref(0);
  const pending = ref<PendingSet | null>(null);
  const pendingReps = ref(0);
  const restStartedAt = ref<number | null>(null);
  const timer = ref<TimerSnapshot>(emptyTimer());
  const nowMs = ref(0);
  const storageError = ref<string | null>(null);

  let lastCueSecond: number | null = null;
  let lastAlarmPulse = -1;
  let lastPersistAt = 0;

  /* ------------------------------ events ----------------------------- */

  const listeners = new Set<(event: PlayerEventType) => void>();

  function onEvent(cb: (event: PlayerEventType) => void): () => void {
    listeners.add(cb);
    return () => listeners.delete(cb);
  }

  function emit(event: PlayerEventType): void {
    for (const cb of listeners) cb(event);
  }

  /* ----------------------------- getters ----------------------------- */

  const currentExercise = computed<Exercise | null>(
    () => workout.value?.exercises[exerciseIndex.value] ?? null,
  );

  const totalExercises = computed(() => workout.value?.exercises.length ?? 0);

  const isRunning = computed(
    () => phase.value !== 'idle' && phase.value !== 'complete' && phase.value !== 'abandoned',
  );

  const isRestPhase = computed(() => REST_PHASES.includes(phase.value));

  /** Remaining ms for the active countdown (0 when none). */
  const remainingMs = computed(() => {
    const t = timer.value;
    if (phase.value === 'paused') {
      return t.kind === 'countdown' ? (t.pausedRemaining ?? 0) : 0;
    }
    if (t.kind !== 'countdown' || t.endsAt === null) return 0;
    return Math.max(0, t.endsAt - nowMs.value);
  });

  /** Elapsed ms for the active set (counts up). */
  const elapsedMs = computed(() => {
    const t = timer.value;
    if (phase.value === 'paused') {
      return t.kind === 'elapsed' ? (t.pausedElapsed ?? 0) : 0;
    }
    if (t.kind !== 'elapsed' || t.startedAt === null) return 0;
    return Math.max(0, nowMs.value - t.startedAt);
  });

  /** 1 → full ring, draining to 0 for countdowns. */
  const countdownFraction = computed(() => {
    const t = timer.value;
    const isCountdown =
      t.kind === 'countdown' ||
      (phase.value === 'paused' && t.pausedRemaining !== null);
    if (!isCountdown || !t.duration || t.duration <= 0) return 0;
    const rem = phase.value === 'paused' ? (t.pausedRemaining ?? 0) : remainingMs.value;
    return Math.min(1, Math.max(0, rem / t.duration));
  });

  const totalSets = computed(() =>
    (workout.value?.exercises ?? []).reduce((sum, ex) => sum + ex.sets, 0),
  );

  const loggedSets = computed(() =>
    (session.value?.exercises ?? []).reduce((sum, ex) => sum + ex.sets.length, 0),
  );

  /** Overall workout progress: share of sets logged or pending. */
  const overallFraction = computed(() => {
    if (totalSets.value === 0) return 0;
    const done = loggedSets.value + (pending.value ? 1 : 0);
    return Math.min(1, done / totalSets.value);
  });

  const effectivePhase = computed<PlayerPhase>(() =>
    phase.value === 'paused' ? (pausedFrom.value ?? 'paused') : phase.value,
  );

  const canPreviousSet = computed(() => {
    if (!isRunning.value || phase.value === 'idle') return false;
    return pending.value !== null || setIndex.value > 0 || exerciseIndex.value > 0;
  });

  const canPreviousExercise = computed(() => isRunning.value && exerciseIndex.value > 0);

  /* --------------------------- persistence --------------------------- */

  function snapshot(): PersistedPlayerState {
    return JSON.parse(
      JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        savedAt: new Date().toISOString(),
        phase: phase.value,
        pausedFrom: pausedFrom.value,
        workout: workout.value,
        session: session.value,
        exerciseIndex: exerciseIndex.value,
        setIndex: setIndex.value,
        pending: pending.value,
        pendingReps: pendingReps.value,
        restStartedAt: restStartedAt.value,
        timer: timer.value,
      }),
    ) as PersistedPlayerState;
  }

  function persistNow(): void {
    lastPersistAt = nowMs.value;
    if (!workout.value || !session.value || phase.value === 'idle' || phase.value === 'abandoned') {
      void clearPlayerState().catch(() => undefined);
      return;
    }
    void savePlayerState(snapshot()).catch((err) => {
      storageError.value =
        err instanceof StorageWriteError ? err.message : 'Saving your session failed.';
    });
  }

  /* ------------------------- timer primitives ------------------------ */

  function startCountdown(now: number, ms: number): void {
    timer.value = {
      kind: 'countdown',
      endsAt: now + ms,
      duration: ms,
      startedAt: null,
      pausedRemaining: null,
      pausedElapsed: null,
    };
    lastCueSecond = null;
  }

  function startElapsed(now: number): void {
    timer.value = {
      kind: 'elapsed',
      endsAt: null,
      duration: null,
      startedAt: now,
      pausedRemaining: null,
      pausedElapsed: null,
    };
    lastCueSecond = null;
  }

  /* --------------------------- transitions --------------------------- */

  /** Rest over (or workout start): alarm until the user starts the set. */
  function enterAwaitingSet(now: number, cue = true): void {
    phase.value = 'awaiting_set';
    restStartedAt.value = null;
    startElapsed(now);
    lastAlarmPulse = -1;
    if (cue) emit('alarm');
  }

  function enterSetActive(now: number, cue = true): void {
    phase.value = 'set_active';
    restStartedAt.value = null;
    startElapsed(now);
    lastAlarmPulse = -1;
    if (cue) emit('go');
  }

  /** Next set ready at 0:00 — paused until the user taps the timer. */
  function enterSetReady(now: number): void {
    enterSetActive(now, false);
    pause(now);
  }

  /** Writes the pending set's log with the currently displayed rep count. */
  function commitPending(now: number): void {
    const p = pending.value;
    if (!p || !session.value) return;
    const reps = Math.max(0, Math.round(pendingReps.value));
    const log: SetLog = {
      setIndex: p.setIndex,
      targetReps: p.targetReps,
      actualReps: reps,
      weight: p.weight,
      unit: p.unit,
      outcome: reps > 0 ? 'completed' : 'skipped',
      startedAt: p.startedAt,
      completedAt: p.completedAt,
      workSeconds: p.workSeconds,
      restSeconds:
        restStartedAt.value !== null
          ? Math.max(0, Math.round((now - restStartedAt.value) / 1000))
          : 0,
    };
    const exLog = session.value.exercises[p.exerciseIndex];
    if (exLog) {
      exLog.sets = exLog.sets
        .filter((s) => s.setIndex !== log.setIndex)
        .concat([log])
        .sort((a, b) => a.setIndex - b.setIndex);
    }
    pending.value = null;
    restStartedAt.value = null;
  }

  /**
   * After a set finishes (completed or skipped): move the cursor forward
   * and enter the matching rest — or pass straight through zero rests.
   */
  function advanceAfterSet(now: number): void {
    const w = workout.value;
    const ex = currentExercise.value;
    if (!w || !ex) return;
    const isLastSet = setIndex.value >= ex.sets - 1;
    const isLastExercise = exerciseIndex.value >= w.exercises.length - 1;

    if (!isLastSet) {
      setIndex.value += 1;
      if (ex.restBetweenSets > 0) {
        phase.value = 'rest_set';
        restStartedAt.value = now;
        startCountdown(now, ex.restBetweenSets * 1000);
      } else {
        commitPending(now);
        enterAwaitingSet(now);
      }
    } else if (!isLastExercise) {
      exerciseIndex.value += 1;
      setIndex.value = 0;
      if (ex.restAfterExercise > 0) {
        phase.value = 'rest_exercise';
        restStartedAt.value = now;
        startCountdown(now, ex.restAfterExercise * 1000);
      } else {
        commitPending(now);
        enterAwaitingSet(now, true);
        emit('new_exercise');
      }
    } else {
      // Last set of the last exercise: restAfterExercise never runs.
      commitPending(now);
      goComplete(now);
    }
    persistNow();
  }

  function finalizeSession(now: number, status: 'completed' | 'abandoned'): void {
    const s = session.value;
    if (!s) return;
    s.status = status;
    s.endedAt = iso(now);
    s.durationSeconds = Math.max(
      0,
      Math.round((now - new Date(s.startedAt).getTime()) / 1000),
    );
    s.totalRestSeconds = s.exercises.reduce(
      (sum, ex) => sum + ex.sets.reduce((a, b) => a + b.restSeconds, 0),
      0,
    );
    for (const exLog of s.exercises) {
      if (exLog.sets.length === 0) {
        exLog.outcome = 'skipped';
      } else if (exLog.sets.every((x) => x.outcome === 'skipped')) {
        exLog.outcome = 'skipped';
      } else if (
        exLog.sets.length === exLog.targetSets &&
        exLog.sets.every((x) => x.outcome === 'completed')
      ) {
        exLog.outcome = 'completed';
      } else {
        exLog.outcome = 'partial';
      }
    }
  }

  function goComplete(now: number): void {
    finalizeSession(now, 'completed');
    phase.value = 'complete';
    pausedFrom.value = null;
    timer.value = emptyTimer();
    emit('complete');
    persistNow();
  }

  /** Rewinds discard the logs of every step at or after `pos`. */
  function discardFrom(exIdx: number, setIdx: number): void {
    const s = session.value;
    if (!s) return;
    s.exercises.forEach((exLog, i) => {
      if (i < exIdx) return;
      exLog.sets = i === exIdx ? exLog.sets.filter((x) => x.setIndex < setIdx) : [];
    });
  }

  function resumeIfPaused(now: number): void {
    if (phase.value === 'paused') resume(now);
  }

  /* ------------------------------ actions ---------------------------- */

  function start(w: Workout, now = Date.now()): boolean {
    if (w.exercises.length === 0) return false;
    workout.value = JSON.parse(JSON.stringify(w)) as Workout;
    session.value = {
      id: uuid(),
      workoutId: w.id,
      workoutName: w.name,
      startedAt: iso(now),
      endedAt: null,
      status: 'in_progress',
      exercises: w.exercises.map((ex) => ({
        exerciseId: ex.id,
        name: ex.name,
        targetSets: ex.sets,
        sets: [],
        outcome: 'skipped',
      })),
      durationSeconds: 0,
      totalRestSeconds: 0,
    };
    exerciseIndex.value = 0;
    setIndex.value = 0;
    pending.value = null;
    pendingReps.value = 0;
    pausedFrom.value = null;
    storageError.value = null;
    nowMs.value = now;
    // First set starts immediately on Start workout (the tap is the start signal).
    enterSetActive(now);
    persistNow();
    return true;
  }

  /**
   * User stops the post-rest alarm; the next set's work timer starts here.
   */
  function startNextSet(now = Date.now()): void {
    resumeIfPaused(now);
    if (phase.value !== 'awaiting_set' && phase.value !== 'exercise_intro') return;
    nowMs.value = now;
    enterSetActive(now, false); // user gesture stops the alarm; no extra go blip
    persistNow();
  }

  /** Primary action in set_active: the set is done; rest starts immediately. */
  function completeSet(now = Date.now()): void {
    resumeIfPaused(now);
    if (phase.value !== 'set_active') return;
    const ex = currentExercise.value;
    if (!ex) return;
    nowMs.value = now;
    const startedAtMs = timer.value.startedAt ?? now;
    pending.value = {
      exerciseIndex: exerciseIndex.value,
      setIndex: setIndex.value,
      targetReps: ex.targetReps,
      weight: ex.weight,
      unit: ex.unit,
      startedAt: iso(startedAtMs),
      completedAt: iso(now),
      workSeconds: Math.max(0, Math.round((now - startedAtMs) / 1000)),
      skipped: false,
    };
    pendingReps.value = ex.targetReps;
    advanceAfterSet(now);
  }

  /** Rep stepper value for the set awaiting commit. */
  function setReps(reps: number): void {
    pendingReps.value = Math.min(999, Math.max(0, Math.round(reps)));
    persistNow(); // a refresh mid-rest must not lose the adjusted count
  }

  /** +30 s / −15 s on the current rest countdown only. */
  function adjustRest(deltaSeconds: number, now = Date.now()): void {
    if (!REST_PHASES.includes(phase.value)) return;
    const t = timer.value;
    if (t.kind !== 'countdown' || t.endsAt === null) return;
    nowMs.value = now;
    t.endsAt += deltaSeconds * 1000;
    t.duration = Math.max(1, (t.duration ?? 0) + deltaSeconds * 1000);
    if (t.endsAt <= now) {
      t.endsAt = now;
      tick(now);
    }
    persistNow();
  }

  function pause(now = Date.now()): void {
    if (!TIMED_PHASES.includes(phase.value)) return;
    nowMs.value = now;
    const t = timer.value;
    pausedFrom.value = phase.value;
    if (t.kind === 'countdown' && t.endsAt !== null) {
      t.pausedRemaining = Math.max(0, t.endsAt - now);
    } else if (t.kind === 'elapsed' && t.startedAt !== null) {
      t.pausedElapsed = Math.max(0, now - t.startedAt);
    }
    phase.value = 'paused';
    persistNow();
  }

  function resume(now = Date.now()): void {
    if (phase.value !== 'paused' || !pausedFrom.value) return;
    nowMs.value = now;
    const t = timer.value;
    if (t.kind === 'countdown' && t.pausedRemaining !== null) {
      t.endsAt = now + t.pausedRemaining;
      t.pausedRemaining = null;
    } else if (t.kind === 'elapsed' && t.pausedElapsed !== null) {
      t.startedAt = now - t.pausedElapsed;
      t.pausedElapsed = null;
    }
    phase.value = pausedFrom.value;
    pausedFrom.value = null;
    persistNow();
  }

  /** Tap the timer: pause while running, restart while paused. */
  function toggleTimer(now = Date.now()): void {
    if (phase.value === 'paused') {
      resume(now);
      return;
    }
    if (phase.value === 'set_active' || REST_PHASES.includes(phase.value)) {
      pause(now);
    }
  }

  function writeSkippedSet(exIdx: number, setIdx: number, now: number): void {
    const s = session.value;
    const ex = workout.value?.exercises[exIdx];
    const exLog = s?.exercises[exIdx];
    if (!s || !ex || !exLog) return;
    exLog.sets = exLog.sets
      .filter((x) => x.setIndex !== setIdx)
      .concat([
        {
          setIndex: setIdx,
          targetReps: ex.targetReps,
          actualReps: 0,
          weight: ex.weight,
          unit: ex.unit,
          outcome: 'skipped',
          startedAt: iso(now),
          completedAt: iso(now),
          workSeconds: 0,
          restSeconds: 0,
        },
      ])
      .sort((a, b) => a.setIndex - b.setIndex);
  }

  /**
   * After a skip: never rest, never alarm — land on the next set paused
   * at 0:00 (or complete). User taps the timer to start.
   */
  function advanceAfterSkip(now: number): void {
    const w = workout.value;
    const ex = currentExercise.value;
    if (!w || !ex) return;
    restStartedAt.value = null;
    pending.value = null;

    if (setIndex.value < ex.sets - 1) {
      setIndex.value += 1;
      enterSetReady(now);
      persistNow();
      return;
    }
    if (exerciseIndex.value < w.exercises.length - 1) {
      exerciseIndex.value += 1;
      setIndex.value = 0;
      enterSetReady(now);
      emit('new_exercise');
      persistNow();
      return;
    }
    goComplete(now);
  }

  /**
   * ▶ Skip the current set (or the set you're about to do during rest/alarm).
   * Never enters rest and never rings the alarm. Lands paused at 0:00.
   */
  function skipSet(now = Date.now()): void {
    resumeIfPaused(now);
    if (!isRunning.value || phase.value === 'idle') return;
    const ex = currentExercise.value;
    if (!ex) return;
    nowMs.value = now;
    // Finish logging the set we just left, if rest had started.
    if (pending.value) commitPending(now);
    writeSkippedSet(exerciseIndex.value, setIndex.value, now);
    advanceAfterSkip(now);
  }

  /**
   * ⏭ Skip the rest of this exercise. Lands on the next exercise's first
   * set paused at 0:00 — no rest, no alarm.
   */
  function skipExercise(now = Date.now()): void {
    resumeIfPaused(now);
    if (!isRunning.value || phase.value === 'idle') return;
    const w = workout.value;
    const ex = currentExercise.value;
    if (!w || !ex) return;
    nowMs.value = now;
    if (pending.value) commitPending(now);
    for (let i = setIndex.value; i < ex.sets; i++) {
      writeSkippedSet(exerciseIndex.value, i, now);
    }
    restStartedAt.value = null;
    pending.value = null;
    if (exerciseIndex.value >= w.exercises.length - 1) {
      goComplete(now);
      return;
    }
    exerciseIndex.value += 1;
    setIndex.value = 0;
    enterSetReady(now);
    emit('new_exercise');
    persistNow();
  }

  /** ◀ Re-enter the previous set; its log is discarded for re-recording. */
  function previousSet(now = Date.now()): void {
    resumeIfPaused(now);
    if (!canPreviousSet.value) return;
    const w = workout.value;
    if (!w) return;
    nowMs.value = now;
    let targetEx: number;
    let targetSet: number;
    if (pending.value) {
      // Resting: the previous set is the one awaiting commit.
      targetEx = pending.value.exerciseIndex;
      targetSet = pending.value.setIndex;
      pending.value = null;
      restStartedAt.value = null;
    } else if (setIndex.value > 0) {
      targetEx = exerciseIndex.value;
      targetSet = setIndex.value - 1;
    } else {
      targetEx = exerciseIndex.value - 1;
      targetSet = (w.exercises[targetEx]?.sets ?? 1) - 1;
    }
    discardFrom(targetEx, targetSet);
    exerciseIndex.value = targetEx;
    setIndex.value = targetSet;
    enterSetActive(now, false);
    persistNow();
  }

  /** ⏮ Jump to set 0 of the previous exercise, discarding re-entered logs. */
  function previousExercise(now = Date.now()): void {
    resumeIfPaused(now);
    if (!canPreviousExercise.value) return;
    nowMs.value = now;
    pending.value = null;
    restStartedAt.value = null;
    const targetEx = exerciseIndex.value - 1;
    discardFrom(targetEx, 0);
    exerciseIndex.value = targetEx;
    setIndex.value = 0;
    enterAwaitingSet(now, false);
    persistNow();
  }

  /** Stop → abandoned. Completed sets (including a pending one) are saved. */
  async function abandon(now = Date.now()): Promise<void> {
    if (!isRunning.value || !session.value) return;
    nowMs.value = now;
    if (pending.value) commitPending(now);
    finalizeSession(now, 'abandoned');
    phase.value = 'abandoned';
    pausedFrom.value = null;
    timer.value = emptyTimer();
    const sessions = useSessionsStore();
    await sessions.add(JSON.parse(JSON.stringify(session.value)) as Session);
    await clearPlayerState().catch(() => undefined);
  }

  /** Adjust the final set's reps from the completion summary. */
  function adjustLastSetReps(reps: number): void {
    const s = session.value;
    if (phase.value !== 'complete' || !s) return;
    for (let i = s.exercises.length - 1; i >= 0; i--) {
      const sets = s.exercises[i]!.sets;
      if (sets.length > 0) {
        const last = sets[sets.length - 1]!;
        last.actualReps = Math.min(999, Math.max(0, Math.round(reps)));
        last.outcome = last.actualReps > 0 ? 'completed' : 'skipped';
        finalizeSession(new Date(s.endedAt ?? s.startedAt).getTime(), 'completed');
        return;
      }
    }
  }

  /** Save & finish from the complete screen. The caller resets after navigating. */
  async function saveAndFinish(): Promise<void> {
    if (phase.value !== 'complete' || !session.value) return;
    const sessions = useSessionsStore();
    await sessions.add(JSON.parse(JSON.stringify(session.value)) as Session);
    await clearPlayerState().catch(() => undefined);
  }

  function reset(): void {
    phase.value = 'idle';
    pausedFrom.value = null;
    workout.value = null;
    session.value = null;
    exerciseIndex.value = 0;
    setIndex.value = 0;
    pending.value = null;
    pendingReps.value = 0;
    restStartedAt.value = null;
    timer.value = emptyTimer();
    lastCueSecond = null;
  }

  /* ------------------------------- tick ------------------------------ */

  /**
   * Advances the machine to `now`. Fires every expired boundary in order,
   * anchoring each successor at the boundary time — a tab backgrounded
   * across several transitions lands exactly where it should.
   */
  function tick(now = Date.now()): void {
    nowMs.value = now;
    if (!isRunning.value || phase.value === 'paused' || phase.value === 'idle') return;

    let guard = 0;
    while (
      timer.value.kind === 'countdown' &&
      timer.value.endsAt !== null &&
      now >= timer.value.endsAt &&
      guard++ < 10_000
    ) {
      const boundary = timer.value.endsAt;
      // Rest hitting 0 always alarms — that is the signal to get up.
      if (phase.value === 'rest_set') {
        commitPending(boundary);
        enterAwaitingSet(boundary, true);
        persistNow();
      } else if (phase.value === 'rest_exercise') {
        commitPending(boundary);
        enterAwaitingSet(boundary, true);
        emit('new_exercise');
        persistNow();
      } else if (phase.value === 'exercise_intro') {
        enterAwaitingSet(boundary, true);
        persistNow();
      } else {
        break;
      }
    }

    // Rest ticks at 3, 2, 1 — then alarm takes over at 0.
    if (
      timer.value.kind === 'countdown' &&
      timer.value.endsAt !== null &&
      REST_PHASES.includes(phase.value)
    ) {
      const secondsLeft = Math.ceil((timer.value.endsAt - now) / 1000);
      if (secondsLeft !== lastCueSecond) {
        lastCueSecond = secondsLeft;
        if (secondsLeft > 0 && REST_TICKS_AT.includes(secondsLeft)) emit('beep');
      }
    }

    // Alarm at 0: keep firing until the user stops it (Start next set).
    if (phase.value === 'awaiting_set' && timer.value.startedAt !== null) {
      const pulse = Math.floor((now - timer.value.startedAt) / ALARM_INTERVAL_MS);
      if (pulse > lastAlarmPulse) {
        lastAlarmPulse = pulse;
        if (pulse > 0) emit('alarm');
      }
    }

    if (now - lastPersistAt >= 5000) persistNow();
  }

  /* ------------------------------ resume ----------------------------- */

  /** Restores a persisted session (crash/refresh/kill) and reconciles. */
  function hydrate(state: PersistedPlayerState, now = Date.now()): void {
    workout.value = state.workout;
    session.value = state.session;
    // Map legacy auto-intro onto the wait-for-user phase.
    phase.value = state.phase === 'exercise_intro' ? 'awaiting_set' : state.phase;
    pausedFrom.value =
      state.pausedFrom === 'exercise_intro' ? 'awaiting_set' : state.pausedFrom;
    exerciseIndex.value = state.exerciseIndex;
    setIndex.value = state.setIndex;
    pending.value = state.pending;
    pendingReps.value = state.pendingReps;
    restStartedAt.value = state.restStartedAt;
    timer.value = state.timer;
    nowMs.value = now;
    lastCueSecond = null;
    lastAlarmPulse = -1;
    if (phase.value === 'awaiting_set' && timer.value.kind !== 'elapsed') {
      startElapsed(now);
    }
    if (phase.value !== 'paused') tick(now);
  }

  return {
    // state
    phase,
    pausedFrom,
    workout,
    session,
    exerciseIndex,
    setIndex,
    pending,
    pendingReps,
    restStartedAt,
    timer,
    nowMs,
    storageError,
    // getters
    currentExercise,
    totalExercises,
    totalSets,
    loggedSets,
    isRunning,
    isRestPhase,
    remainingMs,
    elapsedMs,
    countdownFraction,
    overallFraction,
    effectivePhase,
    canPreviousSet,
    canPreviousExercise,
    // actions
    start,
    startNextSet,
    completeSet,
    setReps,
    adjustRest,
    pause,
    resume,
    toggleTimer,
    skipSet,
    skipExercise,
    previousSet,
    previousExercise,
    abandon,
    adjustLastSetReps,
    saveAndFinish,
    reset,
    tick,
    hydrate,
    onEvent,
  };
});

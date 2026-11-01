/**
 * The player: a headless finite state machine driving the workout.
 *
 * Loop (same between sets and between exercises):
 *   set_active (work timer) → Finish set → rest (log reps, weight, effort) →
 *   countdown ticks → alarm at 0 (awaiting_set) → Start set → set_active → …
 *
 * The cursor (exerciseIndex, setIndex) is always the set shown on screen as
 * "this set": the one being worked, or the one coming up during rest.
 * Every control acts on that set, so labels can name it exactly.
 *
 * Navigation never deletes data:
 * - Skip set / skip exercise log the unlogged sets as skipped and land on
 *   the next open set in the `ready` state (no timer, no alarm).
 * - Back and Jump only move the cursor. A set that is already logged keeps
 *   its log until it is completed again, which overwrites it.
 * - After any set, the player goes to the next set that has no log yet,
 *   wrapping to earlier gaps, so jumping ahead never strands earlier sets.
 *
 * Time is wall-clock based (no setInterval accumulation). Sound is
 * scheduled ahead of time by lib/playerRuntime from this state, so the
 * alarm still fires when the page is in the background.
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
import { clearPlayerState, savePlayerState, StorageWriteError } from '@/lib/persistence';
import { useSessionsStore } from '@/stores/sessions';

/** How often the post-rest alarm repeats until the user starts the set. */
export const ALARM_INTERVAL_MS = 1000;

/** Default rest countdown ticks (Settings can override them). */
export const REST_TICKS_AT = [3, 2, 1];

export type PlayerEventType = 'beep' | 'go' | 'alarm' | 'new_exercise' | 'complete';

export interface Position {
  exerciseIndex: number;
  setIndex: number;
}

export type PlanSetStatus = 'completed' | 'skipped' | 'pending' | 'current' | 'open';

export interface PlanSet {
  setIndex: number;
  status: PlanSetStatus;
  /** Logged (or pending) reps, when there are any. */
  reps: number | null;
  /** Logged (or pending) weight, when there is one. */
  weight: number | null;
}

export interface PlanExercise {
  exerciseIndex: number;
  exercise: Exercise;
  workingWeight: number;
  sets: PlanSet[];
  isCurrent: boolean;
}

const TIMED_PHASES: PlayerPhase[] = ['set_active', 'rest_set', 'rest_exercise'];
const REST_PHASES: PlayerPhase[] = ['rest_set', 'rest_exercise'];
const WAITING_PHASES: PlayerPhase[] = ['ready', 'awaiting_set', 'exercise_intro'];

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
  const pendingWeight = ref(0);
  const pendingRir = ref<number | null>(null);
  const weightOverrides = ref<(number | null)[]>([]);
  const restStartedAt = ref<number | null>(null);
  const timer = ref<TimerSnapshot>(emptyTimer());
  const nowMs = ref(0);
  const storageError = ref<string | null>(null);
  /** Seconds before the end of rest at which a tick sounds. */
  const countdownBeepsAt = ref<number[]>([...REST_TICKS_AT]);

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

  /* --------------------------- position helpers ---------------------- */

  function exerciseAt(i: number): Exercise | null {
    return workout.value?.exercises[i] ?? null;
  }

  function workingWeight(i: number): number {
    const override = weightOverrides.value[i];
    if (typeof override === 'number') return override;
    return exerciseAt(i)?.weight ?? 0;
  }

  function logFor(exIdx: number, setIdx: number): SetLog | undefined {
    return session.value?.exercises[exIdx]?.sets.find((s) => s.setIndex === setIdx);
  }

  function isPendingAt(exIdx: number, setIdx: number): boolean {
    const p = pending.value;
    return p !== null && p.exerciseIndex === exIdx && p.setIndex === setIdx;
  }

  /** Every set in workout order. */
  function allPositions(): Position[] {
    const out: Position[] = [];
    (workout.value?.exercises ?? []).forEach((ex, e) => {
      for (let s = 0; s < ex.sets; s++) out.push({ exerciseIndex: e, setIndex: s });
    });
    return out;
  }

  function orderOf(pos: Position): number {
    return allPositions().findIndex(
      (p) => p.exerciseIndex === pos.exerciseIndex && p.setIndex === pos.setIndex,
    );
  }

  function isOpen(pos: Position): boolean {
    return !logFor(pos.exerciseIndex, pos.setIndex) && !isPendingAt(pos.exerciseIndex, pos.setIndex);
  }

  /**
   * The next set with no log after `from`, wrapping to earlier gaps.
   * `from` itself is never returned.
   */
  function nextOpenAfter(from: Position): Position | null {
    const all = allPositions();
    const start = orderOf(from);
    for (let k = 1; k < all.length; k++) {
      const pos = all[(start + k) % all.length]!;
      if (isOpen(pos)) return pos;
    }
    return null;
  }

  /* ----------------------------- getters ----------------------------- */

  const currentExercise = computed<Exercise | null>(() => exerciseAt(exerciseIndex.value));

  const currentWeight = computed(() => workingWeight(exerciseIndex.value));

  const totalExercises = computed(() => workout.value?.exercises.length ?? 0);

  const isRunning = computed(
    () => phase.value !== 'idle' && phase.value !== 'complete' && phase.value !== 'abandoned',
  );

  const isRestPhase = computed(() => REST_PHASES.includes(phase.value));

  const effectivePhase = computed<PlayerPhase>(() =>
    phase.value === 'paused' ? (pausedFrom.value ?? 'paused') : phase.value,
  );

  /** Remaining ms for the active countdown (0 when none). */
  const remainingMs = computed(() => {
    const t = timer.value;
    if (phase.value === 'paused') {
      return t.kind === 'countdown' ? (t.pausedRemaining ?? 0) : 0;
    }
    if (t.kind !== 'countdown' || t.endsAt === null) return 0;
    return Math.max(0, t.endsAt - nowMs.value);
  });

  /** Elapsed ms for the active set or alarm (counts up). */
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
    if (t.kind !== 'countdown' || !t.duration || t.duration <= 0) return 0;
    return Math.min(1, Math.max(0, remainingMs.value / t.duration));
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

  /** 1-based position of the cursor in the whole workout. */
  const overallSetNumber = computed(() =>
    orderOf({ exerciseIndex: exerciseIndex.value, setIndex: setIndex.value }) + 1,
  );

  /** The set the player goes to after the current one (null = workout ends). */
  const upNext = computed<Position | null>(() => {
    if (!isRunning.value) return null;
    // During rest the cursor already is the upcoming set.
    if (REST_PHASES.includes(effectivePhase.value)) {
      return { exerciseIndex: exerciseIndex.value, setIndex: setIndex.value };
    }
    return nextOpenAfter({ exerciseIndex: exerciseIndex.value, setIndex: setIndex.value });
  });

  /** Rest that will run before `upNext`, in seconds (during work/ready only). */
  const restBeforeUpNext = computed(() => {
    const next = upNext.value;
    const ex = currentExercise.value;
    if (!next || !ex) return 0;
    if (REST_PHASES.includes(effectivePhase.value)) return 0;
    return next.exerciseIndex === exerciseIndex.value ? ex.restBetweenSets : ex.restAfterExercise;
  });

  /** The full plan with per-set status, for the plan list and jump. */
  const plan = computed<PlanExercise[]>(() =>
    (workout.value?.exercises ?? []).map((ex, e) => ({
      exerciseIndex: e,
      exercise: ex,
      workingWeight: workingWeight(e),
      isCurrent: e === exerciseIndex.value,
      sets: Array.from({ length: ex.sets }, (_, s): PlanSet => {
        if (isPendingAt(e, s)) {
          return { setIndex: s, status: 'pending', reps: pendingReps.value, weight: pendingWeight.value };
        }
        if (e === exerciseIndex.value && s === setIndex.value && isRunning.value) {
          const log = logFor(e, s);
          return { setIndex: s, status: 'current', reps: log?.actualReps ?? null, weight: log?.weight ?? null };
        }
        const log = logFor(e, s);
        if (log) {
          return { setIndex: s, status: log.outcome, reps: log.actualReps, weight: log.weight };
        }
        return { setIndex: s, status: 'open', reps: null, weight: null };
      }),
    })),
  );

  /** The log already stored for the cursor set (when redoing a set). */
  const currentSetPreviousLog = computed(() => logFor(exerciseIndex.value, setIndex.value) ?? null);

  const canGoBack = computed(() => {
    if (!isRunning.value) return false;
    if (pending.value) return true;
    return orderOf({ exerciseIndex: exerciseIndex.value, setIndex: setIndex.value }) > 0;
  });

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
        pendingWeight: pendingWeight.value,
        pendingRir: pendingRir.value,
        weightOverrides: weightOverrides.value,
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

  /** Rest is over: alarm until the user starts the set. */
  function enterAwaitingSet(now: number, cue = true): void {
    phase.value = 'awaiting_set';
    pausedFrom.value = null;
    restStartedAt.value = null;
    startElapsed(now);
    lastAlarmPulse = 0;
    if (cue) emit('alarm');
  }

  function enterSetActive(now: number, cue = true): void {
    phase.value = 'set_active';
    pausedFrom.value = null;
    restStartedAt.value = null;
    startElapsed(now);
    lastAlarmPulse = -1;
    if (cue) emit('go');
  }

  /** A set is queued (after skip, jump or back): no timer, no alarm. */
  function enterReady(): void {
    phase.value = 'ready';
    pausedFrom.value = null;
    restStartedAt.value = null;
    timer.value = emptyTimer();
    lastAlarmPulse = -1;
  }

  /** Writes the pending set's log with the values shown in the logger. */
  function commitPending(now: number): void {
    const p = pending.value;
    if (!p || !session.value) return;
    const reps = Math.max(0, Math.round(pendingReps.value));
    const log: SetLog = {
      setIndex: p.setIndex,
      targetReps: p.targetReps,
      actualReps: reps,
      weight: Math.max(0, pendingWeight.value),
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
    if (pendingRir.value !== null) log.rir = pendingRir.value;
    writeLog(p.exerciseIndex, log);
    pending.value = null;
    pendingRir.value = null;
    restStartedAt.value = null;
  }

  function writeLog(exIdx: number, log: SetLog): void {
    const exLog = session.value?.exercises[exIdx];
    if (!exLog) return;
    exLog.sets = exLog.sets
      .filter((s) => s.setIndex !== log.setIndex)
      .concat([log])
      .sort((a, b) => a.setIndex - b.setIndex);
  }

  function writeSkippedSet(exIdx: number, setIdx: number, now: number): void {
    const ex = exerciseAt(exIdx);
    if (!ex) return;
    writeLog(exIdx, {
      setIndex: setIdx,
      targetReps: ex.targetReps,
      actualReps: 0,
      weight: workingWeight(exIdx),
      unit: ex.unit,
      outcome: 'skipped',
      startedAt: iso(now),
      completedAt: iso(now),
      workSeconds: 0,
      restSeconds: 0,
    });
  }

  function finalizeSession(now: number, status: 'completed' | 'abandoned'): void {
    const s = session.value;
    if (!s) return;
    s.status = status;
    s.endedAt = iso(now);
    s.durationSeconds = Math.max(0, Math.round((now - new Date(s.startedAt).getTime()) / 1000));
    recomputeOutcomes();
  }

  function recomputeOutcomes(): void {
    const s = session.value;
    if (!s) return;
    s.totalRestSeconds = s.exercises.reduce(
      (sum, ex) => sum + ex.sets.reduce((a, b) => a + b.restSeconds, 0),
      0,
    );
    for (const exLog of s.exercises) {
      if (exLog.sets.length === 0 || exLog.sets.every((x) => x.outcome === 'skipped')) {
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

  function moveCursor(pos: Position): void {
    exerciseIndex.value = pos.exerciseIndex;
    setIndex.value = pos.setIndex;
  }

  function resumeIfPaused(now: number): void {
    if (phase.value === 'paused') resume(now);
  }

  /** Commits any pending set, then lands on `pos` ready to start. */
  function goReady(pos: Position | null, now: number): void {
    if (pending.value) commitPending(now);
    if (!pos) {
      goComplete(now);
      return;
    }
    const changedExercise = pos.exerciseIndex !== exerciseIndex.value;
    moveCursor(pos);
    enterReady();
    if (changedExercise) emit('new_exercise');
    persistNow();
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
    pendingWeight.value = 0;
    pendingRir.value = null;
    weightOverrides.value = w.exercises.map(() => null);
    pausedFrom.value = null;
    storageError.value = null;
    nowMs.value = now;
    // The Start workout tap is the start signal for set 1.
    enterSetActive(now);
    persistNow();
    return true;
  }

  /** Starts the work timer for the cursor set (stops the alarm). */
  function startSet(now = Date.now()): void {
    resumeIfPaused(now);
    if (!WAITING_PHASES.includes(phase.value)) return;
    nowMs.value = now;
    enterSetActive(now, false); // the tap itself is the signal
    persistNow();
  }

  /** Kept for older callers: the alarm button starts the set. */
  const startNextSet = startSet;

  /** The set is done: rest starts immediately with the logger open. */
  function completeSet(now = Date.now()): void {
    resumeIfPaused(now);
    if (phase.value !== 'set_active') return;
    const ex = currentExercise.value;
    if (!ex) return;
    nowMs.value = now;
    const startedAtMs = timer.value.startedAt ?? now;
    const here: Position = { exerciseIndex: exerciseIndex.value, setIndex: setIndex.value };
    const previous = logFor(here.exerciseIndex, here.setIndex);
    pending.value = {
      exerciseIndex: here.exerciseIndex,
      setIndex: here.setIndex,
      targetReps: ex.targetReps,
      weight: workingWeight(here.exerciseIndex),
      unit: ex.unit,
      startedAt: iso(startedAtMs),
      completedAt: iso(now),
      workSeconds: Math.max(0, Math.round((now - startedAtMs) / 1000)),
      skipped: false,
    };
    // Redoing a logged set starts from what was logged before.
    pendingReps.value = previous && previous.outcome === 'completed' ? previous.actualReps : ex.targetReps;
    pendingWeight.value = workingWeight(here.exerciseIndex);
    pendingRir.value = null;

    const next = nextOpenAfter(here);
    if (!next) {
      commitPending(now);
      goComplete(now);
      return;
    }
    const sameExercise = next.exerciseIndex === here.exerciseIndex;
    const restSeconds = sameExercise ? ex.restBetweenSets : ex.restAfterExercise;
    moveCursor(next);
    if (restSeconds > 0) {
      phase.value = sameExercise ? 'rest_set' : 'rest_exercise';
      restStartedAt.value = now;
      startCountdown(now, restSeconds * 1000);
    } else {
      commitPending(now);
      enterAwaitingSet(now);
      if (!sameExercise) emit('new_exercise');
    }
    persistNow();
  }

  /** Rep count for the set being logged during rest. */
  function setReps(reps: number): void {
    pendingReps.value = Math.min(999, Math.max(0, Math.round(reps)));
    persistNow(); // a refresh mid-rest must not lose the adjusted count
  }

  /** Weight used for the set being logged; later sets of that exercise default to it. */
  function setPendingWeight(weight: number): void {
    const w = Math.min(9999, Math.max(0, Math.round(weight * 100) / 100));
    pendingWeight.value = w;
    const p = pending.value;
    if (p) setWorkingWeight(p.exerciseIndex, w);
    persistNow();
  }

  /** Reps in reserve for the set being logged (null clears it). */
  function setPendingRir(rir: number | null): void {
    pendingRir.value = rir === null ? null : Math.min(10, Math.max(0, Math.round(rir)));
    persistNow();
  }

  /** Changes the weight used for the rest of this exercise in this session. */
  function setWorkingWeight(exIdx: number, weight: number): void {
    const list = [...weightOverrides.value];
    while (list.length <= exIdx) list.push(null);
    list[exIdx] = Math.max(0, weight);
    weightOverrides.value = list;
    persistNow();
  }

  /** Ends rest early and starts the next set's work timer right away. */
  function endRest(now = Date.now()): void {
    resumeIfPaused(now);
    if (!REST_PHASES.includes(phase.value)) return;
    nowMs.value = now;
    const newExercise = phase.value === 'rest_exercise';
    commitPending(now);
    enterSetActive(now, false);
    if (newExercise) emit('new_exercise');
    persistNow();
  }

  /** +30 s / −15 s on the current rest countdown only. */
  function adjustRest(deltaSeconds: number, now = Date.now()): void {
    if (!REST_PHASES.includes(phase.value)) return;
    const t = timer.value;
    if (t.kind !== 'countdown' || t.endsAt === null) return;
    nowMs.value = now;
    t.endsAt += deltaSeconds * 1000;
    t.duration = Math.max(1, (t.duration ?? 0) + deltaSeconds * 1000);
    lastCueSecond = null;
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
    lastCueSecond = null;
    persistNow();
  }

  /** Tap on the timer: pause or resume a running timer, or start a waiting set. */
  function toggleTimer(now = Date.now()): void {
    if (phase.value === 'paused') {
      resume(now);
    } else if (TIMED_PHASES.includes(phase.value)) {
      pause(now);
    } else if (WAITING_PHASES.includes(phase.value)) {
      startSet(now);
    }
  }

  /**
   * Skips the cursor set (the one on screen). Never rests, never alarms:
   * lands on the next open set, ready to start.
   */
  function skipSet(now = Date.now()): void {
    resumeIfPaused(now);
    if (!isRunning.value || !currentExercise.value) return;
    nowMs.value = now;
    if (pending.value) commitPending(now);
    const here: Position = { exerciseIndex: exerciseIndex.value, setIndex: setIndex.value };
    if (!logFor(here.exerciseIndex, here.setIndex)) {
      writeSkippedSet(here.exerciseIndex, here.setIndex, now);
    }
    goReady(nextOpenAfter(here), now);
  }

  /** Skips every unlogged set of the cursor exercise and moves on. */
  function skipExercise(now = Date.now()): void {
    resumeIfPaused(now);
    const ex = currentExercise.value;
    if (!isRunning.value || !ex) return;
    nowMs.value = now;
    if (pending.value) commitPending(now);
    const e = exerciseIndex.value;
    for (let s = 0; s < ex.sets; s++) {
      if (!logFor(e, s)) writeSkippedSet(e, s, now);
    }
    goReady(nextOpenAfter({ exerciseIndex: e, setIndex: ex.sets - 1 }), now);
  }

  /** Moves the cursor to any set. Nothing is deleted. */
  function jumpTo(target: Position, now = Date.now()): void {
    resumeIfPaused(now);
    if (!isRunning.value) return;
    const ex = exerciseAt(target.exerciseIndex);
    if (!ex || target.setIndex < 0 || target.setIndex >= ex.sets) return;
    const same =
      target.exerciseIndex === exerciseIndex.value && target.setIndex === setIndex.value;
    if (same && (phase.value === 'set_active' || WAITING_PHASES.includes(phase.value))) return;
    nowMs.value = now;
    goReady(target, now);
  }

  /**
   * Goes back one set: during rest that is the set just finished (to redo
   * it), otherwise the set before the cursor. Nothing is deleted.
   */
  function goBack(now = Date.now()): void {
    resumeIfPaused(now);
    if (!canGoBack.value) return;
    nowMs.value = now;
    const p = pending.value;
    if (p) {
      goReady({ exerciseIndex: p.exerciseIndex, setIndex: p.setIndex }, now);
      return;
    }
    const all = allPositions();
    const idx = orderOf({ exerciseIndex: exerciseIndex.value, setIndex: setIndex.value });
    goReady(all[idx - 1] ?? null, now);
  }

  /** Corrects a set that is already logged (summary screen or plan). */
  function editLoggedSet(
    exIdx: number,
    setIdx: number,
    patch: { actualReps?: number; weight?: number; rir?: number | null },
  ): void {
    const log = logFor(exIdx, setIdx);
    if (!log) return;
    if (patch.actualReps !== undefined) {
      log.actualReps = Math.min(999, Math.max(0, Math.round(patch.actualReps)));
      log.outcome = log.actualReps > 0 ? 'completed' : 'skipped';
    }
    if (patch.weight !== undefined) log.weight = Math.max(0, patch.weight);
    if (patch.rir !== undefined) {
      if (patch.rir === null) delete log.rir;
      else log.rir = Math.min(10, Math.max(0, Math.round(patch.rir)));
    }
    recomputeOutcomes();
    persistNow();
  }

  /** End early → abandoned. Logged sets (including a pending one) are saved. */
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
    pendingWeight.value = 0;
    pendingRir.value = null;
    weightOverrides.value = [];
    restStartedAt.value = null;
    timer.value = emptyTimer();
    lastCueSecond = null;
  }

  function setCountdownBeeps(beeps: number[]): void {
    countdownBeepsAt.value = beeps.filter((b) => Number.isFinite(b) && b > 0);
  }

  /* ------------------------------- tick ------------------------------ */

  /**
   * Advances the machine to `now`. A rest that expired while the page was
   * in the background lands on the alarm, anchored at the moment rest ended.
   * Events here drive vibration; sound is scheduled separately.
   */
  function tick(now = Date.now()): void {
    nowMs.value = now;
    if (!isRunning.value || phase.value === 'paused') return;

    const t = timer.value;
    if (
      REST_PHASES.includes(phase.value) &&
      t.kind === 'countdown' &&
      t.endsAt !== null &&
      now >= t.endsAt
    ) {
      const boundary = t.endsAt;
      const newExercise = phase.value === 'rest_exercise';
      commitPending(boundary);
      enterAwaitingSet(boundary, true);
      if (newExercise) emit('new_exercise');
      persistNow();
    }

    // Countdown ticks before rest ends.
    if (
      timer.value.kind === 'countdown' &&
      timer.value.endsAt !== null &&
      REST_PHASES.includes(phase.value)
    ) {
      const secondsLeft = Math.ceil((timer.value.endsAt - now) / 1000);
      if (secondsLeft !== lastCueSecond) {
        lastCueSecond = secondsLeft;
        if (secondsLeft > 0 && countdownBeepsAt.value.includes(secondsLeft)) emit('beep');
      }
    }

    // Alarm repeats until the user starts the set.
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
    phase.value = state.phase === 'exercise_intro' ? 'awaiting_set' : state.phase;
    pausedFrom.value = state.pausedFrom === 'exercise_intro' ? 'awaiting_set' : state.pausedFrom;
    exerciseIndex.value = state.exerciseIndex;
    setIndex.value = state.setIndex;
    pending.value = state.pending;
    pendingReps.value = state.pendingReps;
    pendingWeight.value = state.pendingWeight ?? state.pending?.weight ?? 0;
    pendingRir.value = state.pendingRir ?? null;
    weightOverrides.value =
      state.weightOverrides ?? (state.workout?.exercises ?? []).map(() => null);
    restStartedAt.value = state.restStartedAt;
    timer.value = state.timer;
    nowMs.value = now;
    lastCueSecond = null;
    lastAlarmPulse = -1;

    // Older versions paused at 0:00 after a skip; that is the ready state now.
    if (
      phase.value === 'paused' &&
      pausedFrom.value === 'set_active' &&
      (timer.value.pausedElapsed ?? 0) === 0
    ) {
      enterReady();
    }
    // Pausing during an alarm or ready is no longer possible.
    if (phase.value === 'paused' && pausedFrom.value && WAITING_PHASES.includes(pausedFrom.value)) {
      phase.value = pausedFrom.value;
      pausedFrom.value = null;
    }
    if (phase.value === 'awaiting_set' && timer.value.kind !== 'elapsed') startElapsed(now);
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
    pendingWeight,
    pendingRir,
    weightOverrides,
    restStartedAt,
    timer,
    nowMs,
    storageError,
    countdownBeepsAt,
    // getters
    currentExercise,
    currentWeight,
    totalExercises,
    totalSets,
    loggedSets,
    isRunning,
    isRestPhase,
    remainingMs,
    elapsedMs,
    countdownFraction,
    overallFraction,
    overallSetNumber,
    effectivePhase,
    upNext,
    restBeforeUpNext,
    plan,
    currentSetPreviousLog,
    canGoBack,
    // helpers
    workingWeight,
    logFor,
    // actions
    start,
    startSet,
    startNextSet,
    completeSet,
    setReps,
    setPendingWeight,
    setPendingRir,
    setWorkingWeight,
    endRest,
    adjustRest,
    pause,
    resume,
    toggleTimer,
    skipSet,
    skipExercise,
    jumpTo,
    goBack,
    editLoggedSet,
    abandon,
    saveAndFinish,
    reset,
    setCountdownBeeps,
    tick,
    hydrate,
    onEvent,
  };
});

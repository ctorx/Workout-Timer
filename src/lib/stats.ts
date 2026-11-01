import type { Exercise, ExerciseLog, Session, SetLog, Unit } from '@/types';

/** Σ weight × actualReps per unit; mixed units are reported side by side. */
export interface Volume {
  lb: number;
  kg: number;
}

export function sessionVolume(session: Session): Volume {
  const v: Volume = { lb: 0, kg: 0 };
  for (const ex of session.exercises) {
    for (const s of ex.sets) {
      v[s.unit] += s.weight * s.actualReps;
    }
  }
  return v;
}

export function formatVolume(v: Volume): string {
  const parts: string[] = [];
  if (v.lb > 0) parts.push(`${Math.round(v.lb).toLocaleString()} lb`);
  if (v.kg > 0) parts.push(`${Math.round(v.kg).toLocaleString()} kg`);
  return parts.length > 0 ? parts.join(' + ') : '0';
}

export function sessionCompletionPercent(session: Session): number {
  let target = 0;
  let done = 0;
  for (const ex of session.exercises) {
    target += ex.targetSets;
    done += ex.sets.filter((s) => s.outcome === 'completed').length;
  }
  if (target === 0) return 0;
  return Math.round((done / target) * 100);
}

/* ------------------------------ streaks ----------------------------- */

/** Start of the local week (Sunday 00:00) containing the given date. */
function weekStart(d: Date): number {
  const copy = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  copy.setDate(copy.getDate() - copy.getDay());
  return copy.getTime();
}

const WEEK_MS = 7 * 24 * 3600 * 1000;

export interface StreakInfo {
  current: number;
  longest: number;
}

/**
 * Streaks are counted in calendar weeks (Sunday-based) that contain at least
 * one completed session of a non-optional workout. `optionalWorkoutIds` is
 * the set of workout ids currently marked optional.
 */
export function computeStreaks(
  sessions: Session[],
  optionalWorkoutIds: Set<string>,
  now = new Date(),
): StreakInfo {
  const weeks = new Set<number>();
  for (const s of sessions) {
    if (s.status !== 'completed') continue;
    if (optionalWorkoutIds.has(s.workoutId)) continue;
    weeks.add(weekStart(new Date(s.startedAt)));
  }
  if (weeks.size === 0) return { current: 0, longest: 0 };

  const sorted = [...weeks].sort((a, b) => a - b);
  let longest = 1;
  let run = 1;
  for (let i = 1; i < sorted.length; i++) {
    // Compare by week distance; DST shifts are < 1 day, so round.
    const gap = Math.round((sorted[i]! - sorted[i - 1]!) / WEEK_MS);
    run = gap === 1 ? run + 1 : 1;
    if (run > longest) longest = run;
  }

  // Current streak: count back from this week; a streak survives if this
  // week has no session yet but last week does (the week is not over).
  const thisWeek = weekStart(now);
  let cursor = weeks.has(thisWeek) ? thisWeek : thisWeek - WEEK_MS;
  let current = 0;
  while (weeks.has(cursor)) {
    current += 1;
    cursor -= WEEK_MS;
  }
  return { current, longest };
}

export function sessionsInLastDays(sessions: Session[], days: number, now = new Date()): number {
  const cutoff = now.getTime() - days * 24 * 3600 * 1000;
  return sessions.filter(
    (s) => s.status === 'completed' && new Date(s.startedAt).getTime() >= cutoff,
  ).length;
}

/* ---------------------- per-exercise progression --------------------- */

export interface ExerciseProgression {
  name: string;
  unit: Unit;
  heaviestWeight: number;
  bestSetVolume: number; // best single-set weight × reps
  /** volume per session, chronological, for the sparkline */
  volumeSeries: { date: string; volume: number }[];
  sessionCount: number;
}

/**
 * Progression is keyed by exercise name (case-insensitive) so history
 * survives workout deletion and recreation. Mixed units for the same name
 * are tracked in whichever unit was used most recently.
 */
export function computeProgressions(sessions: Session[]): ExerciseProgression[] {
  const byName = new Map<
    string,
    { name: string; unit: Unit; heaviest: number; bestSet: number; series: Map<string, number> }
  >();

  const chronological = [...sessions].sort(
    (a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime(),
  );

  for (const session of chronological) {
    if (session.status === 'in_progress') continue;
    for (const exLog of session.exercises) {
      const completedSets = exLog.sets.filter((s) => s.outcome === 'completed' && s.actualReps > 0);
      if (completedSets.length === 0) continue;
      const key = exLog.name.trim().toLowerCase();
      let entry = byName.get(key);
      if (!entry) {
        entry = {
          name: exLog.name,
          unit: completedSets[0]!.unit,
          heaviest: 0,
          bestSet: 0,
          series: new Map(),
        };
        byName.set(key, entry);
      }
      let sessionVol = 0;
      for (const s of completedSets) {
        entry.unit = s.unit; // most recent wins
        if (s.weight > entry.heaviest) entry.heaviest = s.weight;
        const setVol = s.weight * s.actualReps;
        if (setVol > entry.bestSet) entry.bestSet = setVol;
        sessionVol += setVol;
      }
      entry.series.set(session.id, (entry.series.get(session.id) ?? 0) + sessionVol);
      // Remember the session date on the series via a parallel structure below.
    }
  }

  const sessionDates = new Map(chronological.map((s) => [s.id, s.startedAt]));

  return [...byName.values()]
    .map((e) => ({
      name: e.name,
      unit: e.unit,
      heaviestWeight: e.heaviest,
      bestSetVolume: e.bestSet,
      volumeSeries: [...e.series.entries()].map(([sessionId, volume]) => ({
        date: sessionDates.get(sessionId) ?? '',
        volume,
      })),
      sessionCount: e.series.size,
    }))
    .sort((a, b) => b.sessionCount - a.sessionCount || a.name.localeCompare(b.name));
}

/* ----------------------- strength tracking helpers ------------------- */

/**
 * Estimated one-rep max (Epley). Combines weight and reps into one number,
 * so "more reps at the same weight" and "more weight" both show as progress.
 * Returns 0 for bodyweight or empty sets.
 */
export function e1rm(weight: number, reps: number): number {
  if (weight <= 0 || reps <= 0) return 0;
  return weight * (1 + reps / 30);
}

export function exerciseKey(name: string): string {
  return name.trim().toLowerCase();
}

function exerciseLogMatches(exLog: ExerciseLog, exerciseId: string | null, name: string): boolean {
  return (exerciseId !== null && exLog.exerciseId === exerciseId) || exerciseKey(exLog.name) === exerciseKey(name);
}

function finishedChronological(sessions: Session[]): Session[] {
  return sessions
    .filter((s) => s.status !== 'in_progress')
    .sort((a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime());
}

export interface Performance {
  date: string;
  sessionId: string;
  sets: SetLog[];
}

/**
 * The most recent finished session where this exercise had at least one
 * completed set. Matches the exercise id first, then the name.
 */
export function lastPerformance(
  sessions: Session[],
  exerciseId: string | null,
  name: string,
  excludeSessionId?: string,
): Performance | null {
  const list = finishedChronological(sessions).reverse();
  for (const s of list) {
    if (s.id === excludeSessionId) continue;
    const exLog = s.exercises.find((x) => exerciseLogMatches(x, exerciseId, name));
    if (!exLog) continue;
    const done = exLog.sets.filter((x) => x.outcome === 'completed');
    if (done.length > 0) return { date: s.startedAt, sessionId: s.id, sets: done };
  }
  return null;
}

/** "60 × 6 · 6 · 6 · 5" (weights shown only when they change). */
export function formatPerformance(sets: SetLog[]): string {
  const parts: string[] = [];
  let lastWeight: number | null = null;
  for (const s of sets) {
    if (s.weight !== lastWeight) {
      parts.push(s.weight > 0 ? `${formatWeight(s.weight)} × ${s.actualReps}` : `${s.actualReps}`);
      lastWeight = s.weight;
    } else {
      parts.push(`${s.actualReps}`);
    }
  }
  return parts.join(' · ');
}

export function formatWeight(w: number): string {
  return Number.isInteger(w) ? String(w) : w.toFixed(1).replace(/\.0$/, '');
}

export interface Bests {
  sessions: number;
  bestE1rm: number;
  heaviest: number;
  mostReps: number;
}

/** All-time bests for an exercise, from finished sessions. */
export function exerciseBests(
  sessions: Session[],
  exerciseId: string | null,
  name: string,
  excludeSessionId?: string,
): Bests {
  const b: Bests = { sessions: 0, bestE1rm: 0, heaviest: 0, mostReps: 0 };
  for (const s of finishedChronological(sessions)) {
    if (s.id === excludeSessionId) continue;
    const exLog = s.exercises.find((x) => exerciseLogMatches(x, exerciseId, name));
    if (!exLog) continue;
    const done = exLog.sets.filter((x) => x.outcome === 'completed' && x.actualReps > 0);
    if (done.length === 0) continue;
    b.sessions += 1;
    for (const set of done) {
      b.bestE1rm = Math.max(b.bestE1rm, e1rm(set.weight, set.actualReps));
      b.heaviest = Math.max(b.heaviest, set.weight);
      b.mostReps = Math.max(b.mostReps, set.actualReps);
    }
  }
  return b;
}

/**
 * A set is a personal record when there is earlier history and it beats it:
 * a higher estimated 1RM for weighted sets, more reps for bodyweight sets.
 */
export function isPersonalRecord(set: SetLog, bests: Bests): boolean {
  if (bests.sessions === 0 || set.outcome !== 'completed' || set.actualReps <= 0) return false;
  if (set.weight > 0) return e1rm(set.weight, set.actualReps) > bests.bestE1rm + 0.01;
  return set.actualReps > bests.mostReps;
}

/**
 * Double progression: once every planned set reaches the target reps at the
 * same weight, it is time to add weight.
 */
export function readyToProgress(sets: SetLog[], targetSets: number, targetReps: number): boolean {
  const done = sets.filter((s) => s.outcome === 'completed');
  if (done.length < targetSets || done.length === 0) return false;
  const weight = done[0]!.weight;
  return done.every((s) => s.actualReps >= targetReps && s.weight === weight);
}

/* --------------------------- progression ---------------------------- */

/** The rep range for an exercise. A single target has min === max. */
export function repRange(ex: Pick<Exercise, 'targetReps' | 'repsMax'>): { min: number; max: number } {
  const min = ex.targetReps;
  const max = ex.repsMax !== undefined && ex.repsMax >= min ? ex.repsMax : min;
  return { min, max };
}

/** "8–12" for a range, "8" for a single target. */
export function formatRepTarget(ex: Pick<Exercise, 'targetReps' | 'repsMax'>): string {
  const { min, max } = repRange(ex);
  return min === max ? `${min}` : `${min}–${max}`;
}

/**
 * How much to add when progressing: the exercise's own step, or the
 * Settings step for its unit, doubled when the weight is two dumbbells.
 */
export function weightStepFor(
  ex: Pick<Exercise, 'unit' | 'weightStep' | 'pairedDumbbells'>,
  settings: { weightStepLb: number; weightStepKg: number },
): number {
  if (ex.weightStep !== undefined && ex.weightStep > 0) return ex.weightStep;
  const base = ex.unit === 'kg' ? settings.weightStepKg || 2.5 : settings.weightStepLb || 5;
  return ex.pairedDumbbells ? base * 2 : base;
}

/** "120 lb (2 × 60)" for a pair of dumbbells, "35 lb" otherwise. */
export function formatLoad(weight: number, ex: Pick<Exercise, 'unit' | 'pairedDumbbells'>): string {
  if (weight <= 0) return 'Bodyweight';
  const base = `${formatWeight(weight)} ${ex.unit}`;
  return ex.pairedDumbbells ? `${base} (2 × ${formatWeight(weight / 2)})` : base;
}

export type ProgressionAdvice =
  /** Every set reached the top of the range with reps to spare: add weight. */
  | { kind: 'increase'; from: number; to: number; message: string }
  /** Every set reached the top, but at least one was to failure: repeat once. */
  | { kind: 'repeat'; weight: number; message: string }
  /** Bodyweight: every set reached the top. Raise the range or add load. */
  | { kind: 'raise-reps'; message: string }
  /** Still working up through the range at this weight. */
  | { kind: 'build'; weight: number; goal: number; lowest: number; message: string };

/**
 * Double progression. Work up through the rep range at one weight. When
 * every planned set reaches the top of the range, add weight and start
 * again at the bottom. A set taken to failure (0 reps left in the tank)
 * means the top was reached with nothing to spare, so the advice is to
 * repeat the weight once before adding more.
 *
 * `sets` is one session of this exercise. Returns null when that session
 * does not give a clear signal (sets missing, or mixed weights).
 */
export function progressionAdvice(
  sets: SetLog[],
  ex: Pick<Exercise, 'sets' | 'targetReps' | 'repsMax' | 'unit' | 'weightStep' | 'pairedDumbbells'>,
  step: number,
): ProgressionAdvice | null {
  const done = sets.filter((s) => s.outcome === 'completed' && s.actualReps > 0);
  if (done.length === 0 || done.length < ex.sets) return null;
  const weight = done[0]!.weight;
  if (!done.every((s) => s.weight === weight)) return null;
  const { min, max } = repRange(ex);
  const lowest = Math.min(...done.map((s) => s.actualReps));

  if (lowest < max) {
    return {
      kind: 'build',
      weight,
      goal: max,
      lowest,
      message:
        weight > 0
          ? `Stay at ${formatLoad(weight, ex)}. Goal: ${max} reps on every set (lowest last time: ${lowest}).`
          : `Goal: ${max} reps on every set (lowest last time: ${lowest}).`,
    };
  }
  if (weight <= 0) {
    return {
      kind: 'raise-reps',
      message: `Every set hit ${max}. Raise the rep range, or add weight.`,
    };
  }
  if (done.some((s) => s.rir === 0)) {
    return {
      kind: 'repeat',
      weight,
      message: `Every set hit ${max}, but at least one was to failure. Repeat ${formatLoad(weight, ex)} once more, then add weight.`,
    };
  }
  const to = Math.round((weight + step) * 100) / 100;
  return {
    kind: 'increase',
    from: weight,
    to,
    message: `Every set hit ${max} reps. Move up to ${formatLoad(to, ex)} and aim for ${min}+ reps.`,
  };
}

/**
 * True when the last three sessions did not beat the best before them
 * (estimated one-rep max, or most reps for bodyweight). Needs at least
 * four sessions to judge.
 */
export function isPlateau(history: ExerciseHistoryPoint[], window = 3): boolean {
  if (history.length < window + 1) return false;
  const weighted = history.some((h) => h.topWeight > 0);
  const value = (h: ExerciseHistoryPoint) =>
    weighted ? h.bestE1rm : Math.max(...h.sets.map((s) => s.actualReps));
  const before = history.slice(0, -window).map(value);
  const recent = history.slice(-window).map(value);
  return Math.max(...recent) <= Math.max(...before) + 0.01;
}

export interface ExerciseHistoryPoint {
  sessionId: string;
  date: string;
  sets: SetLog[];
  bestE1rm: number;
  topWeight: number;
  totalReps: number;
  volume: number;
}

/** Every finished session that included this exercise, oldest first. */
export function exerciseHistory(sessions: Session[], name: string): ExerciseHistoryPoint[] {
  const key = exerciseKey(name);
  const out: ExerciseHistoryPoint[] = [];
  for (const s of finishedChronological(sessions)) {
    const done = s.exercises
      .filter((x) => exerciseKey(x.name) === key)
      .flatMap((x) => x.sets)
      .filter((x) => x.outcome === 'completed' && x.actualReps > 0);
    if (done.length === 0) continue;
    out.push({
      sessionId: s.id,
      date: s.startedAt,
      sets: done,
      bestE1rm: Math.max(...done.map((x) => e1rm(x.weight, x.actualReps))),
      topWeight: Math.max(...done.map((x) => x.weight)),
      totalReps: done.reduce((a, x) => a + x.actualReps, 0),
      volume: done.reduce((a, x) => a + x.weight * x.actualReps, 0),
    });
  }
  return out;
}

/** Completed working sets in the last `days` days (a simple weekly-volume gauge). */
export function completedSetsInLastDays(sessions: Session[], days: number, now = new Date()): number {
  const cutoff = now.getTime() - days * 24 * 3600 * 1000;
  let n = 0;
  for (const s of sessions) {
    if (s.status === 'in_progress' || new Date(s.startedAt).getTime() < cutoff) continue;
    for (const ex of s.exercises) n += ex.sets.filter((x) => x.outcome === 'completed').length;
  }
  return n;
}

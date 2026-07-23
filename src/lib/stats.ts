import type { Session, Unit } from '@/types';

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

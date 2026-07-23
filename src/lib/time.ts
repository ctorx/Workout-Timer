import type { Workout } from '@/types';

/** 90_000 ms -> "01:30". Hours roll into minutes ("75:00"). */
export function formatMmSs(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** Seconds -> compact human duration: "45s", "12m", "1h 05m". */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}

export function formatClockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function formatShortDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

export function formatWeekday(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { weekday: 'short' });
}

export function formatMonthYear(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
  });
}

export const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

export const DAY_NAMES_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

const SECONDS_PER_REP = 3;
const INTRO_SECONDS = 5;

/** Rough planning estimate: reps at ~3 s each, plus configured rests and intros. */
export function estimateWorkoutSeconds(workout: Workout): number {
  let total = 0;
  workout.exercises.forEach((ex, i) => {
    total += INTRO_SECONDS;
    total += ex.sets * ex.targetReps * SECONDS_PER_REP;
    total += (ex.sets - 1) * ex.restBetweenSets;
    if (i < workout.exercises.length - 1) total += ex.restAfterExercise;
  });
  return total;
}

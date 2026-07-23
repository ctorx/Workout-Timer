export type UUID = string;
export type Unit = 'lb' | 'kg';

export interface Exercise {
  id: UUID;
  name: string;
  weight: number; // >= 0; 0 means bodyweight
  unit: Unit;
  sets: number; // >= 1
  targetReps: number; // >= 1
  restBetweenSets: number; // seconds, >= 0
  restAfterExercise: number; // seconds, >= 0; ignored when this is the last exercise
  notes?: string;
}

export interface Workout {
  id: UUID;
  name: string;
  dayOfWeek: 0 | 1 | 2 | 3 | 4 | 5 | 6 | null; // 0 = Sunday; null = unscheduled
  optional: boolean;
  order: number; // sort order among workouts
  exercises: Exercise[]; // array index IS the exercise order
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}

export type SetOutcome = 'completed' | 'skipped';

export interface SetLog {
  setIndex: number; // 0-based within the exercise
  targetReps: number;
  actualReps: number; // 0 when skipped
  weight: number;
  unit: Unit;
  outcome: SetOutcome;
  startedAt: string;
  completedAt: string;
  workSeconds: number; // measured active time for the set
  restSeconds: number; // actual rest taken after this set
}

export interface ExerciseLog {
  exerciseId: UUID;
  name: string; // denormalized snapshot at session time
  targetSets: number;
  sets: SetLog[];
  outcome: 'completed' | 'partial' | 'skipped';
}

export interface Session {
  id: UUID;
  workoutId: UUID;
  workoutName: string; // denormalized snapshot
  startedAt: string;
  endedAt: string | null;
  status: 'in_progress' | 'completed' | 'abandoned';
  exercises: ExerciseLog[];
  durationSeconds: number;
  totalRestSeconds: number;
}

export interface Settings {
  defaultUnit: Unit;
  defaultRestBetweenSets: number;
  defaultRestAfterExercise: number;
  soundEnabled: boolean;
  vibrationEnabled: boolean;
  keepScreenAwake: boolean;
  countdownBeepsAt: number[]; // default [3, 2, 1]
  theme: 'dark' | 'light' | 'system';
}

/* ------------------------------------------------------------------ */
/* Player (persisted so a crash or refresh resumes exactly)            */
/* ------------------------------------------------------------------ */

export type PlayerPhase =
  | 'idle'
  | 'exercise_intro' // legacy (hydrated sessions map to awaiting_set)
  | 'awaiting_set' // rest over (or workout start): alarm until user starts the set
  | 'set_active'
  | 'rest_set'
  | 'rest_exercise'
  | 'paused'
  | 'complete'
  | 'abandoned';

/** A finished set waiting for its rep count to be committed during rest. */
export interface PendingSet {
  exerciseIndex: number;
  setIndex: number;
  targetReps: number;
  weight: number;
  unit: Unit;
  startedAt: string;
  completedAt: string;
  workSeconds: number;
  /** true when the set was skipped (pre-fills the log with 0 reps) */
  skipped: boolean;
}

export interface TimerSnapshot {
  kind: 'countdown' | 'elapsed' | null;
  /** countdown: absolute epoch ms when it ends */
  endsAt: number | null;
  /** countdown: full duration in ms (for the progress ring) */
  duration: number | null;
  /** elapsed: absolute epoch ms when it started */
  startedAt: number | null;
  /** paused countdown: remaining ms at pause */
  pausedRemaining: number | null;
  /** paused elapsed: elapsed ms at pause */
  pausedElapsed: number | null;
}

export interface PersistedPlayerState {
  schemaVersion: number;
  savedAt: string;
  phase: PlayerPhase;
  pausedFrom: PlayerPhase | null;
  workout: Workout;
  session: Session;
  exerciseIndex: number;
  setIndex: number;
  pending: PendingSet | null;
  pendingReps: number;
  restStartedAt: number | null;
  timer: TimerSnapshot;
}

/* ------------------------------------------------------------------ */
/* Export / import                                                     */
/* ------------------------------------------------------------------ */

export type ExportKind = 'workouts' | 'backup';

export interface ExportFile {
  app: 'workout-timer';
  schemaVersion: number;
  exportedAt: string;
  kind: ExportKind;
  settings: Settings | null;
  sessions: Session[] | null;
  workouts: Workout[];
}

export const SCHEMA_VERSION = 1;

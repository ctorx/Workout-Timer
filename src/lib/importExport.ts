import type {
  ExerciseLog,
  ExportFile,
  ExportKind,
  Session,
  SetLog,
  Settings,
  Workout,
} from '@/types';
import { SCHEMA_VERSION } from '@/types';

/* ------------------------------ export ----------------------------- */

export function buildExportFile(
  kind: ExportKind,
  workouts: Workout[],
  settings: Settings | null,
  sessions: Session[] | null,
): ExportFile {
  return {
    app: 'workout-timer',
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    kind,
    settings: kind === 'backup' ? settings : null,
    sessions: kind === 'backup' ? (sessions ?? []) : null,
    workouts,
  };
}

export function exportFileName(kind: ExportKind, date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `workout-timer-${kind}-${y}-${m}-${d}.json`;
}

/** Plain browser download; deliberately the only way data leaves the device. */
export function downloadJson(fileName: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/* ------------------------------ import ----------------------------- */

export class ImportError extends Error {
  problems: string[];
  constructor(problems: string[]) {
    super(problems.join('\n'));
    this.name = 'ImportError';
    this.problems = problems;
  }
}

type P = string[]; // accumulated problems

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function expectString(v: unknown, path: string, p: P): v is string {
  if (typeof v !== 'string') {
    p.push(`${path}: expected a string, got ${describe(v)}`);
    return false;
  }
  return true;
}

function expectNumber(v: unknown, path: string, p: P, min?: number): v is number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    p.push(`${path}: expected a number, got ${describe(v)}`);
    return false;
  }
  if (min !== undefined && v < min) {
    p.push(`${path}: must be >= ${min}, got ${v}`);
    return false;
  }
  return true;
}

function expectBoolean(v: unknown, path: string, p: P): v is boolean {
  if (typeof v !== 'boolean') {
    p.push(`${path}: expected true or false, got ${describe(v)}`);
    return false;
  }
  return true;
}

function describe(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'an array';
  return typeof v;
}

function validateExercise(v: unknown, path: string, p: P): void {
  if (!isObj(v)) {
    p.push(`${path}: expected an exercise object, got ${describe(v)}`);
    return;
  }
  expectString(v.id, `${path}.id`, p);
  if (expectString(v.name, `${path}.name`, p) && v.name.trim() === '') {
    p.push(`${path}.name: must not be empty`);
  }
  expectNumber(v.weight, `${path}.weight`, p, 0);
  expectNumber(v.sets, `${path}.sets`, p, 1);
  expectNumber(v.targetReps, `${path}.targetReps`, p, 1);
  expectNumber(v.restBetweenSets, `${path}.restBetweenSets`, p, 0);
  expectNumber(v.restAfterExercise, `${path}.restAfterExercise`, p, 0);
  if (v.unit !== 'lb' && v.unit !== 'kg') {
    p.push(`${path}.unit: expected "lb" or "kg", got ${JSON.stringify(v.unit)}`);
  }
  if (v.notes !== undefined && typeof v.notes !== 'string') {
    p.push(`${path}.notes: expected a string when present`);
  }
}

function validateWorkout(v: unknown, path: string, p: P): void {
  if (!isObj(v)) {
    p.push(`${path}: expected a workout object, got ${describe(v)}`);
    return;
  }
  expectString(v.id, `${path}.id`, p);
  if (expectString(v.name, `${path}.name`, p) && v.name.trim() === '') {
    p.push(`${path}.name: must not be empty`);
  }
  if (
    v.dayOfWeek !== null &&
    !(typeof v.dayOfWeek === 'number' && Number.isInteger(v.dayOfWeek) && v.dayOfWeek >= 0 && v.dayOfWeek <= 6)
  ) {
    p.push(`${path}.dayOfWeek: expected 0–6 or null, got ${JSON.stringify(v.dayOfWeek)}`);
  }
  expectBoolean(v.optional, `${path}.optional`, p);
  expectNumber(v.order, `${path}.order`, p);
  expectString(v.createdAt, `${path}.createdAt`, p);
  expectString(v.updatedAt, `${path}.updatedAt`, p);
  if (!Array.isArray(v.exercises)) {
    p.push(`${path}.exercises: expected an array, got ${describe(v.exercises)}`);
  } else {
    v.exercises.forEach((ex, i) => validateExercise(ex, `${path}.exercises[${i}]`, p));
  }
}

function validateSetLog(v: unknown, path: string, p: P): void {
  if (!isObj(v)) {
    p.push(`${path}: expected a set log object, got ${describe(v)}`);
    return;
  }
  expectNumber(v.setIndex, `${path}.setIndex`, p, 0);
  expectNumber(v.targetReps, `${path}.targetReps`, p, 0);
  expectNumber(v.actualReps, `${path}.actualReps`, p, 0);
  expectNumber(v.weight, `${path}.weight`, p, 0);
  if (v.unit !== 'lb' && v.unit !== 'kg') {
    p.push(`${path}.unit: expected "lb" or "kg"`);
  }
  if (v.outcome !== 'completed' && v.outcome !== 'skipped') {
    p.push(`${path}.outcome: expected "completed" or "skipped"`);
  }
  expectString(v.startedAt, `${path}.startedAt`, p);
  expectString(v.completedAt, `${path}.completedAt`, p);
  expectNumber(v.workSeconds, `${path}.workSeconds`, p, 0);
  expectNumber(v.restSeconds, `${path}.restSeconds`, p, 0);
}

function validateSession(v: unknown, path: string, p: P): void {
  if (!isObj(v)) {
    p.push(`${path}: expected a session object, got ${describe(v)}`);
    return;
  }
  expectString(v.id, `${path}.id`, p);
  expectString(v.workoutId, `${path}.workoutId`, p);
  expectString(v.workoutName, `${path}.workoutName`, p);
  expectString(v.startedAt, `${path}.startedAt`, p);
  if (v.endedAt !== null && typeof v.endedAt !== 'string') {
    p.push(`${path}.endedAt: expected a string or null`);
  }
  if (v.status !== 'in_progress' && v.status !== 'completed' && v.status !== 'abandoned') {
    p.push(`${path}.status: expected "in_progress", "completed" or "abandoned"`);
  }
  expectNumber(v.durationSeconds, `${path}.durationSeconds`, p, 0);
  expectNumber(v.totalRestSeconds, `${path}.totalRestSeconds`, p, 0);
  if (!Array.isArray(v.exercises)) {
    p.push(`${path}.exercises: expected an array`);
    return;
  }
  v.exercises.forEach((exLog, i) => {
    const exPath = `${path}.exercises[${i}]`;
    if (!isObj(exLog)) {
      p.push(`${exPath}: expected an exercise log object`);
      return;
    }
    expectString(exLog.exerciseId, `${exPath}.exerciseId`, p);
    expectString(exLog.name, `${exPath}.name`, p);
    expectNumber(exLog.targetSets, `${exPath}.targetSets`, p, 0);
    if (exLog.outcome !== 'completed' && exLog.outcome !== 'partial' && exLog.outcome !== 'skipped') {
      p.push(`${exPath}.outcome: expected "completed", "partial" or "skipped"`);
    }
    if (!Array.isArray(exLog.sets)) {
      p.push(`${exPath}.sets: expected an array`);
    } else {
      exLog.sets.forEach((s, j) => validateSetLog(s, `${exPath}.sets[${j}]`, p));
    }
  });
}

function validateSettings(v: unknown, path: string, p: P): void {
  if (!isObj(v)) {
    p.push(`${path}: expected a settings object, got ${describe(v)}`);
    return;
  }
  if (v.defaultUnit !== 'lb' && v.defaultUnit !== 'kg') {
    p.push(`${path}.defaultUnit: expected "lb" or "kg"`);
  }
  expectNumber(v.defaultRestBetweenSets, `${path}.defaultRestBetweenSets`, p, 0);
  expectNumber(v.defaultRestAfterExercise, `${path}.defaultRestAfterExercise`, p, 0);
  expectBoolean(v.soundEnabled, `${path}.soundEnabled`, p);
  expectBoolean(v.vibrationEnabled, `${path}.vibrationEnabled`, p);
  expectBoolean(v.keepScreenAwake, `${path}.keepScreenAwake`, p);
  if (!Array.isArray(v.countdownBeepsAt) || v.countdownBeepsAt.some((n) => typeof n !== 'number')) {
    p.push(`${path}.countdownBeepsAt: expected an array of numbers`);
  }
  if (v.theme !== 'dark' && v.theme !== 'light' && v.theme !== 'system') {
    p.push(`${path}.theme: expected "dark", "light" or "system"`);
  }
}

/**
 * Parses and validates an export file. Throws ImportError with a list of
 * specific problems; never returns a partially valid result.
 */
export function parseImportFile(text: string): ExportFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new ImportError([
      `Not valid JSON: ${err instanceof Error ? err.message : 'parse error'}`,
    ]);
  }
  const p: P = [];
  if (!isObj(raw)) {
    throw new ImportError(['Top level: expected a JSON object']);
  }
  if (raw.app !== 'workout-timer') {
    p.push(`app: expected "workout-timer", got ${JSON.stringify(raw.app)} — is this a Workout Timer export?`);
  }
  if (typeof raw.schemaVersion !== 'number') {
    p.push('schemaVersion: expected a number');
  } else if (raw.schemaVersion > SCHEMA_VERSION) {
    p.push(
      `schemaVersion: this file is version ${raw.schemaVersion}, but this app understands up to version ${SCHEMA_VERSION}. Update the app before importing.`,
    );
  }
  if (raw.kind !== 'workouts' && raw.kind !== 'backup') {
    p.push(`kind: expected "workouts" or "backup", got ${JSON.stringify(raw.kind)}`);
  }
  if (p.length > 0) throw new ImportError(p);

  if (!Array.isArray(raw.workouts)) {
    p.push(`workouts: expected an array, got ${describe(raw.workouts)}`);
  } else {
    raw.workouts.forEach((w, i) => validateWorkout(w, `workouts[${i}]`, p));
  }
  if (raw.kind === 'backup') {
    if (raw.sessions !== null && raw.sessions !== undefined) {
      if (!Array.isArray(raw.sessions)) {
        p.push(`sessions: expected an array or null, got ${describe(raw.sessions)}`);
      } else {
        raw.sessions.forEach((s, i) => validateSession(s, `sessions[${i}]`, p));
      }
    }
    if (raw.settings !== null && raw.settings !== undefined) {
      validateSettings(raw.settings, 'settings', p);
    }
  }
  if (p.length > 0) throw new ImportError(p);
  return raw as unknown as ExportFile;
}

/** IDs present both in the import file and in existing data. */
export function findCollisions(file: ExportFile, existingWorkouts: Workout[], existingSessions: Session[]): {
  workoutIds: string[];
  sessionIds: string[];
} {
  const workoutIds = new Set(existingWorkouts.map((w) => w.id));
  const sessionIds = new Set(existingSessions.map((s) => s.id));
  return {
    workoutIds: file.workouts.filter((w) => workoutIds.has(w.id)).map((w) => w.id),
    sessionIds: (file.sessions ?? []).filter((s) => sessionIds.has(s.id)).map((s) => s.id),
  };
}

export type { SetLog, ExerciseLog };

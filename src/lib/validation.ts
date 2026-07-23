import type { Exercise, Workout } from '@/types';

export interface ExerciseErrors {
  name?: string;
  weight?: string;
  sets?: string;
  targetReps?: string;
  restBetweenSets?: string;
  restAfterExercise?: string;
}

export interface WorkoutErrors {
  name?: string;
  exercises: Map<string, ExerciseErrors>;
}

function isCount(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && Number.isFinite(n);
}

export function validateExercise(ex: Exercise): ExerciseErrors {
  const errors: ExerciseErrors = {};
  if (!ex.name.trim()) errors.name = 'Give this exercise a name.';
  if (typeof ex.weight !== 'number' || !Number.isFinite(ex.weight) || ex.weight < 0) {
    errors.weight = 'Weight must be 0 or more (0 = bodyweight).';
  }
  if (!isCount(ex.sets) || ex.sets < 1) errors.sets = 'At least 1 set.';
  if (!isCount(ex.targetReps) || ex.targetReps < 1) errors.targetReps = 'At least 1 rep.';
  if (!isCount(ex.restBetweenSets) || ex.restBetweenSets < 0) {
    errors.restBetweenSets = 'Rest must be 0 seconds or more.';
  }
  if (!isCount(ex.restAfterExercise) || ex.restAfterExercise < 0) {
    errors.restAfterExercise = 'Rest must be 0 seconds or more.';
  }
  return errors;
}

export function validateWorkout(workout: Workout): WorkoutErrors {
  const errors: WorkoutErrors = { exercises: new Map() };
  if (!workout.name.trim()) errors.name = 'Give this workout a name.';
  for (const ex of workout.exercises) {
    const exErrors = validateExercise(ex);
    if (Object.keys(exErrors).length > 0) errors.exercises.set(ex.id, exErrors);
  }
  return errors;
}

export function workoutIsValid(errors: WorkoutErrors): boolean {
  return !errors.name && errors.exercises.size === 0;
}

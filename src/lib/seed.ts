import type { Workout } from '@/types';
import { uuid } from '@/lib/id';

/** A sample workout created once on first run so the app is not empty. */
export function buildSeedWorkout(): Workout {
  const now = new Date().toISOString();
  return {
    id: uuid(),
    name: 'Full body (sample)',
    dayOfWeek: null,
    optional: true,
    order: 0,
    createdAt: now,
    updatedAt: now,
    exercises: [
      {
        id: uuid(),
        name: 'Goblet squat',
        weight: 35,
        unit: 'lb',
        sets: 3,
        targetReps: 10,
        restBetweenSets: 90,
        restAfterExercise: 120,
        notes: 'Heels down, chest up',
      },
      {
        id: uuid(),
        name: 'Push-up',
        weight: 0,
        unit: 'lb',
        sets: 3,
        targetReps: 12,
        restBetweenSets: 60,
        restAfterExercise: 120,
      },
      {
        id: uuid(),
        name: 'One-arm row',
        weight: 40,
        unit: 'lb',
        sets: 3,
        targetReps: 10,
        restBetweenSets: 60,
        restAfterExercise: 0,
      },
    ],
  };
}

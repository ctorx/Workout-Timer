import { defineStore } from 'pinia';
import type { Exercise, Workout } from '@/types';
import { uuid } from '@/lib/id';
import { loadWorkouts, saveWorkouts, LS_KEYS, readLocal, writeLocal } from '@/lib/persistence';
import { buildSeedWorkout } from '@/lib/seed';
import { useSettingsStore } from '@/stores/settings';

export const useWorkoutsStore = defineStore('workouts', {
  state: (): { workouts: Workout[]; loaded: boolean } => ({
    workouts: [],
    loaded: false,
  }),
  getters: {
    /** Sorted by user-defined order. */
    ordered(state): Workout[] {
      return [...state.workouts].sort((a, b) => a.order - b.order);
    },
    byId(state) {
      return (id: string): Workout | undefined => state.workouts.find((w) => w.id === id);
    },
  },
  actions: {
    async load() {
      if (this.loaded) return;
      this.workouts = await loadWorkouts();
      // First run: seed a sample workout so the app is not empty.
      if (this.workouts.length === 0 && !readLocal<boolean>(LS_KEYS.seeded)) {
        this.workouts = [buildSeedWorkout()];
        writeLocal(LS_KEYS.seeded, true);
        await this.persist();
      }
      this.loaded = true;
    },
    async persist() {
      await saveWorkouts(JSON.parse(JSON.stringify(this.workouts)) as Workout[]);
    },
    newExercise(): Exercise {
      const settings = useSettingsStore().settings;
      return {
        id: uuid(),
        name: '',
        weight: 0,
        unit: settings.defaultUnit,
        sets: 3,
        targetReps: 10,
        restBetweenSets: settings.defaultRestBetweenSets,
        restAfterExercise: settings.defaultRestAfterExercise,
      };
    },
    /** Creates an empty workout, returns its id. Not persisted until saved valid. */
    createDraft(): Workout {
      const now = new Date().toISOString();
      return {
        id: uuid(),
        name: '',
        dayOfWeek: null,
        optional: false,
        order: this.workouts.length > 0 ? Math.max(...this.workouts.map((w) => w.order)) + 1 : 0,
        exercises: [this.newExercise()],
        createdAt: now,
        updatedAt: now,
      };
    },
    async upsert(workout: Workout) {
      workout.updatedAt = new Date().toISOString();
      const idx = this.workouts.findIndex((w) => w.id === workout.id);
      if (idx >= 0) this.workouts[idx] = workout;
      else this.workouts.push(workout);
      await this.persist();
    },
    async remove(id: string) {
      this.workouts = this.workouts.filter((w) => w.id !== id);
      await this.persist();
    },
    async duplicate(id: string): Promise<Workout | undefined> {
      const source = this.workouts.find((w) => w.id === id);
      if (!source) return undefined;
      const now = new Date().toISOString();
      const copy: Workout = {
        ...JSON.parse(JSON.stringify(source)),
        id: uuid(),
        name: `${source.name} copy`,
        order: Math.max(...this.workouts.map((w) => w.order)) + 1,
        createdAt: now,
        updatedAt: now,
      };
      copy.exercises = copy.exercises.map((ex) => ({ ...ex, id: uuid() }));
      this.workouts.push(copy);
      await this.persist();
      return copy;
    },
    /** Moves a workout one step in the ordered list. */
    async move(id: string, direction: -1 | 1) {
      const list = this.ordered;
      const idx = list.findIndex((w) => w.id === id);
      const target = idx + direction;
      if (idx < 0 || target < 0 || target >= list.length) return;
      const a = list[idx]!;
      const b = list[target]!;
      [a.order, b.order] = [b.order, a.order];
      await this.persist();
    },
    async replaceAll(workouts: Workout[]) {
      this.workouts = workouts;
      await this.persist();
    },
  },
});

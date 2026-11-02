import { defineStore } from 'pinia';
import type { Session } from '@/types';
import { loadSessions, saveSession, deleteSession } from '@/lib/persistence';
import { exerciseKey, resolveBodyLoads } from '@/lib/stats';
import { useSettingsStore } from '@/stores/settings';
import { useWorkoutsStore } from '@/stores/workouts';

export const useSessionsStore = defineStore('sessions', {
  state: (): { sessions: Session[]; loaded: boolean } => ({
    sessions: [],
    loaded: false,
  }),
  getters: {
    /**
     * Sessions for charts, records and advice. Bodyweight sets logged
     * without a bodyweight part (older sets, or before a bodyweight was set)
     * get one from the current bodyweight. Stored sessions are not changed.
     */
    forStats(state): Session[] {
      const settings = useSettingsStore().settings;
      const workouts = useWorkoutsStore().workouts;
      const byId = new Map<string, number>();
      const byName = new Map<string, number>();
      for (const w of workouts) {
        for (const ex of w.exercises) {
          if (!ex.bodyweightShare) continue;
          byId.set(ex.id, ex.bodyweightShare);
          byName.set(exerciseKey(ex.name), ex.bodyweightShare);
        }
      }
      return resolveBodyLoads(
        state.sessions,
        (exLog) => byId.get(exLog.exerciseId) ?? byName.get(exerciseKey(exLog.name)),
        settings,
      );
    },
    /** Reverse chronological. */
    ordered(state): Session[] {
      return [...state.sessions].sort(
        (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
      );
    },
    byId(state) {
      return (id: string): Session | undefined => state.sessions.find((s) => s.id === id);
    },
    lastCompletedFor(state) {
      return (workoutId: string): Session | undefined => {
        let best: Session | undefined;
        for (const s of state.sessions) {
          if (s.workoutId !== workoutId || s.status !== 'completed') continue;
          if (!best || new Date(s.startedAt) > new Date(best.startedAt)) best = s;
        }
        return best;
      };
    },
  },
  actions: {
    async load() {
      if (this.loaded) return;
      this.sessions = await loadSessions();
      this.loaded = true;
    },
    async add(session: Session) {
      const idx = this.sessions.findIndex((s) => s.id === session.id);
      if (idx >= 0) this.sessions[idx] = session;
      else this.sessions.push(session);
      await saveSession(JSON.parse(JSON.stringify(session)) as Session);
    },
    async remove(id: string) {
      this.sessions = this.sessions.filter((s) => s.id !== id);
      await deleteSession(id);
    },
    /** Deletes every finished/abandoned session. Leaves workouts and settings alone. */
    async clearHistory() {
      const ids = this.sessions.map((s) => s.id);
      this.sessions = [];
      await Promise.all(ids.map((id) => deleteSession(id)));
    },
    async replaceAll(sessions: Session[]) {
      // Used by import-replace; caller has already persisted via importer.
      this.sessions = sessions;
    },
  },
});

import { defineStore } from 'pinia';
import type { Session } from '@/types';
import { loadSessions, saveSession, deleteSession } from '@/lib/persistence';

export const useSessionsStore = defineStore('sessions', {
  state: (): { sessions: Session[]; loaded: boolean } => ({
    sessions: [],
    loaded: false,
  }),
  getters: {
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
    async replaceAll(sessions: Session[]) {
      // Used by import-replace; caller has already persisted via importer.
      this.sessions = sessions;
    },
  },
});

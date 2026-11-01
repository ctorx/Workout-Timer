<script setup lang="ts">
import { computed, ref } from 'vue';
import type { Session } from '@/types';
import { useSessionsStore } from '@/stores/sessions';
import { useWorkoutsStore } from '@/stores/workouts';
import {
  computeStreaks,
  completedSetsInLastDays,
  exerciseHistory,
  formatPerformance,
  formatWeight,
  sessionsInLastDays,
  sessionVolume,
  formatVolume,
  sessionCompletionPercent,
} from '@/lib/stats';
import {
  formatClockTime,
  formatDuration,
  formatMonthYear,
  formatShortDate,
  formatWeekday,
} from '@/lib/time';
import SparkLine from '@/components/SparkLine.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';

const sessions = useSessionsStore();
const workouts = useWorkoutsStore();

const filterWorkoutId = ref<string>('');
const clearOpen = ref(false);

async function clearHistory(): Promise<void> {
  clearOpen.value = false;
  await sessions.clearHistory();
  filterWorkoutId.value = '';
}

const finished = computed(() =>
  sessions.ordered.filter((s) => s.status !== 'in_progress'),
);

const filtered = computed(() =>
  filterWorkoutId.value
    ? finished.value.filter((s) => s.workoutId === filterWorkoutId.value)
    : finished.value,
);

/** Names for the filter: current workouts plus any deleted ones in history. */
const filterOptions = computed(() => {
  const seen = new Map<string, string>();
  for (const w of workouts.ordered) seen.set(w.id, w.name);
  for (const s of finished.value) if (!seen.has(s.workoutId)) seen.set(s.workoutId, `${s.workoutName} (deleted)`);
  return [...seen.entries()].map(([id, name]) => ({ id, name }));
});

interface MonthGroup {
  label: string;
  sessions: Session[];
}

const byMonth = computed<MonthGroup[]>(() => {
  const groups: MonthGroup[] = [];
  let currentLabel = '';
  for (const s of filtered.value) {
    const label = formatMonthYear(s.startedAt);
    if (label !== currentLabel) {
      groups.push({ label, sessions: [] });
      currentLabel = label;
    }
    groups[groups.length - 1]!.sessions.push(s);
  }
  return groups;
});

/* ------------------------------- stats ------------------------------- */

const optionalIds = computed(
  () => new Set(workouts.ordered.filter((w) => w.optional).map((w) => w.id)),
);
const streaks = computed(() => computeStreaks(finished.value, optionalIds.value));
const last7 = computed(() => sessionsInLastDays(finished.value, 7));
const last30 = computed(() => sessionsInLastDays(finished.value, 30));
const setsThisWeek = computed(() => completedSetsInLastDays(finished.value, 7));

/** One row per exercise ever logged, most-trained first. */
const exerciseRows = computed(() => {
  const names = new Map<string, string>();
  for (const s of finished.value) for (const ex of s.exercises) {
    const key = ex.name.trim().toLowerCase();
    if (!names.has(key)) names.set(key, ex.name);
  }
  return [...names.values()]
    .map((name) => {
      const h = exerciseHistory(finished.value, name);
      const weighted = h.some((p) => p.topWeight > 0);
      const series = h.map((p) => (weighted ? p.bestE1rm : Math.max(...p.sets.map((x) => x.actualReps))));
      const last = h[h.length - 1];
      return { name, sessions: h.length, series, last, weighted };
    })
    .filter((r) => r.sessions > 0)
    .sort((a, b) => b.sessions - a.sessions || a.name.localeCompare(b.name));
});
const statsOpen = ref(true);
</script>

<template>
  <main class="safe-top mx-auto w-full max-w-3xl px-4 pb-6">
    <header class="flex items-center justify-between gap-3 py-4">
      <h1 class="text-2xl font-bold tracking-tight">History</h1>
      <button
        v-if="finished.length > 0"
        type="button"
        class="min-h-[44px] rounded-xl px-3 text-sm font-medium text-danger"
        @click="clearOpen = true"
      >
        Clear history
      </button>
    </header>

    <!-- Stats summary -->
    <section class="rounded-2xl border border-border bg-surface-1 p-4">
      <div class="tnum grid grid-cols-2 gap-3 text-center sm:grid-cols-4">
        <div>
          <p class="text-2xl font-bold">{{ streaks.current }}</p>
          <p class="text-[11px] text-muted">week streak (best {{ streaks.longest }})</p>
        </div>
        <div>
          <p class="text-2xl font-bold">{{ last7 }}</p>
          <p class="text-[11px] text-muted">workouts, last 7 days</p>
        </div>
        <div>
          <p class="text-2xl font-bold">{{ setsThisWeek }}</p>
          <p class="text-[11px] text-muted">working sets, last 7 days</p>
        </div>
        <div>
          <p class="text-2xl font-bold">{{ last30 }}</p>
          <p class="text-[11px] text-muted">workouts, last 30 days</p>
        </div>
      </div>

      <template v-if="exerciseRows.length > 0">
        <button
          type="button"
          class="mt-3 flex min-h-[44px] w-full items-center justify-between border-t border-border pt-2 text-sm font-medium text-muted"
          :aria-expanded="statsOpen"
          @click="statsOpen = !statsOpen"
        >
          Progress by exercise
          <span aria-hidden="true">{{ statsOpen ? '▾' : '▸' }}</span>
        </button>
        <ul v-if="statsOpen" class="mt-1 grid gap-1 sm:grid-cols-2">
          <li v-for="r in exerciseRows" :key="r.name">
            <router-link
              :to="{ name: 'exercise-detail', params: { name: r.name } }"
              class="flex items-center justify-between gap-3 rounded-xl px-2 py-2 hover:bg-surface-2"
            >
              <div class="min-w-0">
                <p class="truncate text-sm font-medium">{{ r.name }}</p>
                <p class="tnum truncate text-xs text-muted">
                  <template v-if="r.last">{{ formatPerformance(r.last.sets) }}</template>
                  <template v-if="r.weighted && r.last"> · e1RM {{ formatWeight(Math.round(r.last.bestE1rm)) }}</template>
                </p>
              </div>
              <SparkLine :values="r.series" :width="80" :height="28" />
            </router-link>
          </li>
        </ul>
      </template>
    </section>

    <!-- Filter -->
    <div v-if="finished.length > 0" class="mt-4">
      <label class="sr-only" for="history-filter">Filter by workout</label>
      <select
        id="history-filter"
        v-model="filterWorkoutId"
        class="min-h-[44px] w-full rounded-xl border border-border bg-surface-1 px-3 text-sm"
      >
        <option value="">All workouts</option>
        <option v-for="opt in filterOptions" :key="opt.id" :value="opt.id">{{ opt.name }}</option>
      </select>
    </div>

    <!-- Empty states that say what to do -->
    <p v-if="finished.length === 0" class="mt-16 text-center text-sm text-muted">
      No sessions yet. Start a workout from the Today tab — every set you
      complete is logged here automatically.
    </p>
    <p v-else-if="filtered.length === 0" class="mt-10 text-center text-sm text-muted">
      No sessions for this workout yet. Pick another filter, or play it once
      from the Today tab.
    </p>

    <!-- Session list -->
    <section v-for="group in byMonth" :key="group.label" class="mt-5">
      <h2 class="mb-2 px-1 text-xs font-semibold uppercase tracking-widest text-faint">
        {{ group.label }}
      </h2>
      <div class="flex flex-col gap-2">
        <router-link
          v-for="s in group.sessions"
          :key="s.id"
          :to="{ name: 'session-detail', params: { id: s.id } }"
          class="rounded-2xl border border-border bg-surface-1 px-4 py-3"
        >
          <div class="flex items-baseline justify-between">
            <p class="font-semibold">
              {{ s.workoutName }}
              <span
                v-if="s.status === 'abandoned'"
                class="ml-1 rounded-full border border-warn/60 px-2 py-0.5 text-[10px] font-medium uppercase text-warn"
              >
                Abandoned
              </span>
            </p>
            <p class="tnum text-xs text-muted">
              {{ formatWeekday(s.startedAt) }} {{ formatShortDate(s.startedAt) }} ·
              {{ formatClockTime(s.startedAt) }}
            </p>
          </div>
          <p class="tnum mt-1 text-xs text-muted">
            {{ formatDuration(s.durationSeconds) }} · {{ sessionCompletionPercent(s) }}% ·
            volume {{ formatVolume(sessionVolume(s)) }}
          </p>
        </router-link>
      </div>
    </section>

    <ConfirmDialog
      :open="clearOpen"
      title="Clear history?"
      message="Every logged session will be deleted. Workouts and settings are kept. This cannot be undone."
      confirm-label="Clear history"
      danger
      @confirm="clearHistory"
      @cancel="clearOpen = false"
    />
  </main>
</template>

<style scoped>
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
</style>

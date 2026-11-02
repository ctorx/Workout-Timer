<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { useSessionsStore } from '@/stores/sessions';
import { exerciseHistory, formatPerformance, formatWeight, isPlateau } from '@/lib/stats';
import { formatShortDate, formatWeekday } from '@/lib/time';
import TrendChart from '@/components/TrendChart.vue';

const route = useRoute();
const sessions = useSessionsStore();

const name = computed(() => decodeURIComponent(route.params.name as string));
const history = computed(() => exerciseHistory(sessions.forStats, name.value));
const unit = computed(() => {
  const last = history.value[history.value.length - 1];
  return last?.sets[0]?.unit ?? 'lb';
});

/**
 * Exercises with a load track estimated 1RM; plain bodyweight tracks reps.
 * A bodyweight exercise has a load once a bodyweight is set in Settings.
 */
const weighted = computed(() => history.value.some((h) => h.topWeight > 0));
const countsBodyweight = computed(() =>
  history.value.some((h) => h.sets.some((s) => s.bodyLoad !== undefined)),
);

const points = computed(() =>
  history.value.map((h) => ({
    label: formatShortDate(h.date),
    value: weighted.value ? h.bestE1rm : Math.max(...h.sets.map((s) => s.actualReps)),
    detail: formatPerformance(h.sets),
  })),
);

const best = computed(() => (points.value.length ? Math.max(...points.value.map((p) => p.value)) : 0));
const first = computed(() => points.value[0]?.value ?? 0);
const latest = computed(() => points.value[points.value.length - 1]?.value ?? 0);
const change = computed(() => (first.value > 0 ? ((latest.value - first.value) / first.value) * 100 : 0));

function fmt(v: number): string {
  return weighted.value ? `${formatWeight(Math.round(v))} ${unit.value}` : `${Math.round(v)} reps`;
}

const reversed = computed(() => [...history.value].reverse());
const stalled = computed(() => isPlateau(history.value));

function avgRir(sets: { rir?: number }[]): string | null {
  const vs = sets.map((s) => s.rir).filter((v): v is number => typeof v === 'number');
  if (vs.length === 0) return null;
  return (vs.reduce((a, b) => a + b, 0) / vs.length).toFixed(1);
}
</script>

<template>
  <main class="safe-top mx-auto w-full max-w-3xl px-4 pb-6">
    <header class="flex items-center gap-2 py-4">
      <router-link
        :to="{ name: 'history' }"
        class="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl bg-surface-1 text-muted hover:text-text"
        aria-label="Back to history"
      >
        ←
      </router-link>
      <h1 class="min-w-0 truncate text-xl font-bold tracking-tight">{{ name }}</h1>
    </header>

    <p v-if="history.length === 0" class="mt-16 text-center text-sm text-muted">
      No completed sets of this exercise yet.
    </p>

    <template v-else>
      <dl class="tnum grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div class="rounded-2xl bg-surface-1 px-3 py-3">
          <dt class="text-[11px] text-muted">{{ weighted ? 'Best est. 1-rep max' : 'Best set' }}</dt>
          <dd class="text-xl font-bold">{{ fmt(best) }}</dd>
        </div>
        <div class="rounded-2xl bg-surface-1 px-3 py-3">
          <dt class="text-[11px] text-muted">Latest</dt>
          <dd class="text-xl font-bold">{{ fmt(latest) }}</dd>
        </div>
        <div class="rounded-2xl bg-surface-1 px-3 py-3">
          <dt class="text-[11px] text-muted">Since first session</dt>
          <dd class="text-xl font-bold" :class="change > 0 ? 'text-work' : change < 0 ? 'text-warn' : ''">
            {{ change > 0 ? '+' : '' }}{{ change.toFixed(0) }}%
          </dd>
        </div>
        <div class="rounded-2xl bg-surface-1 px-3 py-3">
          <dt class="text-[11px] text-muted">Sessions</dt>
          <dd class="text-xl font-bold">{{ history.length }}</dd>
        </div>
      </dl>

      <section v-if="stalled" class="mt-3 rounded-2xl border border-warn/40 bg-warn/10 p-4 text-sm">
        <p class="font-semibold text-warn">No gain in the last 3 sessions</p>
        <p class="mt-1 text-muted">
          Your best in the last three sessions did not beat your earlier best. Common fixes: a
          lighter week (about 60% of your usual sets), more sleep and protein, longer rest between
          sets, or a different rep range for a few weeks.
        </p>
      </section>

      <section class="mt-3 rounded-2xl border border-border bg-surface-1 p-4">
        <h2 class="text-sm font-semibold">
          {{ weighted ? 'Estimated 1-rep max per session' : 'Most reps in one set per session' }}
        </h2>
        <p class="mt-0.5 text-xs text-muted">
          {{
            weighted && countsBodyweight
              ? 'Counts your bodyweight plus any added weight, minus assistance. More reps, more weight or less help all show up as progress.'
              : weighted
                ? 'Combines weight and reps, so adding either one shows up as progress.'
                : 'Bodyweight exercise: progress shows up as more reps. Set your bodyweight in Settings to track load.'
          }}
        </p>
        <div class="mt-3">
          <TrendChart
            v-if="points.length > 1"
            :points="points"
            :format="fmt"
            :label="`${name} trend over ${points.length} sessions, from ${fmt(first)} to ${fmt(latest)}`"
          />
          <p v-else class="py-6 text-center text-sm text-muted">
            The chart appears after your second session.
          </p>
        </div>
      </section>

      <h2 class="mb-2 mt-5 px-1 text-xs font-semibold uppercase tracking-widest text-faint">Sessions</h2>
      <ul class="space-y-2">
        <li v-for="h in reversed" :key="h.sessionId">
          <router-link
            :to="{ name: 'session-detail', params: { id: h.sessionId } }"
            class="block rounded-2xl border border-border bg-surface-1 px-4 py-3 hover:border-muted"
          >
            <div class="flex items-baseline justify-between gap-2">
              <p class="text-sm font-semibold">{{ formatWeekday(h.date) }} {{ formatShortDate(h.date) }}</p>
              <p class="tnum text-xs text-muted">{{ weighted ? `e1RM ${fmt(h.bestE1rm)}` : `${h.totalReps} reps` }}</p>
            </div>
            <p class="tnum mt-1 text-sm text-muted">
              {{ formatPerformance(h.sets) }}
              <template v-if="avgRir(h.sets)"> · avg {{ avgRir(h.sets) }} left in tank</template>
            </p>
          </router-link>
        </li>
      </ul>
    </template>
  </main>
</template>

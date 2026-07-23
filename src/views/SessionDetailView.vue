<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { useSessionsStore } from '@/stores/sessions';
import { sessionVolume, formatVolume, sessionCompletionPercent } from '@/lib/stats';
import { formatClockTime, formatDuration, formatShortDate, formatWeekday } from '@/lib/time';

const route = useRoute();
const sessions = useSessionsStore();

const session = computed(() => sessions.byId(route.params.id as string));

const activeSeconds = computed(() =>
  (session.value?.exercises ?? []).reduce(
    (sum, ex) => sum + ex.sets.reduce((a, b) => a + b.workSeconds, 0),
    0,
  ),
);
</script>

<template>
  <main class="safe-top mx-auto w-full max-w-xl px-4 pb-6">
    <header class="flex items-center gap-2 py-4">
      <router-link
        :to="{ name: 'history' }"
        class="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl bg-surface-1 text-muted"
        aria-label="Back to history"
      >
        ←
      </router-link>
      <h1 class="text-xl font-bold tracking-tight">Session</h1>
    </header>

    <div v-if="!session" class="mt-16 text-center text-muted">
      <p>This session no longer exists.</p>
      <router-link :to="{ name: 'history' }" class="mt-2 inline-block text-accent underline">
        Back to history
      </router-link>
    </div>

    <template v-else>
      <section class="rounded-2xl border border-border bg-surface-1 p-4">
        <div class="flex items-baseline justify-between">
          <h2 class="text-lg font-bold">
            {{ session.workoutName }}
            <span
              v-if="session.status === 'abandoned'"
              class="ml-1 rounded-full border border-warn/60 px-2 py-0.5 text-[10px] font-medium uppercase text-warn"
            >
              Abandoned
            </span>
          </h2>
          <p class="tnum text-xs text-muted">
            {{ formatWeekday(session.startedAt) }} {{ formatShortDate(session.startedAt) }} ·
            {{ formatClockTime(session.startedAt) }}
          </p>
        </div>
        <dl class="tnum mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
          <div class="flex justify-between sm:block">
            <dt class="text-muted">Duration</dt>
            <dd class="font-semibold">{{ formatDuration(session.durationSeconds) }}</dd>
          </div>
          <div class="flex justify-between sm:block">
            <dt class="text-muted">Active</dt>
            <dd class="font-semibold">{{ formatDuration(activeSeconds) }}</dd>
          </div>
          <div class="flex justify-between sm:block">
            <dt class="text-muted">Rest</dt>
            <dd class="font-semibold">{{ formatDuration(session.totalRestSeconds) }}</dd>
          </div>
          <div class="flex justify-between sm:block">
            <dt class="text-muted">Volume</dt>
            <dd class="font-semibold">{{ formatVolume(sessionVolume(session)) }}</dd>
          </div>
        </dl>
        <p class="tnum mt-1 text-xs text-muted">{{ sessionCompletionPercent(session) }}% of target sets completed</p>
      </section>

      <section
        v-for="(exLog, i) in session.exercises"
        :key="`${exLog.exerciseId}-${i}`"
        class="mt-3 rounded-2xl border border-border bg-surface-1 p-4"
      >
        <div class="flex items-baseline justify-between">
          <h3 class="font-semibold">{{ exLog.name }}</h3>
          <span
            class="text-xs font-medium"
            :class="{
              'text-work': exLog.outcome === 'completed',
              'text-warn': exLog.outcome === 'partial' || exLog.outcome === 'skipped',
            }"
          >
            {{ exLog.outcome }}
          </span>
        </div>

        <p v-if="exLog.sets.length === 0" class="mt-2 text-sm text-muted">Not reached.</p>

        <table v-else class="tnum mt-2 w-full text-sm">
          <thead>
            <tr class="text-left text-xs text-faint">
              <th class="py-1 font-medium">Set</th>
              <th class="py-1 font-medium">Reps</th>
              <th class="py-1 font-medium">Weight</th>
              <th class="py-1 text-right font-medium">Work</th>
              <th class="py-1 text-right font-medium">Rest</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="set in exLog.sets" :key="set.setIndex" class="border-t border-border/50">
              <td class="py-1.5">{{ set.setIndex + 1 }}</td>
              <td class="py-1.5">
                <template v-if="set.outcome === 'skipped'">
                  <span class="text-warn">skipped</span>
                </template>
                <template v-else>
                  {{ set.actualReps }}<span class="text-faint">/{{ set.targetReps }}</span>
                </template>
              </td>
              <td class="py-1.5">
                {{ set.weight > 0 ? `${set.weight} ${set.unit}` : 'BW' }}
              </td>
              <td class="py-1.5 text-right text-muted">{{ set.workSeconds }}s</td>
              <td class="py-1.5 text-right text-muted">{{ set.restSeconds }}s</td>
            </tr>
          </tbody>
        </table>
      </section>
    </template>
  </main>
</template>

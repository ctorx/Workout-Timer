<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import type { PersistedPlayerState, Workout } from '@/types';
import { useWorkoutsStore } from '@/stores/workouts';
import { useSessionsStore } from '@/stores/sessions';
import { usePlayerStore } from '@/stores/player';
import { clearPlayerState, loadPlayerState } from '@/lib/persistence';
import { unlockAudio } from '@/lib/audio';
import { estimateWorkoutSeconds, formatDuration, formatShortDate, DAY_NAMES } from '@/lib/time';
import ConfirmDialog from '@/components/ConfirmDialog.vue';

const router = useRouter();
const workouts = useWorkoutsStore();
const sessions = useSessionsStore();
const player = usePlayerStore();

const todayDow = new Date().getDay();

const resumable = ref<PersistedPlayerState | null>(null);
onMounted(async () => {
  if (player.isRunning) return;
  const state = await loadPlayerState();
  if (state && state.session.status === 'in_progress') resumable.value = state;
});

function resumeWorkout(): void {
  const state = resumable.value;
  if (!state) return;
  player.hydrate(state, Date.now());
  void router.push({ name: 'play', params: { workoutId: state.workout.id } });
}

async function discardResumable(): Promise<void> {
  await clearPlayerState();
  resumable.value = null;
}

/* ----------------------------- grouping ----------------------------- */

interface DayGroup {
  key: string;
  label: string;
  isToday: boolean;
  workouts: Workout[];
}

const groups = computed<DayGroup[]>(() => {
  const list = workouts.ordered;
  const result: DayGroup[] = [];
  const daysInOrder: (0 | 1 | 2 | 3 | 4 | 5 | 6)[] = [0, 1, 2, 3, 4, 5, 6];
  for (const d of daysInOrder) {
    const items = list.filter((w) => w.dayOfWeek === d);
    if (items.length === 0 && d !== todayDow) continue;
    result.push({
      key: `day-${d}`,
      label: d === todayDow ? `Today · ${DAY_NAMES[d]}` : DAY_NAMES[d]!,
      isToday: d === todayDow,
      workouts: items,
    });
  }
  const unscheduled = list.filter((w) => w.dayOfWeek === null);
  if (unscheduled.length > 0) {
    result.push({ key: 'unscheduled', label: 'Unscheduled', isToday: false, workouts: unscheduled });
  }
  // Today pinned on top; the rest keep Sunday→Saturday order.
  return [...result.filter((g) => g.isToday), ...result.filter((g) => !g.isToday)];
});

const collapsed = ref(new Set<string>());
function toggleGroup(key: string): void {
  if (collapsed.value.has(key)) collapsed.value.delete(key);
  else collapsed.value.add(key);
}
function isExpanded(g: DayGroup): boolean {
  return g.isToday || !collapsed.value.has(g.key);
}

function lastCompletedLabel(w: Workout): string | null {
  const s = sessions.lastCompletedFor(w.id);
  return s ? formatShortDate(s.startedAt) : null;
}

/* ---------------------------- start sheet ---------------------------- */

const sheetWorkout = ref<Workout | null>(null);
const confirmDiscardStart = ref(false);

function openSheet(w: Workout): void {
  sheetWorkout.value = w;
}

function requestStart(): void {
  if (!sheetWorkout.value || sheetWorkout.value.exercises.length === 0) return;
  if (resumable.value) {
    confirmDiscardStart.value = true;
    return;
  }
  startNow();
}

function startNow(): void {
  const w = sheetWorkout.value;
  if (!w) return;
  confirmDiscardStart.value = false;
  resumable.value = null;
  // This tap is the user gesture that unlocks audio for the whole workout.
  unlockAudio();
  player.start(JSON.parse(JSON.stringify(w)) as Workout, Date.now());
  void router.push({ name: 'play', params: { workoutId: w.id } });
}

/* ----------------------------- reordering ---------------------------- */

const reorderMode = ref(false);
</script>

<template>
  <main class="safe-top mx-auto w-full max-w-xl px-4 pb-6">
    <header class="flex items-center justify-between py-4">
      <h1 class="text-2xl font-bold tracking-tight">Workouts</h1>
      <div class="flex gap-2">
        <button
          v-if="workouts.ordered.length > 1"
          type="button"
          class="min-h-[44px] rounded-xl px-3 text-sm font-medium"
          :class="reorderMode ? 'bg-accent text-accent-ink' : 'bg-surface-1 text-muted'"
          @click="reorderMode = !reorderMode"
        >
          {{ reorderMode ? 'Done' : 'Reorder' }}
        </button>
        <router-link
          :to="{ name: 'workout-edit', params: { id: 'new' } }"
          class="flex min-h-[44px] items-center rounded-xl bg-accent px-4 text-sm font-semibold text-accent-ink"
        >
          New workout
        </router-link>
      </div>
    </header>

    <!-- Resume banner -->
    <section
      v-if="resumable"
      class="mb-4 rounded-2xl border border-work/40 bg-surface-1 p-4"
      aria-live="polite"
    >
      <p class="font-semibold">Workout in progress</p>
      <p class="mt-0.5 text-sm text-muted">
        {{ resumable.session.workoutName }} — picks up exactly where you left off.
      </p>
      <div class="mt-3 flex gap-2">
        <button
          type="button"
          class="min-h-[48px] flex-1 rounded-xl bg-work font-semibold text-work-ink"
          @click="resumeWorkout"
        >
          Resume workout
        </button>
        <button
          type="button"
          class="min-h-[48px] rounded-xl bg-surface-2 px-4 text-sm font-medium text-muted"
          @click="discardResumable"
        >
          Discard
        </button>
      </div>
    </section>

    <p v-if="workouts.ordered.length === 0" class="mt-16 text-center text-muted">
      No workouts yet. Tap “New workout” to build your first one.
    </p>

    <section v-for="group in groups" :key="group.key" class="mb-3">
      <button
        type="button"
        class="flex min-h-[44px] w-full items-center justify-between px-1 text-left"
        :aria-expanded="isExpanded(group)"
        @click="!group.isToday && toggleGroup(group.key)"
      >
        <h2
          class="text-xs font-semibold uppercase tracking-widest"
          :class="group.isToday ? 'text-accent' : 'text-faint'"
        >
          {{ group.label }}
        </h2>
        <span v-if="!group.isToday" class="text-xs text-faint" aria-hidden="true">
          {{ isExpanded(group) ? '▾' : `${group.workouts.length} ▸` }}
        </span>
      </button>

      <div v-if="isExpanded(group)" class="flex flex-col gap-2">
        <p
          v-if="group.isToday && group.workouts.length === 0"
          class="rounded-2xl border border-dashed border-border px-4 py-5 text-sm text-muted"
        >
          Nothing scheduled today. Pick any workout below, or assign one to
          {{ DAY_NAMES[todayDow] }} in its editor.
        </p>
        <div
          v-for="w in group.workouts"
          :key="w.id"
          class="flex items-stretch gap-2"
        >
          <button
            type="button"
            class="min-h-[64px] flex-1 rounded-2xl border bg-surface-1 px-4 py-3 text-left"
            :class="w.optional ? 'border-border/50' : 'border-border'"
            @click="openSheet(w)"
          >
            <div class="flex items-center gap-2">
              <span :class="w.optional ? 'font-medium text-muted' : 'font-semibold'">{{ w.name }}</span>
              <span
                v-if="w.optional"
                class="rounded-full border border-border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-faint"
              >
                Optional
              </span>
            </div>
            <div class="tnum mt-1 flex gap-3 text-xs text-muted">
              <span>{{ w.exercises.length }} exercise{{ w.exercises.length === 1 ? '' : 's' }}</span>
              <span>~{{ formatDuration(estimateWorkoutSeconds(w)) }}</span>
              <span v-if="lastCompletedLabel(w)">Last: {{ lastCompletedLabel(w) }}</span>
            </div>
          </button>
          <div v-if="reorderMode" class="flex flex-col justify-center gap-1">
            <button
              type="button"
              class="flex h-[30px] w-11 items-center justify-center rounded-lg bg-surface-2 text-muted"
              aria-label="Move workout up"
              @click="workouts.move(w.id, -1)"
            >
              ▲
            </button>
            <button
              type="button"
              class="flex h-[30px] w-11 items-center justify-center rounded-lg bg-surface-2 text-muted"
              aria-label="Move workout down"
              @click="workouts.move(w.id, 1)"
            >
              ▼
            </button>
          </div>
        </div>
      </div>
    </section>

    <!-- Start sheet -->
    <Teleport to="body">
      <div
        v-if="sheetWorkout"
        class="fixed inset-0 z-40 flex items-end justify-center bg-black/60"
        role="dialog"
        aria-modal="true"
        :aria-label="`Start ${sheetWorkout.name}`"
        @click.self="sheetWorkout = null"
        @keydown.escape="sheetWorkout = null"
      >
        <div class="safe-bottom w-full max-w-xl rounded-t-3xl border-t border-border bg-surface-1 p-5">
          <div class="mx-auto mb-4 h-1 w-10 rounded-full bg-border" aria-hidden="true"></div>
          <div class="flex items-start justify-between gap-3">
            <div>
              <h2 class="text-xl font-bold">{{ sheetWorkout.name }}</h2>
              <p class="tnum mt-1 text-sm text-muted">
                {{ sheetWorkout.exercises.length }} exercises ·
                ~{{ formatDuration(estimateWorkoutSeconds(sheetWorkout)) }}
              </p>
            </div>
            <router-link
              :to="{ name: 'workout-edit', params: { id: sheetWorkout.id } }"
              class="flex min-h-[44px] items-center rounded-xl bg-surface-2 px-4 text-sm font-medium"
            >
              Edit
            </router-link>
          </div>

          <ol class="mt-4 max-h-48 space-y-1 overflow-y-auto text-sm text-muted">
            <li v-for="ex in sheetWorkout.exercises" :key="ex.id" class="flex justify-between">
              <span>{{ ex.name }}</span>
              <span class="tnum">
                {{ ex.sets }}×{{ ex.targetReps }}
                <template v-if="ex.weight > 0">· {{ ex.weight }} {{ ex.unit }}</template>
              </span>
            </li>
          </ol>

          <p v-if="sheetWorkout.exercises.length === 0" class="mt-4 text-sm text-warn">
            This workout has no exercises yet, so it can’t be started. Add at
            least one exercise in the editor.
          </p>

          <button
            type="button"
            class="mt-5 w-full rounded-2xl bg-accent py-5 text-lg font-bold text-accent-ink disabled:opacity-40"
            :disabled="sheetWorkout.exercises.length === 0"
            @click="requestStart"
          >
            Start workout
          </button>
        </div>
      </div>
    </Teleport>

    <ConfirmDialog
      :open="confirmDiscardStart"
      title="Discard unfinished session?"
      message="You have a workout in progress. Starting a new one discards it."
      confirm-label="Start anyway"
      danger
      @confirm="startNow"
      @cancel="confirmDiscardStart = false"
    />
  </main>
</template>

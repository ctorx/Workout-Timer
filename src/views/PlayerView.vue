<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { usePlayerStore } from '@/stores/player';
import { useWorkoutsStore } from '@/stores/workouts';
import { useSettingsStore } from '@/stores/settings';
import { loadPlayerState, LS_KEYS, readLocal, writeLocal } from '@/lib/persistence';
import {
  unlockAudio,
  cueCountdownBeep,
  cueGo,
  cueAlarm,
  cueNewExercise,
  cueComplete,
} from '@/lib/audio';
import { haptics } from '@/lib/haptics';
import { requestWakeLock, releaseWakeLock } from '@/lib/wakeLock';
import { formatMmSs, formatDuration } from '@/lib/time';
import { sessionVolume, formatVolume, sessionCompletionPercent } from '@/lib/stats';
import ProgressRing from '@/components/ProgressRing.vue';
import RepStepper from '@/components/RepStepper.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';

const route = useRoute();
const router = useRouter();
const player = usePlayerStore();
const workouts = useWorkoutsStore();
const settingsStore = useSettingsStore();

const workoutId = computed(() => route.params.workoutId as string);
const routeWorkout = computed(() => workouts.byId(workoutId.value));

/* ------------------------- lifecycle & clock ------------------------- */

let raf = 0;
function frame(): void {
  player.tick(Date.now());
  raf = requestAnimationFrame(frame);
}

onMounted(async () => {
  // Refresh / killed tab directly on this URL: restore the saved session.
  if (player.phase === 'idle') {
    const saved = await loadPlayerState();
    if (saved && saved.session.status === 'in_progress' && saved.workout.id === workoutId.value) {
      player.hydrate(saved, Date.now());
    }
  }
  raf = requestAnimationFrame(frame);
});

onBeforeUnmount(() => {
  cancelAnimationFrame(raf);
  unsubscribe();
  releaseWakeLock();
});

/* ------------------------------- cues -------------------------------- */

const unsubscribe = player.onEvent((event) => {
  const s = settingsStore.settings;
  if (s.soundEnabled) {
    if (event === 'beep') cueCountdownBeep();
    else if (event === 'go') cueGo();
    else if (event === 'alarm') cueAlarm();
    else if (event === 'new_exercise') cueNewExercise();
    else if (event === 'complete') cueComplete();
  }
  if (s.vibrationEnabled) {
    if (event === 'beep') haptics.beep();
    else if (event === 'go' || event === 'alarm') haptics.go();
    else if (event === 'new_exercise') haptics.newExercise();
    else if (event === 'complete') haptics.complete();
  }
});

/* ----------------------------- wake lock ----------------------------- */

watch(
  () => [player.isRunning, settingsStore.settings.keepScreenAwake] as const,
  ([running, wanted]) => {
    if (running && wanted) requestWakeLock();
    else releaseWakeLock();
  },
  { immediate: true },
);

/* --------------------------- derived display -------------------------- */

const phase = computed(() => player.effectivePhase);
const isPaused = computed(() => player.phase === 'paused');
/** After skip (or pause at 0): waiting for a tap on the timer to start. */
const waitingToStart = computed(
  () =>
    isPaused.value &&
    player.pausedFrom === 'set_active' &&
    player.elapsedMs === 0,
);
const timerToggleable = computed(
  () =>
    isPaused.value ||
    phase.value === 'set_active' ||
    phase.value === 'rest_set' ||
    phase.value === 'rest_exercise',
);
const ex = computed(() => player.currentExercise);

function onTimerClick(): void {
  if (!timerToggleable.value) return;
  player.toggleTimer(Date.now());
}

const phaseColor = computed(() => {
  switch (phase.value) {
    case 'set_active':
      return 'text-work';
    case 'rest_set':
    case 'rest_exercise':
      return 'text-rest';
    case 'awaiting_set':
    case 'exercise_intro':
      return 'text-transitionhue';
    default:
      return 'text-muted';
  }
});

const phaseLabel = computed(() => {
  switch (phase.value) {
    case 'awaiting_set':
    case 'exercise_intro':
      return 'Alarm';
    case 'set_active':
      return 'Work';
    case 'rest_set':
    case 'rest_exercise':
      return 'Rest';
    default:
      return '';
  }
});

const bigTime = computed(() => {
  if (phase.value === 'set_active' || phase.value === 'awaiting_set') {
    return formatMmSs(player.elapsedMs);
  }
  return formatMmSs(player.remainingMs);
});

const ringFraction = computed(() => {
  if (phase.value === 'set_active' || phase.value === 'awaiting_set') {
    // No end point: the ring sweeps once per minute.
    return (player.elapsedMs % 60000) / 60000;
  }
  return player.countdownFraction;
});

/** The cursor always points at the set being performed or prepared next. */
const contextSetNumber = computed(() => player.setIndex + 1);
const contextExercise = computed(() => ex.value);

const weightLabel = computed(() => {
  const e = contextExercise.value;
  if (!e) return '';
  return e.weight > 0 ? `${e.weight} ${e.unit}` : 'Bodyweight';
});

const announcement = computed(() => {
  switch (phase.value) {
    case 'awaiting_set':
    case 'exercise_intro':
      return `Rest over — stop the alarm to begin set ${player.setIndex + 1} of ${ex.value?.sets ?? 0}, ${ex.value?.name ?? ''}`;
    case 'set_active':
      return `Working set ${player.setIndex + 1} of ${ex.value?.sets ?? 0}, ${ex.value?.name ?? ''}`;
    case 'rest_set':
      return `Rest, then set ${player.setIndex + 1} of ${ex.value?.sets ?? 0}`;
    case 'rest_exercise':
      return `Rest, next exercise: ${ex.value?.name ?? ''}`;
    case 'complete':
      return 'Workout complete';
    default:
      return '';
  }
});

/* ------------------------------ actions ------------------------------ */

function startWorkout(): void {
  const w = routeWorkout.value;
  if (!w || w.exercises.length === 0) return;
  unlockAudio();
  player.start(JSON.parse(JSON.stringify(w)), Date.now());
}

const confirmStopOpen = ref(false);
async function stopWorkout(): Promise<void> {
  confirmStopOpen.value = false;
  await player.abandon(Date.now());
  await router.push({ name: 'today' });
  player.reset(); // after navigation, so the idle screen never flashes
}

async function saveAndFinish(): Promise<void> {
  await player.saveAndFinish();
  await router.push({ name: 'history' });
  player.reset();
}

function primaryAction(): void {
  const now = Date.now();
  switch (player.phase) {
    case 'idle':
      startWorkout();
      break;
    case 'awaiting_set':
    case 'exercise_intro':
      player.startNextSet(now);
      break;
    case 'set_active':
      player.completeSet(now);
      break;
    case 'paused':
      player.resume(now);
      break;
    case 'complete':
      void saveAndFinish();
      break;
    default:
      break;
  }
}

const showPrimary = computed(
  () => !player.isRestPhase || player.phase === 'paused',
);

const primaryLabel = computed(() => {
  switch (player.phase) {
    case 'idle':
      return 'Start workout';
    case 'awaiting_set':
    case 'exercise_intro':
      return 'Stop alarm';
    case 'set_active':
      return 'Set complete';
    case 'paused':
      return waitingToStart.value ? 'Start set' : 'Resume';
    case 'complete':
      return 'Save & finish';
    default:
      return '';
  }
});

const primaryClasses = computed(() => {
  switch (player.phase) {
    case 'set_active':
      return 'bg-work text-work-ink';
    case 'awaiting_set':
    case 'exercise_intro':
      return 'bg-transitionhue text-transition-ink';
    default:
      return 'bg-accent text-accent-ink';
  }
});

/* -------------------------- screen-awake note ------------------------- */

const showAwakeNote = ref(!readLocal<boolean>(LS_KEYS.iosAudioNoteDismissed));
function dismissAwakeNote(): void {
  showAwakeNote.value = false;
  writeLocal(LS_KEYS.iosAudioNoteDismissed, true);
}

/* ------------------------- completion summary ------------------------- */

const lastLoggedSet = computed(() => {
  const s = player.session;
  if (!s) return null;
  for (let i = s.exercises.length - 1; i >= 0; i--) {
    const sets = s.exercises[i]!.sets;
    if (sets.length > 0) return { exercise: s.exercises[i]!, set: sets[sets.length - 1]! };
  }
  return null;
});

const summaryVolume = computed(() =>
  player.session ? formatVolume(sessionVolume(player.session)) : '0',
);
</script>

<template>
  <main class="safe-top safe-bottom flex min-h-dvh flex-col bg-bg">
    <p class="sr-only" role="status" aria-live="polite">{{ announcement }}</p>

    <!-- storage failure surface (§11.14) -->
    <div
      v-if="player.storageError"
      class="mx-4 mt-2 rounded-xl border border-danger/60 bg-surface-1 px-4 py-3 text-sm text-danger"
      role="alert"
    >
      {{ player.storageError }}
      <router-link :to="{ name: 'settings' }" class="ml-1 underline">Open Settings</router-link>
    </div>

    <!-- ============================ IDLE ============================ -->
    <template v-if="player.phase === 'idle'">
      <div class="mx-auto flex w-full max-w-xl flex-1 flex-col px-5">
        <header class="flex items-center justify-between py-4">
          <router-link
            :to="{ name: 'today' }"
            class="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl bg-surface-1 text-muted"
            aria-label="Back to workouts"
          >
            ←
          </router-link>
          <span class="text-sm text-muted">Ready to start</span>
        </header>
        <div v-if="routeWorkout" class="flex flex-1 flex-col">
          <h1 class="mt-4 text-3xl font-bold tracking-tight">{{ routeWorkout.name }}</h1>
          <ol class="mt-5 space-y-2 text-sm text-muted">
            <li v-for="e in routeWorkout.exercises" :key="e.id" class="flex justify-between">
              <span>{{ e.name }}</span>
              <span class="tnum">
                {{ e.sets }}×{{ e.targetReps }}
                <template v-if="e.weight > 0">· {{ e.weight }} {{ e.unit }}</template>
              </span>
            </li>
          </ol>
          <p v-if="routeWorkout.exercises.length === 0" class="mt-6 text-warn">
            This workout has no exercises, so it can’t be started. Add one in the editor first.
          </p>
          <div class="flex-1"></div>
          <button
            type="button"
            class="mb-4 w-full rounded-2xl py-5 text-lg font-bold disabled:opacity-40"
            :class="primaryClasses"
            :disabled="routeWorkout.exercises.length === 0"
            @click="primaryAction"
          >
            {{ primaryLabel }}
          </button>
        </div>
        <div v-else class="mt-16 text-center text-muted">
          <p>This workout no longer exists.</p>
          <router-link :to="{ name: 'today' }" class="mt-2 inline-block text-accent underline">
            Back to workouts
          </router-link>
        </div>
      </div>
    </template>

    <!-- ========================== COMPLETE ========================== -->
    <template v-else-if="player.phase === 'complete'">
      <div class="mx-auto flex w-full max-w-xl flex-1 flex-col px-5">
        <header class="py-6 text-center">
          <p class="text-xs font-semibold uppercase tracking-widest text-work">Workout complete</p>
          <h1 class="mt-1 text-3xl font-bold tracking-tight">{{ player.session?.workoutName }}</h1>
          <p class="tnum mt-2 text-sm text-muted">
            {{ formatDuration(player.session?.durationSeconds ?? 0) }} ·
            {{ sessionCompletionPercent(player.session!) }}% ·
            volume {{ summaryVolume }}
          </p>
        </header>

        <section
          v-if="lastLoggedSet && lastLoggedSet.set.outcome === 'completed'"
          class="rounded-2xl border border-border bg-surface-1 p-4 text-center"
        >
          <p class="text-sm text-muted">
            Reps on your final set — {{ lastLoggedSet.exercise.name }}
          </p>
          <div class="mt-2">
            <RepStepper
              :model-value="lastLoggedSet.set.actualReps"
              :label="lastLoggedSet.exercise.name"
              @update:model-value="player.adjustLastSetReps($event)"
            />
          </div>
        </section>

        <ul class="mt-4 space-y-2">
          <li
            v-for="exLog in player.session?.exercises ?? []"
            :key="exLog.exerciseId"
            class="flex items-center justify-between rounded-xl bg-surface-1 px-4 py-3 text-sm"
          >
            <span>{{ exLog.name }}</span>
            <span class="tnum text-muted">
              {{ exLog.sets.filter((s) => s.outcome === 'completed').length }}/{{ exLog.targetSets }}
              sets
              <span v-if="exLog.outcome === 'skipped'" class="ml-1 text-warn">skipped</span>
              <span v-else-if="exLog.outcome === 'partial'" class="ml-1 text-warn">partial</span>
            </span>
          </li>
        </ul>

        <div class="flex-1"></div>
        <button
          type="button"
          class="mb-4 w-full rounded-2xl bg-accent py-5 text-lg font-bold text-accent-ink"
          @click="primaryAction"
        >
          Save & finish
        </button>
      </div>
    </template>

    <!-- ====================== RUNNING (timed states) ================= -->
    <template v-else-if="player.workout">
      <div class="mx-auto flex w-full max-w-xl flex-1 flex-col px-5">
        <!-- Persistent context -->
        <header class="pt-3">
          <div class="flex items-center justify-between">
            <button
              type="button"
              class="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl bg-surface-1 text-muted"
              :aria-label="isPaused ? 'Resume' : 'Pause'"
              @click="isPaused ? player.resume(Date.now()) : player.pause(Date.now())"
            >
              <svg viewBox="0 0 24 24" class="h-5 w-5" fill="currentColor" aria-hidden="true">
                <path v-if="!isPaused" d="M7 5h4v14H7zM13 5h4v14h-4z" />
                <path v-else d="M8 5l11 7-11 7z" />
              </svg>
            </button>
            <div class="min-w-0 px-2 text-center">
              <p class="truncate text-sm font-semibold">{{ player.workout.name }}</p>
              <p class="tnum text-xs text-muted">
                Exercise {{ Math.min(player.exerciseIndex + 1, player.totalExercises) }} of
                {{ player.totalExercises }}
              </p>
            </div>
            <button
              type="button"
              class="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl bg-surface-1 text-danger"
              aria-label="End workout"
              @click="confirmStopOpen = true"
            >
              <svg viewBox="0 0 24 24" class="h-5 w-5" fill="currentColor" aria-hidden="true">
                <rect x="6" y="6" width="12" height="12" rx="2" />
              </svg>
            </button>
          </div>
          <!-- Thin overall progress bar -->
          <div
            class="mt-2 h-1 w-full overflow-hidden rounded-full bg-surface-2"
            role="progressbar"
            :aria-valuenow="Math.round(player.overallFraction * 100)"
            aria-valuemin="0"
            aria-valuemax="100"
            aria-label="Workout progress"
          >
            <div
              class="h-full rounded-full bg-accent transition-[width] duration-300"
              :style="{ width: `${player.overallFraction * 100}%` }"
            ></div>
          </div>
        </header>

        <!-- One-time note about screen lock and audio -->
        <div
          v-if="showAwakeNote"
          class="mt-3 flex items-start justify-between gap-2 rounded-xl bg-surface-1 px-4 py-3 text-xs text-muted"
        >
          <p>Keep the screen on during the workout — phones silence timer alerts when locked.</p>
          <button type="button" class="min-h-[32px] font-semibold text-accent" @click="dismissAwakeNote">
            Got it
          </button>
        </div>

        <!-- Exercise context -->
        <section class="mt-4 text-center">
          <h1 class="text-2xl font-bold tracking-tight">{{ contextExercise?.name }}</h1>
          <p class="tnum mt-1 text-sm text-muted">
            {{ weightLabel }} · Set {{ contextSetNumber }} of {{ contextExercise?.sets ?? 0 }}
            <template v-if="phase === 'awaiting_set'">· {{ ex?.sets }}×{{ ex?.targetReps }}</template>
          </p>
          <p v-if="contextExercise?.notes" class="mt-1 text-xs text-faint">
            {{ contextExercise.notes }}
          </p>
        </section>

        <!-- The signature timer — tap to pause / restart -->
        <section class="relative mt-2 flex flex-1 flex-col items-center justify-center" :class="phaseColor">
          <button
            type="button"
            class="rounded-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent disabled:pointer-events-none"
            :disabled="!timerToggleable"
            :aria-label="
              waitingToStart
                ? 'Start set timer'
                : isPaused
                  ? 'Resume timer'
                  : 'Pause timer'
            "
            @click="onTimerClick"
          >
            <ProgressRing :fraction="ringFraction" :size="300" :thickness="11">
              <div class="text-center">
                <p class="text-xs font-bold uppercase tracking-[0.25em] opacity-80">
                  {{ waitingToStart ? 'Ready' : isPaused ? 'Paused' : phaseLabel }}
                </p>
                <p
                  class="tnum font-bold leading-none tracking-tighter"
                  style="font-size: min(19vh, 21vw, 108px)"
                >
                  {{ bigTime }}
                </p>
                <p
                  v-if="waitingToStart"
                  class="mt-1 text-xs text-muted"
                >
                  Tap to start
                </p>
                <p
                  v-else-if="(phase === 'rest_exercise' || phase === 'awaiting_set') && ex"
                  class="mt-1 max-w-[200px] truncate text-xs text-muted"
                >
                  {{ phase === 'awaiting_set' ? 'Stop alarm to begin' : `Next: ${ex.name}` }}
                </p>
              </div>
            </ProgressRing>
          </button>

          <!-- Rest-time rep stepper: entry never blocks the countdown -->
          <div v-if="player.isRestPhase && player.pending && !isPaused" class="mt-2 w-full">
            <p class="text-center text-xs uppercase tracking-widest text-muted">
              Reps just done — {{ player.workout.exercises[player.pending.exerciseIndex]?.name }}
            </p>
            <div class="mt-1">
              <RepStepper
                :model-value="player.pendingReps"
                @update:model-value="player.setReps($event)"
              />
            </div>
          </div>

          <!-- Rest adjust -->
          <div v-if="player.isRestPhase && !isPaused" class="mt-3 flex gap-3">
            <button
              type="button"
              class="tnum min-h-[44px] rounded-xl bg-surface-1 px-5 font-semibold text-rest"
              @click="player.adjustRest(30, Date.now())"
            >
              +30s
            </button>
            <button
              type="button"
              class="tnum min-h-[44px] rounded-xl bg-surface-1 px-5 font-semibold text-rest"
              @click="player.adjustRest(-15, Date.now())"
            >
              −15s
            </button>
          </div>
        </section>

        <!-- Transport tray -->
        <section class="mt-2 flex items-center justify-center gap-2" aria-label="Transport controls">
          <button
            type="button"
            class="flex h-14 w-14 items-center justify-center rounded-2xl bg-surface-1 text-text disabled:opacity-30"
            :disabled="!player.canPreviousExercise"
            aria-label="Previous exercise"
            @click="player.previousExercise(Date.now())"
          >
            <svg viewBox="0 0 24 24" class="h-6 w-6" fill="currentColor" aria-hidden="true">
              <path d="M6 5h2v14H6zM20 5l-10 7 10 7z" />
            </svg>
          </button>
          <button
            type="button"
            class="flex h-14 w-14 items-center justify-center rounded-2xl bg-surface-1 text-text disabled:opacity-30"
            :disabled="!player.canPreviousSet"
            aria-label="Previous set"
            @click="player.previousSet(Date.now())"
          >
            <svg viewBox="0 0 24 24" class="h-6 w-6" fill="currentColor" aria-hidden="true">
              <path d="M17 5l-10 7 10 7z" />
            </svg>
          </button>
          <button
            type="button"
            class="flex h-14 w-14 items-center justify-center rounded-2xl bg-surface-1 text-text"
            aria-label="Skip set"
            @click="player.skipSet(Date.now())"
          >
            <svg viewBox="0 0 24 24" class="h-6 w-6" fill="currentColor" aria-hidden="true">
              <path d="M7 5l10 7-10 7z" />
            </svg>
          </button>
          <button
            type="button"
            class="flex h-14 w-14 items-center justify-center rounded-2xl bg-surface-1 text-text"
            aria-label="Skip exercise"
            @click="player.skipExercise(Date.now())"
          >
            <svg viewBox="0 0 24 24" class="h-6 w-6" fill="currentColor" aria-hidden="true">
              <path d="M4 5l10 7-10 7zM16 5h2v14h-2z" />
            </svg>
          </button>
        </section>

        <!-- No Done during rest: wait for the rest timer, then Start next set -->
        <button
          v-if="showPrimary"
          type="button"
          class="mt-3 mb-2 w-full rounded-2xl py-5 text-xl font-bold transition-colors"
          style="min-height: 64px"
          :class="primaryClasses"
          @click="primaryAction"
        >
          {{ primaryLabel }}
        </button>
        <div
          v-else
          class="mt-3 mb-2 flex w-full items-center justify-center rounded-2xl border border-border bg-surface-1 px-4 py-5 text-center text-sm text-muted"
          style="min-height: 64px"
          aria-live="polite"
        >
          Log reps · ticks at 3 · alarm at 0
        </div>
      </div>

      <!-- Pause overlay tint -->
      <div
        v-if="isPaused"
        class="pointer-events-none fixed inset-0 z-10 bg-black/30"
        aria-hidden="true"
      ></div>
    </template>

    <!-- Abandoned or empty fallthrough -->
    <template v-else>
      <div class="flex flex-1 flex-col items-center justify-center text-muted">
        <p>No active workout.</p>
        <router-link :to="{ name: 'today' }" class="mt-2 text-accent underline">
          Back to workouts
        </router-link>
      </div>
    </template>

    <ConfirmDialog
      :open="confirmStopOpen"
      title="End workout?"
      message="Your completed sets will be saved."
      confirm-label="End workout"
      danger
      @confirm="stopWorkout"
      @cancel="confirmStopOpen = false"
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

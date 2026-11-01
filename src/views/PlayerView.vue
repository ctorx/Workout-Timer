<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { SetLog } from '@/types';
import { usePlayerStore } from '@/stores/player';
import type { Position } from '@/stores/player';
import { useWorkoutsStore } from '@/stores/workouts';
import { useSessionsStore } from '@/stores/sessions';
import { useSettingsStore } from '@/stores/settings';
import { loadPlayerState, LS_KEYS, readLocal, writeLocal } from '@/lib/persistence';
import { audioIsReady, unlockAudio } from '@/lib/audio';
import { formatMmSs, formatDuration } from '@/lib/time';
import {
  exerciseBests,
  formatPerformance,
  formatVolume,
  formatWeight,
  isPersonalRecord,
  lastPerformance,
  exerciseHistory,
  formatLoad,
  formatRepTarget,
  isPlateau,
  progressionAdvice,
  repRange,
  weightStepFor,
  sessionVolume,
  type Bests,
} from '@/lib/stats';
import ProgressRing from '@/components/ProgressRing.vue';
import SetLogger from '@/components/SetLogger.vue';
import NumberStepper from '@/components/NumberStepper.vue';
import PlanList from '@/components/PlanList.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';

const route = useRoute();
const router = useRouter();
const player = usePlayerStore();
const workouts = useWorkoutsStore();
const sessions = useSessionsStore();
const settingsStore = useSettingsStore();

const workoutId = computed(() => route.params.workoutId as string);
const routeWorkout = computed(() => workouts.byId(workoutId.value));

/* ------------------------- lifecycle & layout ------------------------ */

// The clock runs in lib/playerRuntime; this only animates the display.
let raf = 0;
function frame(): void {
  player.tick(Date.now());
  raf = requestAnimationFrame(frame);
}

const viewport = ref({ w: 400, h: 800 });
function measure(): void {
  viewport.value = { w: window.innerWidth, h: window.innerHeight };
}

onMounted(async () => {
  measure();
  window.addEventListener('resize', measure);
  window.addEventListener('keydown', onKey);
  // Refresh or killed tab directly on this URL: restore the saved session.
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
  window.removeEventListener('resize', measure);
  window.removeEventListener('keydown', onKey);
});

const isWide = computed(() => viewport.value.w >= 1024);

/* --------------------------- derived display -------------------------- */

const phase = computed(() => player.effectivePhase);
const isPaused = computed(() => player.phase === 'paused');
const isRest = computed(() => phase.value === 'rest_set' || phase.value === 'rest_exercise');
const isAlarm = computed(() => player.phase === 'awaiting_set');
const isReady = computed(() => player.phase === 'ready');
const ex = computed(() => player.currentExercise);
const setNumber = computed(() => player.setIndex + 1);

const tone = computed(() => {
  if (isPaused.value) return 'paused';
  switch (phase.value) {
    case 'set_active':
      return 'work';
    case 'rest_set':
    case 'rest_exercise':
      return 'rest';
    case 'awaiting_set':
      return 'alarm';
    default:
      return 'ready';
  }
});

const toneText: Record<string, string> = {
  work: 'text-work',
  rest: 'text-rest',
  alarm: 'text-transitionhue',
  ready: 'text-accent',
  paused: 'text-muted',
};

const phaseLabel = computed(() => {
  if (isPaused.value) return 'Paused';
  switch (phase.value) {
    case 'set_active':
      return 'Working';
    case 'rest_set':
    case 'rest_exercise':
      return 'Resting';
    case 'awaiting_set':
      return 'Rest is over';
    default:
      return 'Ready';
  }
});

const bigTime = computed(() => {
  if (isRest.value) return formatMmSs(player.remainingMs);
  if (isReady.value) return '00:00';
  return formatMmSs(player.elapsedMs);
});

const timerHint = computed(() => {
  if (isPaused.value) return 'Tap to resume';
  if (isReady.value || isAlarm.value) return `Tap to start set ${setNumber.value}`;
  return 'Tap to pause';
});

const ringFraction = computed(() => {
  if (isRest.value) return player.countdownFraction;
  if (isReady.value) return 0;
  return (player.elapsedMs % 60000) / 60000; // work: one sweep per minute
});

const ringSize = computed(() => {
  const { w, h } = viewport.value;
  const column = isWide.value ? 460 : w - 40;
  const base = Math.min(300, column, h * (isRest.value ? 0.22 : 0.36));
  return Math.max(isRest.value ? 150 : 190, Math.round(base));
});

const sessionClock = computed(() => {
  const s = player.session;
  if (!s) return '';
  return formatMmSs(Math.max(0, player.nowMs - new Date(s.startedAt).getTime()));
});

/** Segmented progress: one segment per exercise. */
const segments = computed(() =>
  player.plan.map((p) => {
    const done = p.sets.filter((s) => s.status !== 'open' && s.status !== 'current').length;
    return { key: p.exercise.id, weight: p.exercise.sets, fill: done / p.exercise.sets, current: p.isCurrent };
  }),
);

/* --------------------------- tracking context ------------------------- */

const lastTime = computed(() => {
  const e = ex.value;
  if (!e) return null;
  return lastPerformance(sessions.sessions, e.id, e.name, player.session?.id);
});

const lastTimeText = computed(() => (lastTime.value ? formatPerformance(lastTime.value.sets) : ''));

/** What this same set number did last time, as a goal to beat. */
const lastTimeThisSet = computed(() => {
  const lt = lastTime.value;
  if (!lt) return null;
  return lt.sets.find((s) => s.setIndex === player.setIndex) ?? null;
});

/** Double-progression advice from last time, adjusted for today's weight. */
const advice = computed(() => {
  const e = ex.value;
  const lt = lastTime.value;
  if (!e || !lt) return null;
  const a = progressionAdvice(lt.sets, e, weightStepFor(e, settingsStore.settings));
  if (!a) return null;
  const now = player.currentWeight;
  const { min } = repRange(e);
  if (a.kind === 'increase') {
    if (now >= a.to) {
      return { tone: 'good', text: `New weight today. Aim for ${min}+ reps on every set.` };
    }
    return { tone: 'good', text: `↑ ${a.message}` };
  }
  if (a.kind === 'repeat') return now === a.weight ? { tone: 'warn', text: a.message } : null;
  if (a.kind === 'raise-reps') return { tone: 'good', text: `↑ ${a.message}` };
  // build: only meaningful at the same weight as last time
  return now === a.weight ? { tone: 'muted', text: `Goal: ${a.goal} reps on every set.` } : null;
});

const plateau = computed(() => {
  const e = ex.value;
  if (!e) return false;
  return isPlateau(exerciseHistory(sessions.sessions, e.name));
});

const bestsCache = new Map<string, Bests>();
function bestsFor(exerciseId: string, name: string): Bests {
  const key = `${exerciseId}|${name}|${sessions.sessions.length}`;
  let b = bestsCache.get(key);
  if (!b) {
    b = exerciseBests(sessions.sessions, exerciseId, name, player.session?.id);
    bestsCache.set(key, b);
  }
  return b;
}

const pendingExercise = computed(() =>
  player.pending ? (player.workout?.exercises[player.pending.exerciseIndex] ?? null) : null,
);

const pendingIsRecord = computed(() => {
  const p = player.pending;
  const e = pendingExercise.value;
  if (!p || !e) return false;
  const probe = {
    weight: player.pendingWeight,
    actualReps: player.pendingReps,
    outcome: 'completed',
  } as SetLog;
  return isPersonalRecord(probe, bestsFor(e.id, e.name));
});

/* ----------------------------- working weight ------------------------- */

const weightEditorOpen = ref(false);
const weightStep = computed(() =>
  ex.value ? weightStepFor(ex.value, settingsStore.settings) : 5,
);
watch(
  () => player.exerciseIndex,
  () => {
    weightEditorOpen.value = false;
  },
);

/* --------------------------------- next -------------------------------- */

const upNext = computed(() => {
  const w = player.workout;
  if (!w || isRest.value) return null;
  const next = player.upNext;
  if (!next) return { title: 'Workout complete', detail: 'This is the last set left' };
  const nextEx = w.exercises[next.exerciseIndex]!;
  const rest = player.restBeforeUpNext;
  const restText = rest > 0 ? `Rest ${formatDuration(rest)}, then ` : '';
  const weight = player.workingWeight(next.exerciseIndex);
  const load = weight > 0 ? ` @ ${formatWeight(weight)} ${nextEx.unit}` : '';
  if (next.exerciseIndex === player.exerciseIndex) {
    return {
      title: `Set ${next.setIndex + 1} of ${nextEx.sets}`,
      detail: `${restText}${formatRepTarget(nextEx)} reps${load}`,
    };
  }
  return {
    title: nextEx.name,
    detail: `${restText}set ${next.setIndex + 1} of ${nextEx.sets} · ${formatRepTarget(nextEx)} reps${load}`,
  };
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
  if (player.phase === 'paused') {
    player.resume(now);
    return;
  }
  switch (phase.value) {
    case 'idle':
      startWorkout();
      break;
    case 'ready':
    case 'awaiting_set':
    case 'exercise_intro':
      player.startSet(now);
      break;
    case 'set_active':
      player.completeSet(now);
      break;
    case 'rest_set':
    case 'rest_exercise':
      player.endRest(now);
      break;
    case 'complete':
      void saveAndFinish();
      break;
    default:
      break;
  }
}

const primaryLabel = computed(() => {
  if (player.phase === 'paused') return 'Resume';
  switch (phase.value) {
    case 'ready':
    case 'awaiting_set':
      return `Start set ${setNumber.value}`;
    case 'set_active':
      return 'Finish set';
    case 'rest_set':
    case 'rest_exercise':
      return `End rest · start set ${setNumber.value}`;
    default:
      return '';
  }
});

const primaryClasses = computed(() => {
  if (player.phase === 'paused') return 'bg-accent text-accent-ink';
  switch (phase.value) {
    case 'set_active':
      return 'bg-work text-work-ink';
    case 'awaiting_set':
      return 'bg-transitionhue text-transition-ink alarm-pulse';
    case 'rest_set':
    case 'rest_exercise':
      return 'border border-rest/50 bg-surface-1 text-rest';
    default:
      return 'bg-accent text-accent-ink';
  }
});

const backLabel = computed(() => {
  const p = player.pending;
  if (p) return { main: `Redo set ${p.setIndex + 1}`, sub: 'just finished' };
  return { main: 'Back', sub: 'previous set' };
});

const planOpen = ref(false);
function jump(pos: Position): void {
  player.jumpTo(pos, Date.now());
  planOpen.value = false;
}

/** Desktop: Space or Enter runs the main button when nothing else has focus. */
function onKey(e: KeyboardEvent): void {
  if (e.key !== ' ' && e.key !== 'Enter') return;
  const t = e.target as HTMLElement | null;
  if (t && t !== document.body) return;
  if (confirmStopOpen.value || planOpen.value || !player.isRunning) return;
  e.preventDefault();
  primaryAction();
}

/* ------------------------------ notices ------------------------------ */

const showAwakeNote = ref(!readLocal<boolean>(LS_KEYS.iosAudioNoteDismissed));
function dismissAwakeNote(): void {
  showAwakeNote.value = false;
  writeLocal(LS_KEYS.iosAudioNoteDismissed, true);
}

/** Re-evaluated with the clock, since the audio context is not reactive. */
const soundBlocked = computed(() => {
  void player.nowMs;
  return player.isRunning && settingsStore.settings.soundEnabled && !audioIsReady();
});

const announcement = computed(() => {
  const name = ex.value?.name ?? '';
  const of = `set ${setNumber.value} of ${ex.value?.sets ?? 0}`;
  switch (phase.value) {
    case 'awaiting_set':
      return `Rest is over. Start ${of}, ${name}`;
    case 'ready':
      return `Ready: ${of}, ${name}`;
    case 'set_active':
      return `Working ${of}, ${name}`;
    case 'rest_set':
      return `Rest, then ${of}`;
    case 'rest_exercise':
      return `Rest, next exercise: ${name}`;
    case 'complete':
      return 'Workout complete';
    default:
      return '';
  }
});

/* ------------------------- completion summary ------------------------- */

const summaryVolume = computed(() =>
  player.session ? formatVolume(sessionVolume(player.session)) : '0',
);

const summaryCompleted = computed(
  () => player.session?.exercises.reduce((n, x) => n + x.sets.filter((s) => s.outcome === 'completed').length, 0) ?? 0,
);

const summaryRows = computed(() => {
  const s = player.session;
  const w = player.workout;
  if (!s || !w) return [];
  return s.exercises.map((exLog, i) => {
    const planned = w.exercises[i];
    const bests = bestsFor(exLog.exerciseId, exLog.name);
    const records = exLog.sets.filter((set) => isPersonalRecord(set, bests)).map((set) => set.setIndex);
    const used = exLog.sets.find((x) => x.outcome === 'completed')?.weight ?? planned?.weight ?? 0;
    const step = planned ? weightStepFor(planned, settingsStore.settings) : 5;
    const a = planned ? progressionAdvice(exLog.sets, planned, step) : null;
    let suggestion: { weight: number | null; reason: string; step: number } | null = null;
    if (a && a.kind === 'increase') {
      suggestion = { weight: a.to, reason: a.message, step };
    } else if (planned && exLog.sets.some((x) => x.outcome === 'completed') && used !== planned.weight) {
      suggestion = {
        weight: used,
        reason: `You used ${formatLoad(used, planned)}, but the plan says ${formatLoad(planned.weight, planned)}.`,
        step,
      };
    } else if (a) {
      suggestion = { weight: null, reason: a.kind === 'build' ? `Next time: ${a.message}` : a.message, step };
    }
    return { exLog, index: i, planned, records, suggestion };
  });
});

const recordCount = computed(() => summaryRows.value.reduce((n, r) => n + r.records.length, 0));

const editing = ref<{ ex: number; set: number } | null>(null);
function toggleEdit(exIdx: number, setIdx: number): void {
  editing.value =
    editing.value && editing.value.ex === exIdx && editing.value.set === setIdx
      ? null
      : { ex: exIdx, set: setIdx };
}

const suggestedWeights = ref<Record<number, number>>({});
const savedPlans = ref<Record<number, number>>({});
function suggestionValue(i: number, fallback: number): number {
  return suggestedWeights.value[i] ?? fallback;
}

async function savePlanWeight(exIdx: number, weight: number): Promise<void> {
  const exerciseId = player.workout?.exercises[exIdx]?.id;
  const source = workouts.byId(player.workout?.id ?? '');
  if (!source || !exerciseId) return;
  const copy = JSON.parse(JSON.stringify(source)) as typeof source;
  const target = copy.exercises.find((x) => x.id === exerciseId);
  if (!target) return;
  target.weight = weight;
  await workouts.upsert(copy);
  savedPlans.value = { ...savedPlans.value, [exIdx]: weight };
}
</script>

<template>
  <main class="safe-top safe-bottom flex min-h-dvh flex-col bg-bg">
    <p class="sr-only" role="status" aria-live="polite">{{ announcement }}</p>

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
            class="flex min-h-[44px] items-center gap-1 rounded-xl bg-surface-1 px-3 text-sm text-muted"
          >
            ← Workouts
          </router-link>
        </header>
        <div v-if="routeWorkout" class="flex flex-1 flex-col">
          <h1 class="mt-4 text-3xl font-bold tracking-tight">{{ routeWorkout.name }}</h1>
          <ol class="mt-5 space-y-2 text-sm text-muted">
            <li v-for="e in routeWorkout.exercises" :key="e.id" class="flex justify-between rounded-xl bg-surface-1 px-4 py-3">
              <span class="text-text">{{ e.name }}</span>
              <span class="tnum">
                {{ e.sets }}×{{ formatRepTarget(e) }}
                <template v-if="e.weight > 0">· {{ formatLoad(e.weight, e) }}</template>
              </span>
            </li>
          </ol>
          <p v-if="routeWorkout.exercises.length === 0" class="mt-6 text-warn">
            This workout has no exercises, so it can’t be started. Add one in the editor first.
          </p>
          <div class="flex-1"></div>
          <button
            type="button"
            class="mb-4 mt-6 w-full rounded-2xl bg-accent py-5 text-lg font-bold text-accent-ink disabled:opacity-40"
            :disabled="routeWorkout.exercises.length === 0"
            @click="startWorkout"
          >
            Start workout
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
    <template v-else-if="player.phase === 'complete' && player.session">
      <div class="mx-auto flex w-full max-w-2xl flex-1 flex-col px-4 pb-4">
        <header class="py-6 text-center">
          <p class="text-xs font-semibold uppercase tracking-widest text-work">Workout complete</p>
          <h1 class="mt-1 text-3xl font-bold tracking-tight">{{ player.session.workoutName }}</h1>
        </header>

        <dl class="tnum grid grid-cols-2 gap-2 sm:grid-cols-4">
          <div class="rounded-2xl bg-surface-1 px-3 py-3 text-center">
            <dd class="text-xl font-bold">{{ formatDuration(player.session.durationSeconds) }}</dd>
            <dt class="text-[11px] text-muted">duration</dt>
          </div>
          <div class="rounded-2xl bg-surface-1 px-3 py-3 text-center">
            <dd class="text-xl font-bold">{{ summaryCompleted }}/{{ player.totalSets }}</dd>
            <dt class="text-[11px] text-muted">sets done</dt>
          </div>
          <div class="rounded-2xl bg-surface-1 px-3 py-3 text-center">
            <dd class="text-xl font-bold">{{ summaryVolume }}</dd>
            <dt class="text-[11px] text-muted">volume</dt>
          </div>
          <div class="rounded-2xl bg-surface-1 px-3 py-3 text-center">
            <dd class="text-xl font-bold" :class="recordCount > 0 ? 'text-work' : ''">{{ recordCount }}</dd>
            <dt class="text-[11px] text-muted">new records</dt>
          </div>
        </dl>

        <p class="mt-4 text-center text-xs text-faint">Tap any set to correct it before saving.</p>

        <section
          v-for="row in summaryRows"
          :key="`${row.exLog.exerciseId}-${row.index}`"
          class="mt-3 rounded-2xl border border-border bg-surface-1 p-4"
        >
          <div class="flex items-baseline justify-between gap-2">
            <h2 class="font-semibold">{{ row.exLog.name }}</h2>
            <span
              class="text-xs font-medium"
              :class="row.exLog.outcome === 'completed' ? 'text-work' : 'text-warn'"
            >
              {{ row.exLog.outcome === 'completed' ? 'all sets done' : row.exLog.outcome }}
            </span>
          </div>

          <p v-if="row.exLog.sets.length === 0" class="mt-2 text-sm text-muted">Not reached.</p>
          <ul v-else class="mt-2 divide-y divide-border/60">
            <li v-for="set in row.exLog.sets" :key="set.setIndex">
              <button
                type="button"
                class="tnum flex min-h-[44px] w-full items-center gap-3 py-2 text-left text-sm"
                :aria-expanded="editing?.ex === row.index && editing?.set === set.setIndex"
                @click="toggleEdit(row.index, set.setIndex)"
              >
                <span class="w-12 text-faint">Set {{ set.setIndex + 1 }}</span>
                <span v-if="set.outcome === 'skipped'" class="flex-1 text-warn">skipped</span>
                <span v-else class="flex-1">
                  <span class="font-semibold" :class="set.actualReps >= set.targetReps ? 'text-text' : 'text-warn'">{{ set.actualReps }}</span>
                  <span class="text-faint"> reps</span>
                  <template v-if="set.weight > 0"> · {{ formatWeight(set.weight) }} {{ set.unit }}</template>
                  <template v-if="set.rir !== undefined"> · <span class="text-muted">{{ set.rir }} left</span></template>
                </span>
                <span
                  v-if="row.records.includes(set.setIndex)"
                  class="rounded-full bg-work/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-work"
                >
                  Record
                </span>
                <span class="text-faint" aria-hidden="true">✎</span>
              </button>
              <div v-if="editing?.ex === row.index && editing?.set === set.setIndex" class="pb-3">
                <SetLogger
                  :reps="set.actualReps"
                  :weight="set.weight"
                  :unit="set.unit"
                  :rir="set.rir ?? null"
                  :target-reps="set.targetReps"
                  :reps-max="row.planned?.repsMax"
                  :weight-step="row.suggestion?.step ?? (row.planned ? weightStepFor(row.planned, settingsStore.settings) : undefined)"
                  :paired="row.planned?.pairedDumbbells"
                  @update:reps="player.editLoggedSet(row.index, set.setIndex, { actualReps: $event })"
                  @update:weight="player.editLoggedSet(row.index, set.setIndex, { weight: $event })"
                  @update:rir="player.editLoggedSet(row.index, set.setIndex, { rir: $event })"
                />
              </div>
            </li>
          </ul>

          <div
            v-if="row.suggestion && row.planned"
            class="mt-3 rounded-xl border p-3"
            :class="row.suggestion.weight !== null ? 'border-accent/40 bg-accent/5' : 'border-border bg-surface-2/40'"
          >
            <p class="text-sm">{{ row.suggestion.reason }}</p>
            <template v-if="row.suggestion.weight !== null && savedPlans[row.index] === undefined">
              <div class="mt-2 flex flex-wrap items-center justify-between gap-3">
                <NumberStepper
                  :model-value="suggestionValue(row.index, row.suggestion.weight)"
                  label="Next time"
                  :step="row.suggestion.step"
                  :max="9999"
                  :suffix="row.planned.unit"
                  @update:model-value="suggestedWeights = { ...suggestedWeights, [row.index]: $event }"
                />
                <button
                  type="button"
                  class="min-h-[44px] rounded-xl bg-accent px-4 text-sm font-semibold text-accent-ink"
                  @click="savePlanWeight(row.index, suggestionValue(row.index, row.suggestion.weight))"
                >
                  Update plan
                </button>
              </div>
            </template>
            <p v-else-if="savedPlans[row.index] !== undefined" class="mt-1 text-sm font-medium text-work">
              Saved. Next time starts at {{ formatLoad(savedPlans[row.index]!, row.planned) }}.
            </p>
          </div>
        </section>

        <div class="flex-1"></div>
        <button
          type="button"
          class="sticky bottom-3 mt-5 w-full rounded-2xl bg-accent py-5 text-lg font-bold text-accent-ink shadow-lg shadow-black/40"
          @click="saveAndFinish"
        >
          Save & finish
        </button>
      </div>
    </template>

    <!-- ====================== RUNNING ====================== -->
    <template v-else-if="player.workout && player.isRunning">
      <!-- Top bar -->
      <header class="sticky top-0 z-20 border-b border-border/60 bg-bg/90 backdrop-blur">
        <div class="mx-auto flex max-w-6xl items-center gap-2 px-3 py-2">
          <button
            type="button"
            class="flex min-h-[44px] items-center gap-1.5 rounded-xl px-3 text-sm font-medium text-danger hover:bg-surface-1"
            aria-label="End workout"
            @click="confirmStopOpen = true"
          >
            <svg viewBox="0 0 24 24" class="h-4 w-4" fill="currentColor" aria-hidden="true">
              <rect x="6" y="6" width="12" height="12" rx="2" />
            </svg>
            End
          </button>
          <div class="min-w-0 flex-1 text-center">
            <p class="truncate text-sm font-semibold">{{ player.workout.name }}</p>
            <p class="tnum text-xs text-muted">
              Set {{ player.overallSetNumber }} of {{ player.totalSets }} · {{ sessionClock }}
            </p>
          </div>
          <button
            v-if="!isWide"
            type="button"
            class="flex min-h-[44px] items-center gap-1.5 rounded-xl px-3 text-sm font-medium text-accent hover:bg-surface-1"
            aria-label="Show workout plan"
            @click="planOpen = true"
          >
            <svg viewBox="0 0 24 24" class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
              <path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01" />
            </svg>
            Plan
          </button>
          <span v-else class="w-[72px]"></span>
        </div>
        <!-- One segment per exercise -->
        <div class="mx-auto flex max-w-6xl gap-1 px-3 pb-2" aria-hidden="true">
          <div
            v-for="seg in segments"
            :key="seg.key"
            class="h-1.5 overflow-hidden rounded-full bg-surface-2"
            :class="seg.current ? 'ring-1 ring-accent/70' : ''"
            :style="{ flexGrow: seg.weight, flexBasis: 0 }"
          >
            <div class="h-full rounded-full bg-work transition-[width] duration-300" :style="{ width: `${seg.fill * 100}%` }"></div>
          </div>
        </div>
      </header>

      <div class="mx-auto grid w-full max-w-6xl flex-1 gap-6 px-4 lg:grid-cols-[minmax(0,1fr)_380px] lg:px-6">
        <!-- Main column -->
        <div class="mx-auto flex w-full max-w-xl flex-col pb-4">
          <!-- Notices -->
          <button
            v-if="soundBlocked"
            type="button"
            class="mt-3 w-full rounded-xl border border-warn/50 bg-warn/10 px-4 py-2.5 text-left text-sm text-warn"
            @click="unlockAudio()"
          >
            Sound is paused by the browser. Tap here to turn it back on.
          </button>
          <div
            v-if="showAwakeNote"
            class="mt-3 flex items-start justify-between gap-3 rounded-xl bg-surface-1 px-4 py-3 text-xs text-muted"
          >
            <p>
              Alerts keep playing when you switch apps on Android and desktop. Phones still silence
              web apps when the screen locks, so the screen stays on during a workout.
            </p>
            <button type="button" class="min-h-[32px] shrink-0 font-semibold text-accent" @click="dismissAwakeNote">
              Got it
            </button>
          </div>

          <!-- Exercise -->
          <section class="mt-4">
            <div class="flex items-center justify-between gap-2">
              <p class="text-[11px] font-semibold uppercase tracking-widest" :class="isRest ? 'text-rest' : 'text-faint'">
                {{ isRest ? 'Up next' : `Exercise ${player.exerciseIndex + 1} of ${player.totalExercises}` }}
              </p>
              <p v-if="player.currentSetPreviousLog && !isRest" class="text-[11px] font-medium text-warn">
                Redoing · was {{ player.currentSetPreviousLog.outcome === 'skipped' ? 'skipped' : `${player.currentSetPreviousLog.actualReps} reps` }}
              </p>
            </div>
            <h1 class="mt-1 text-2xl font-bold leading-tight tracking-tight sm:text-3xl">{{ ex?.name }}</h1>
            <div class="tnum mt-2 flex flex-wrap items-center gap-1.5 text-sm">
              <span class="rounded-full bg-surface-2 px-3 py-1 font-semibold">Set {{ setNumber }} of {{ ex?.sets }}</span>
              <span class="rounded-full bg-surface-2 px-3 py-1">{{ ex ? formatRepTarget(ex) : '' }} reps</span>
              <button
                type="button"
                class="rounded-full border border-dashed border-border bg-surface-2 px-3 py-1 hover:border-muted"
                :aria-expanded="weightEditorOpen"
                aria-label="Change weight for this exercise"
                @click="weightEditorOpen = !weightEditorOpen"
              >
                {{ ex ? formatLoad(player.currentWeight, ex) : '' }}
                <span class="ml-0.5 text-faint" aria-hidden="true">✎</span>
              </button>
            </div>
            <div v-if="weightEditorOpen && ex" class="mt-3 flex items-center justify-between gap-3 rounded-2xl bg-surface-1 p-3">
              <NumberStepper
                :model-value="player.currentWeight"
                label="Weight this session"
                :step="weightStep"
                :max="9999"
                :suffix="ex.unit"
                zero-text="BW"
                @update:model-value="player.setWorkingWeight(player.exerciseIndex, $event)"
              />
              <button type="button" class="min-h-[44px] rounded-xl bg-surface-2 px-4 text-sm font-medium" @click="weightEditorOpen = false">
                Done
              </button>
            </div>
            <p v-if="ex?.notes" class="mt-2 text-sm text-muted">{{ ex.notes }}</p>

            <div v-if="lastTime" class="tnum mt-2 text-sm text-muted">
              <span class="text-faint">Last time:</span> {{ lastTimeText }}
              <template v-if="lastTimeThisSet && !isRest">
                · <span class="text-text">beat {{ lastTimeThisSet.actualReps }} on this set</span>
              </template>
            </div>
            <p
              v-if="advice"
              class="mt-2 inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-semibold"
              :class="{
                'bg-work/15 text-work': advice.tone === 'good',
                'bg-warn/10 text-warn': advice.tone === 'warn',
                'bg-surface-2 text-muted': advice.tone === 'muted',
              }"
            >
              {{ advice.text }}
            </p>
            <p v-if="plateau" class="mt-2 rounded-xl bg-warn/10 px-3 py-1.5 text-xs text-warn">
              No gain in the last 3 sessions. Consider a lighter week, more rest, or a different rep range.
            </p>
          </section>

          <!-- Timer -->
          <section class="mt-4 flex flex-col items-center" :class="toneText[tone]">
            <button
              type="button"
              class="relative rounded-full transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent"
              :class="isPaused ? 'opacity-60' : ''"
              :aria-label="timerHint"
              @click="player.toggleTimer(Date.now())"
            >
              <ProgressRing :fraction="ringFraction" :size="ringSize" :thickness="isRest ? 9 : 11">
                <div class="text-center">
                  <p class="text-[11px] font-bold uppercase tracking-[0.25em]">{{ phaseLabel }}</p>
                  <p
                    class="tnum font-bold leading-none tracking-tighter text-text"
                    :style="{ fontSize: `${Math.round(ringSize * 0.3)}px` }"
                  >
                    {{ bigTime }}
                  </p>
                  <p class="mt-1.5 text-xs text-muted">{{ timerHint }}</p>
                </div>
              </ProgressRing>
            </button>

            <div v-if="isRest" class="mt-3 flex gap-2">
              <button
                type="button"
                class="tnum min-h-[44px] rounded-xl bg-surface-1 px-5 text-sm font-semibold text-rest hover:bg-surface-2"
                aria-label="Shorten rest by 15 seconds"
                @click="player.adjustRest(-15, Date.now())"
              >
                −15s
              </button>
              <button
                type="button"
                class="tnum min-h-[44px] rounded-xl bg-surface-1 px-5 text-sm font-semibold text-rest hover:bg-surface-2"
                aria-label="Add 30 seconds of rest"
                @click="player.adjustRest(30, Date.now())"
              >
                +30s
              </button>
            </div>
          </section>

          <!-- Log the set just finished (during rest) -->
          <section
            v-if="isRest && player.pending && pendingExercise"
            class="mt-4 rounded-2xl border border-rest/30 bg-surface-1 p-4"
          >
            <div class="mb-3 flex items-baseline justify-between gap-2">
              <h2 class="text-sm font-semibold">
                Log set {{ player.pending.setIndex + 1 }}
                <span class="font-normal text-muted">· {{ pendingExercise.name }}</span>
              </h2>
              <span
                v-if="pendingIsRecord"
                class="rounded-full bg-work/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-work"
              >
                New record
              </span>
            </div>
            <SetLogger
              :reps="player.pendingReps"
              :weight="player.pendingWeight"
              :unit="player.pending.unit"
              :rir="player.pendingRir"
              :target-reps="player.pending.targetReps"
              :reps-max="pendingExercise.repsMax"
              :weight-step="weightStepFor(pendingExercise, settingsStore.settings)"
              :paired="pendingExercise.pairedDumbbells"
              @update:reps="player.setReps($event)"
              @update:weight="player.setPendingWeight($event)"
              @update:rir="player.setPendingRir($event)"
            />
          </section>

          <!-- Main action -->
          <button
            type="button"
            class="mt-4 w-full rounded-2xl text-xl font-bold transition active:scale-[0.99]"
            style="min-height: 68px"
            :class="primaryClasses"
            @click="primaryAction"
          >
            {{ primaryLabel }}
          </button>

          <!-- Up next -->
          <section v-if="upNext" class="mt-3 flex items-center gap-3 rounded-2xl bg-surface-1 px-4 py-3">
            <span class="text-[11px] font-semibold uppercase tracking-widest text-faint">Next</span>
            <div class="min-w-0">
              <p class="truncate text-sm font-semibold">{{ upNext.title }}</p>
              <p class="tnum truncate text-xs text-muted">{{ upNext.detail }}</p>
            </div>
          </section>

          <!-- Navigation -->
          <nav class="mt-3 grid grid-cols-3 gap-2" aria-label="Move through the workout">
            <button
              type="button"
              class="flex min-h-[60px] flex-col items-center justify-center rounded-2xl bg-surface-1 px-2 text-sm font-semibold hover:bg-surface-2 disabled:opacity-35"
              :disabled="!player.canGoBack"
              @click="player.goBack(Date.now())"
            >
              <span>↶ {{ backLabel.main }}</span>
              <span class="text-[11px] font-normal text-muted">{{ backLabel.sub }}</span>
            </button>
            <button
              type="button"
              class="flex min-h-[60px] flex-col items-center justify-center rounded-2xl bg-surface-1 px-2 text-sm font-semibold hover:bg-surface-2"
              @click="player.skipSet(Date.now())"
            >
              <span>Skip set {{ setNumber }}</span>
              <span class="text-[11px] font-normal text-muted">log as skipped</span>
            </button>
            <button
              type="button"
              class="flex min-h-[60px] flex-col items-center justify-center rounded-2xl bg-surface-1 px-2 text-sm font-semibold hover:bg-surface-2"
              @click="player.skipExercise(Date.now())"
            >
              <span>Skip exercise</span>
              <span class="text-[11px] font-normal text-muted">rest of {{ ex?.name }}</span>
            </button>
          </nav>
          <p v-if="isWide" class="mt-3 text-center text-xs text-faint">
            Keyboard: Space or Enter runs the main button.
          </p>
        </div>

        <!-- Desktop: plan always visible -->
        <aside v-if="isWide" class="py-4">
          <div class="sticky top-24">
            <h2 class="mb-2 text-xs font-semibold uppercase tracking-widest text-faint">Workout plan</h2>
            <div class="max-h-[calc(100dvh-8rem)] overflow-y-auto pr-1">
              <PlanList :plan="player.plan" @jump="jump" />
            </div>
          </div>
        </aside>
      </div>

      <!-- Mobile: plan sheet -->
      <Teleport to="body">
        <div
          v-if="planOpen && !isWide"
          class="fixed inset-0 z-40 flex items-end justify-center bg-black/60"
          role="dialog"
          aria-modal="true"
          aria-label="Workout plan"
          @click.self="planOpen = false"
          @keydown.escape="planOpen = false"
        >
          <div class="safe-bottom flex max-h-[85dvh] w-full max-w-xl flex-col rounded-t-3xl border-t border-border bg-bg">
            <div class="flex items-center justify-between px-5 pb-2 pt-4">
              <h2 class="text-lg font-bold">Workout plan</h2>
              <button type="button" class="min-h-[44px] rounded-xl bg-surface-1 px-4 text-sm font-medium" @click="planOpen = false">
                Close
              </button>
            </div>
            <div class="overflow-y-auto px-4 pb-4">
              <PlanList :plan="player.plan" @jump="jump" />
            </div>
          </div>
        </div>
      </Teleport>
    </template>

    <!-- Abandoned or empty fallthrough -->
    <template v-else>
      <div class="flex flex-1 flex-col items-center justify-center text-muted">
        <p>No active workout.</p>
        <router-link :to="{ name: 'today' }" class="mt-2 text-accent underline">Back to workouts</router-link>
      </div>
    </template>

    <ConfirmDialog
      :open="confirmStopOpen"
      title="End workout early?"
      message="Every set you logged is saved to History. Sets you did not reach are left out."
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
.alarm-pulse {
  animation: alarm-pulse 1s ease-in-out infinite;
}
@keyframes alarm-pulse {
  0%,
  100% {
    box-shadow: 0 0 0 0 rgb(167 139 250 / 0.55);
  }
  50% {
    box-shadow: 0 0 0 10px rgb(167 139 250 / 0);
  }
}
</style>

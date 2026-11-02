<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { Exercise, Workout } from '@/types';
import { useWorkoutsStore } from '@/stores/workouts';
import { validateWorkout, workoutIsValid } from '@/lib/validation';
import { uuid } from '@/lib/id';
import { DAY_NAMES_SHORT } from '@/lib/time';
import { guessBodyweightShare, weightStepFor } from '@/lib/stats';
import { useSettingsStore } from '@/stores/settings';
import ConfirmDialog from '@/components/ConfirmDialog.vue';

const route = useRoute();
const router = useRouter();
const workouts = useWorkoutsStore();

const isNew = route.params.id === 'new';
const source = isNew ? null : workouts.byId(route.params.id as string);

/** Local draft; storage is only touched by an explicitly valid save. */
const draft = ref<Workout>(
  source ? (JSON.parse(JSON.stringify(source)) as Workout) : workouts.createDraft(),
);

const notFound = !isNew && !source;

const triedSave = ref(false);
const saveError = ref('');
const errors = computed(() => validateWorkout(draft.value));
const valid = computed(() => workoutIsValid(errors.value));

function exError(ex: Exercise, field: string): string | undefined {
  const e = errors.value.exercises.get(ex.id) as Record<string, string> | undefined;
  return triedSave.value ? e?.[field] : undefined;
}

async function save(): Promise<void> {
  triedSave.value = true;
  if (!valid.value) return;
  // Normalize before storage.
  draft.value.name = draft.value.name.trim();
  for (const ex of draft.value.exercises) {
    ex.name = ex.name.trim();
    if (ex.notes !== undefined && ex.notes.trim() === '') delete ex.notes;
  }
  try {
    await workouts.upsert(JSON.parse(JSON.stringify(draft.value)) as Workout);
  } catch (err) {
    saveError.value =
      err instanceof Error ? err.message : 'Saving failed. Your changes are still on screen.';
    return;
  }
  void router.push({ name: 'today' });
}

/* --------------------------- exercise list --------------------------- */

function addExercise(): void {
  draft.value.exercises.push(workouts.newExercise());
}

function duplicateExercise(index: number): void {
  const ex = draft.value.exercises[index];
  if (!ex) return;
  draft.value.exercises.splice(index + 1, 0, {
    ...JSON.parse(JSON.stringify(ex)),
    id: uuid(),
  });
}

function removeExercise(index: number): void {
  draft.value.exercises.splice(index, 1);
}

function moveExercise(index: number, direction: -1 | 1): void {
  const target = index + direction;
  if (target < 0 || target >= draft.value.exercises.length) return;
  const list = draft.value.exercises;
  [list[index], list[target]] = [list[target]!, list[index]!];
}

/* ------------------------- workout-level ops ------------------------- */

const confirmDeleteOpen = ref(false);

async function deleteWorkout(): Promise<void> {
  confirmDeleteOpen.value = false;
  if (!isNew) await workouts.remove(draft.value.id);
  void router.push({ name: 'today' });
}

async function duplicateWorkout(): Promise<void> {
  if (isNew) return;
  const copy = await workouts.duplicate(draft.value.id);
  if (copy) void router.push({ name: 'workout-edit', params: { id: copy.id } });
}

const dayChoices: { value: Workout['dayOfWeek']; label: string }[] = [
  { value: null, label: 'None' },
  ...DAY_NAMES_SHORT.map((label, i) => ({ value: i as 0 | 1 | 2 | 3 | 4 | 5 | 6, label })),
];

function fieldNum(e: Event): number {
  const v = Number.parseFloat((e.target as HTMLInputElement).value);
  return Number.isFinite(v) ? v : Number.NaN;
}
/* ---------------------------- progression ---------------------------- */

const settingsStore = useSettingsStore();

function defaultStep(ex: Exercise): number {
  return weightStepFor({ unit: ex.unit, pairedDumbbells: ex.pairedDumbbells }, settingsStore.settings);
}

/** What the app will suggest once every set reaches the top of the range. */
function nextStepText(ex: Exercise): string {
  const step = `${ex.weightStep ?? defaultStep(ex)} ${ex.unit}`;
  if (ex.bodyweightShare && ex.weight === 0) return 'raising the rep range, or adding weight';
  if (ex.bodyweightShare && ex.weight < 0) return `cutting the assistance by ${step}`;
  return `adding ${step}`;
}

/** An empty top-of-range box means a single target. */
function setRepsMax(ex: Exercise, e: Event): void {
  const raw = (e.target as HTMLInputElement).value.trim();
  if (raw === '') {
    delete ex.repsMax;
    return;
  }
  const v = Number.parseInt(raw, 10);
  ex.repsMax = Number.isFinite(v) ? v : Number.NaN;
}

function setWeightStep(ex: Exercise, e: Event): void {
  const raw = (e.target as HTMLInputElement).value.trim();
  if (raw === '') {
    delete ex.weightStep;
    return;
  }
  const v = Number.parseFloat(raw);
  ex.weightStep = Number.isFinite(v) ? v : Number.NaN;
}

function setPaired(ex: Exercise, e: Event): void {
  if ((e.target as HTMLInputElement).checked) ex.pairedDumbbells = true;
  else delete ex.pairedDumbbells;
}

/** Turning bodyweight on starts from a typical share for the movement. */
function setBodyweight(ex: Exercise, e: Event): void {
  if ((e.target as HTMLInputElement).checked) {
    ex.bodyweightShare = guessBodyweightShare(ex.name);
  } else {
    delete ex.bodyweightShare;
    // Assistance only makes sense with bodyweight.
    if (ex.weight < 0) ex.weight = 0;
  }
}

function setBodyweightShare(ex: Exercise, e: Event): void {
  const v = Number.parseFloat((e.target as HTMLInputElement).value);
  ex.bodyweightShare = Number.isFinite(v) ? Math.round(v) / 100 : Number.NaN;
}

function fieldInt(e: Event): number {
  const v = Number.parseInt((e.target as HTMLInputElement).value, 10);
  return Number.isFinite(v) ? v : Number.NaN;
}
</script>

<template>
  <main class="safe-top mx-auto w-full max-w-2xl px-4 pb-8">
    <div v-if="notFound" class="mt-16 text-center text-muted">
      <p>This workout no longer exists.</p>
      <router-link :to="{ name: 'today' }" class="mt-2 inline-block text-accent underline">
        Back to workouts
      </router-link>
    </div>

    <template v-else>
      <header class="flex items-center justify-between py-4">
        <div class="flex items-center gap-2">
          <router-link
            :to="{ name: 'today' }"
            class="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl bg-surface-1 text-muted"
            aria-label="Back to workouts"
          >
            ←
          </router-link>
          <h1 class="text-xl font-bold tracking-tight">
            {{ isNew ? 'New workout' : 'Edit workout' }}
          </h1>
        </div>
        <button
          type="button"
          class="min-h-[44px] rounded-xl bg-accent px-5 font-semibold text-accent-ink"
          @click="save"
        >
          Save
        </button>
      </header>

      <p
        v-if="triedSave && !valid"
        class="mb-3 rounded-xl border border-warn/50 bg-surface-1 px-4 py-3 text-sm text-warn"
        aria-live="polite"
      >
        Fix the highlighted fields before saving — nothing invalid is stored.
      </p>
      <p
        v-if="saveError"
        class="mb-3 rounded-xl border border-danger/60 bg-surface-1 px-4 py-3 text-sm text-danger"
        role="alert"
      >
        {{ saveError }}
      </p>

      <!-- Workout fields -->
      <section class="rounded-2xl border border-border bg-surface-1 p-4">
        <label class="block text-xs font-medium uppercase tracking-wide text-faint" for="w-name">
          Workout name
        </label>
        <input
          id="w-name"
          v-model="draft.name"
          type="text"
          placeholder="Push day"
          class="mt-1 w-full rounded-xl border bg-surface-2 px-3 py-3 text-lg font-semibold"
          :class="triedSave && errors.name ? 'border-danger' : 'border-border'"
        />
        <p v-if="triedSave && errors.name" class="mt-1 text-sm text-danger">{{ errors.name }}</p>

        <p class="mt-4 text-xs font-medium uppercase tracking-wide text-faint">Scheduled day</p>
        <div class="mt-1 flex flex-wrap gap-1.5" role="radiogroup" aria-label="Scheduled day">
          <button
            v-for="choice in dayChoices"
            :key="String(choice.value)"
            type="button"
            role="radio"
            :aria-checked="draft.dayOfWeek === choice.value"
            class="min-h-[44px] rounded-xl px-3 text-sm font-medium"
            :class="
              draft.dayOfWeek === choice.value
                ? 'bg-accent text-accent-ink'
                : 'bg-surface-2 text-muted'
            "
            @click="draft.dayOfWeek = choice.value"
          >
            {{ choice.label }}
          </button>
        </div>

        <label class="mt-4 flex min-h-[44px] items-center justify-between">
          <span>
            <span class="font-medium">Optional</span>
            <span class="block text-xs text-muted">De-emphasized; doesn’t count toward streaks</span>
          </span>
          <input v-model="draft.optional" type="checkbox" class="h-6 w-6 accent-[var(--c-accent)]" />
        </label>
      </section>

      <!-- Exercises -->
      <h2 class="mt-6 mb-2 px-1 text-xs font-semibold uppercase tracking-widest text-faint">
        Exercises
      </h2>

      <p
        v-if="draft.exercises.length === 0"
        class="rounded-2xl border border-dashed border-border px-4 py-5 text-sm text-muted"
      >
        No exercises. A workout needs at least one exercise before it can be started.
      </p>

      <section
        v-for="(ex, i) in draft.exercises"
        :key="ex.id"
        class="mt-3 rounded-2xl border border-border bg-surface-1 p-4"
      >
        <div class="flex items-start justify-between gap-2">
          <span class="tnum mt-2 text-xs font-semibold text-faint">{{ i + 1 }}</span>
          <input
            v-model="ex.name"
            type="text"
            placeholder="Exercise name"
            :aria-label="`Exercise ${i + 1} name`"
            class="min-w-0 flex-1 rounded-xl border bg-surface-2 px-3 py-2.5 font-semibold"
            :class="exError(ex, 'name') ? 'border-danger' : 'border-border'"
          />
          <div class="flex gap-1">
            <button
              type="button"
              class="flex h-11 w-11 items-center justify-center rounded-xl bg-surface-2 text-muted disabled:opacity-30"
              :disabled="i === 0"
              :aria-label="`Move ${ex.name || 'exercise'} up`"
              @click="moveExercise(i, -1)"
            >
              ▲
            </button>
            <button
              type="button"
              class="flex h-11 w-11 items-center justify-center rounded-xl bg-surface-2 text-muted disabled:opacity-30"
              :disabled="i === draft.exercises.length - 1"
              :aria-label="`Move ${ex.name || 'exercise'} down`"
              @click="moveExercise(i, 1)"
            >
              ▼
            </button>
          </div>
        </div>
        <p v-if="exError(ex, 'name')" class="mt-1 text-sm text-danger">{{ exError(ex, 'name') }}</p>

        <div class="mt-3 grid grid-cols-2 gap-3">
          <div>
            <label :for="`w-${ex.id}`" class="text-xs text-faint">
              {{ ex.bodyweightShare ? 'Added weight (below 0 = assisted)' : 'Weight (0 = bodyweight)' }}
            </label>
            <div class="mt-1 flex">
              <input
                :id="`w-${ex.id}`"
                type="number"
                :inputmode="ex.bodyweightShare ? 'text' : 'decimal'"
                :min="ex.bodyweightShare ? undefined : 0"
                step="0.5"
                :value="ex.weight"
                class="tnum w-full rounded-l-xl border bg-surface-2 px-3 py-2.5"
                :class="exError(ex, 'weight') ? 'border-danger' : 'border-border'"
                @input="ex.weight = fieldNum($event)"
              />
              <button
                type="button"
                class="rounded-r-xl border border-l-0 border-border bg-surface-2 px-3 text-sm font-semibold text-accent"
                :aria-label="`Unit: ${ex.unit}. Tap to switch`"
                @click="ex.unit = ex.unit === 'lb' ? 'kg' : 'lb'"
              >
                {{ ex.unit }}
              </button>
            </div>
            <p v-if="exError(ex, 'weight')" class="mt-1 text-xs text-danger">{{ exError(ex, 'weight') }}</p>
          </div>
          <div>
            <label :for="`s-${ex.id}`" class="text-xs text-faint">Sets × rep range</label>
            <div class="mt-1 flex items-center gap-1">
              <input
                :id="`s-${ex.id}`"
                type="number"
                inputmode="numeric"
                min="1"
                :value="ex.sets"
                :aria-label="`Exercise ${i + 1} sets`"
                class="tnum w-full min-w-0 rounded-xl border bg-surface-2 px-2 py-2.5 text-center"
                :class="exError(ex, 'sets') ? 'border-danger' : 'border-border'"
                @input="ex.sets = fieldInt($event)"
              />
              <span class="text-faint">×</span>
              <input
                type="number"
                inputmode="numeric"
                min="1"
                :value="ex.targetReps"
                :aria-label="`Exercise ${i + 1} lowest reps in the range`"
                class="tnum w-full min-w-0 rounded-xl border bg-surface-2 px-2 py-2.5 text-center"
                :class="exError(ex, 'targetReps') ? 'border-danger' : 'border-border'"
                @input="ex.targetReps = fieldInt($event)"
              />
              <span class="text-faint">–</span>
              <input
                type="number"
                inputmode="numeric"
                min="1"
                :value="ex.repsMax ?? ''"
                :placeholder="String(ex.targetReps || '')"
                :aria-label="`Exercise ${i + 1} highest reps in the range (empty for a single target)`"
                class="tnum w-full min-w-0 rounded-xl border bg-surface-2 px-2 py-2.5 text-center"
                :class="exError(ex, 'targetReps') ? 'border-danger' : 'border-border'"
                @input="setRepsMax(ex, $event)"
              />
            </div>
            <p v-if="exError(ex, 'sets')" class="mt-1 text-xs text-danger">{{ exError(ex, 'sets') }}</p>
            <p v-if="exError(ex, 'targetReps')" class="mt-1 text-xs text-danger">{{ exError(ex, 'targetReps') }}</p>
          </div>
          <div>
            <label :for="`rbs-${ex.id}`" class="text-xs text-faint">Rest between sets (s)</label>
            <input
              :id="`rbs-${ex.id}`"
              type="number"
              inputmode="numeric"
              min="0"
              :value="ex.restBetweenSets"
              class="tnum mt-1 w-full rounded-xl border bg-surface-2 px-3 py-2.5"
              :class="exError(ex, 'restBetweenSets') ? 'border-danger' : 'border-border'"
              @input="ex.restBetweenSets = fieldInt($event)"
            />
            <p v-if="exError(ex, 'restBetweenSets')" class="mt-1 text-xs text-danger">
              {{ exError(ex, 'restBetweenSets') }}
            </p>
          </div>
          <div>
            <label :for="`rae-${ex.id}`" class="text-xs text-faint">Rest after exercise (s)</label>
            <input
              :id="`rae-${ex.id}`"
              type="number"
              inputmode="numeric"
              min="0"
              :value="ex.restAfterExercise"
              class="tnum mt-1 w-full rounded-xl border bg-surface-2 px-3 py-2.5"
              :class="exError(ex, 'restAfterExercise') ? 'border-danger' : 'border-border'"
              @input="ex.restAfterExercise = fieldInt($event)"
            />
            <p v-if="exError(ex, 'restAfterExercise')" class="mt-1 text-xs text-danger">
              {{ exError(ex, 'restAfterExercise') }}
            </p>
            <p v-if="i === draft.exercises.length - 1" class="mt-1 text-xs text-faint">
              Skipped for the last exercise.
            </p>
          </div>
        </div>

        <!-- Progression -->
        <div class="mt-3 rounded-xl border border-border/70 p-3">
          <p class="text-xs font-semibold uppercase tracking-widest text-faint">Progression</p>
          <div class="mt-2 grid grid-cols-2 gap-3">
            <div>
              <label :for="`ws-${ex.id}`" class="text-xs text-faint">Add this much ({{ ex.unit }})</label>
              <input
                :id="`ws-${ex.id}`"
                type="number"
                inputmode="decimal"
                min="0"
                step="0.5"
                :value="ex.weightStep ?? ''"
                :placeholder="`${defaultStep(ex)} (default)`"
                class="tnum mt-1 w-full rounded-xl border border-border bg-surface-2 px-3 py-2.5"
                @input="setWeightStep(ex, $event)"
              />
            </div>
            <label class="flex items-center gap-2 self-end pb-2 text-sm">
              <input
                type="checkbox"
                class="h-5 w-5 shrink-0 accent-[var(--c-accent)]"
                :checked="!!ex.pairedDumbbells"
                @change="setPaired(ex, $event)"
              />
              <span>
                Two dumbbells
                <span class="block text-xs text-faint">Weight is the pair total</span>
              </span>
            </label>
          </div>
          <div class="mt-3 grid grid-cols-2 gap-3">
            <label class="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                class="h-5 w-5 shrink-0 accent-[var(--c-accent)]"
                :checked="!!ex.bodyweightShare"
                @change="setBodyweight(ex, $event)"
              />
              <span>
                Bodyweight exercise
                <span class="block text-xs text-faint">Your bodyweight counts as load</span>
              </span>
            </label>
            <div v-if="ex.bodyweightShare">
              <label :for="`bws-${ex.id}`" class="text-xs text-faint">Share of bodyweight (%)</label>
              <input
                :id="`bws-${ex.id}`"
                type="number"
                inputmode="numeric"
                min="5"
                max="100"
                :value="Math.round(ex.bodyweightShare * 100)"
                class="tnum mt-1 w-full rounded-xl border bg-surface-2 px-3 py-2.5"
                :class="exError(ex, 'bodyweightShare') ? 'border-danger' : 'border-border'"
                @input="setBodyweightShare(ex, $event)"
              />
            </div>
          </div>
          <p v-if="exError(ex, 'bodyweightShare')" class="mt-1 text-xs text-danger">
            {{ exError(ex, 'bodyweightShare') }}
          </p>
          <p v-if="ex.bodyweightShare" class="mt-2 text-xs text-faint">
            Typical shares: pull-up, chin-up and dip 100%, push-up 65%, inverted row 60%. Weight
            above is added weight, such as a vest or belt. Enter a negative number for band or
            machine assistance.
            <template v-if="!(settingsStore.settings.bodyweight > 0)">
              <router-link :to="{ name: 'settings' }" class="font-medium text-accent underline">
                Set your bodyweight in Settings
              </router-link>
              so it counts toward the load.
            </template>
          </p>
          <p class="mt-2 text-xs text-faint">
            <template v-if="ex.repsMax && ex.repsMax > ex.targetReps">
              Work up from {{ ex.targetReps }} to {{ ex.repsMax }} reps. When every set reaches
              {{ ex.repsMax }}, the app suggests {{ nextStepText(ex) }}.
            </template>
            <template v-else>
              When every set reaches {{ ex.targetReps || '–' }} reps, the app suggests
              {{ nextStepText(ex) }}. Set a rep range above to work up before adding weight.
            </template>
          </p>
        </div>

        <label :for="`n-${ex.id}`" class="mt-3 block text-xs text-faint">Notes</label>
        <input
          :id="`n-${ex.id}`"
          type="text"
          :value="ex.notes ?? ''"
          placeholder="Optional cue, e.g. “pause at the chest”"
          class="mt-1 w-full rounded-xl border border-border bg-surface-2 px-3 py-2.5 text-sm"
          @input="ex.notes = ($event.target as HTMLInputElement).value"
        />

        <div class="mt-3 flex gap-2">
          <button
            type="button"
            class="min-h-[44px] flex-1 rounded-xl bg-surface-2 text-sm font-medium text-muted"
            @click="duplicateExercise(i)"
          >
            Duplicate
          </button>
          <button
            type="button"
            class="min-h-[44px] flex-1 rounded-xl bg-surface-2 text-sm font-medium text-danger"
            @click="removeExercise(i)"
          >
            Delete
          </button>
        </div>
      </section>

      <button
        type="button"
        class="mt-4 w-full rounded-2xl border border-dashed border-border py-4 font-medium text-accent"
        @click="addExercise"
      >
        Add exercise
      </button>

      <!-- Workout-level actions -->
      <div v-if="!isNew" class="mt-8 flex gap-2">
        <button
          type="button"
          class="min-h-[48px] flex-1 rounded-xl bg-surface-1 font-medium text-muted"
          @click="duplicateWorkout"
        >
          Duplicate workout
        </button>
        <button
          type="button"
          class="min-h-[48px] flex-1 rounded-xl bg-surface-1 font-medium text-danger"
          @click="confirmDeleteOpen = true"
        >
          Delete workout
        </button>
      </div>

      <ConfirmDialog
        :open="confirmDeleteOpen"
        title="Delete workout?"
        :message="`“${draft.name || 'Untitled'}” will be removed. Past sessions in History are kept.`"
        confirm-label="Delete workout"
        danger
        @confirm="deleteWorkout"
        @cancel="confirmDeleteOpen = false"
      />
    </template>
  </main>
</template>

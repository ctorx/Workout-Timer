<script setup lang="ts">
/**
 * The whole workout at a glance. Each set is a chip showing its state;
 * tapping a chip jumps there (nothing is deleted).
 */
import type { PlanExercise, PlanSet, Position } from '@/stores/player';
import { formatLoad, formatRepTarget } from '@/lib/stats';

defineProps<{
  plan: PlanExercise[];
}>();

const emit = defineEmits<{ jump: [pos: Position] }>();

function chipClass(s: PlanSet): string {
  switch (s.status) {
    case 'completed':
      return 'border-work/50 bg-work/15 text-work';
    case 'skipped':
      return 'border-warn/50 bg-warn/10 text-warn';
    case 'pending':
      return 'border-rest/60 bg-rest/15 text-rest';
    case 'current':
      return 'border-accent bg-accent text-accent-ink ring-2 ring-accent/40 ring-offset-2 ring-offset-surface-1';
    default:
      return 'border-border bg-surface-2 text-faint hover:border-muted hover:text-text';
  }
}

function chipText(s: PlanSet): string {
  if (s.status === 'skipped') return '–';
  if ((s.status === 'completed' || s.status === 'pending') && s.reps !== null) return String(s.reps);
  return String(s.setIndex + 1);
}

function chipLabel(ex: PlanExercise, s: PlanSet): string {
  const base = `${ex.exercise.name}, set ${s.setIndex + 1}`;
  switch (s.status) {
    case 'completed':
      return `${base}: done, ${s.reps} reps. Tap to redo`;
    case 'skipped':
      return `${base}: skipped. Tap to do it now`;
    case 'pending':
      return `${base}: just finished, ${s.reps} reps. Tap to redo`;
    case 'current':
      return `${base}: current set`;
    default:
      return `${base}: not done yet. Tap to go there`;
  }
}

function doneCount(ex: PlanExercise): number {
  return ex.sets.filter((s) => s.status === 'completed' || s.status === 'pending').length;
}
</script>

<template>
  <ol class="space-y-2">
    <li
      v-for="ex in plan"
      :key="ex.exercise.id"
      class="rounded-2xl border px-3 py-2.5 transition"
      :class="ex.isCurrent ? 'border-accent/50 bg-surface-2/60' : 'border-border bg-surface-1'"
    >
      <div class="flex items-baseline justify-between gap-2">
        <p class="min-w-0 truncate text-sm font-semibold" :class="ex.isCurrent ? 'text-text' : 'text-muted'">
          <span class="tnum mr-1 text-faint">{{ ex.exerciseIndex + 1 }}.</span>{{ ex.exercise.name }}
        </p>
        <p class="tnum shrink-0 text-xs text-faint">
          {{ ex.exercise.sets }}×{{ formatRepTarget(ex.exercise) }}
          <template v-if="ex.workingWeight > 0">· {{ formatLoad(ex.workingWeight, ex.exercise) }}</template>
          · {{ doneCount(ex) }}/{{ ex.exercise.sets }}
        </p>
      </div>
      <div class="mt-2 flex flex-wrap gap-1.5">
        <button
          v-for="s in ex.sets"
          :key="s.setIndex"
          type="button"
          class="tnum flex h-9 min-w-[40px] items-center justify-center rounded-lg border px-2 text-sm font-semibold transition"
          :class="chipClass(s)"
          :aria-label="chipLabel(ex, s)"
          :aria-current="s.status === 'current' ? 'step' : undefined"
          @click="emit('jump', { exerciseIndex: ex.exerciseIndex, setIndex: s.setIndex })"
        >
          {{ chipText(s) }}
        </button>
      </div>
    </li>
  </ol>
  <p class="mt-3 text-center text-[11px] text-faint">
    Tap any set to jump there. Done sets keep their log until you redo them.
  </p>
</template>

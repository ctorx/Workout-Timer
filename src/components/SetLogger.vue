<script setup lang="ts">
/**
 * Logs one set: reps, weight and effort (reps left in the tank).
 * Used during rest for the set just finished, and on the summary screen
 * to correct any set.
 */
import { computed } from 'vue';
import type { Unit } from '@/types';
import { useSettingsStore } from '@/stores/settings';
import NumberStepper from '@/components/NumberStepper.vue';

const props = defineProps<{
  reps: number;
  weight: number;
  unit: Unit;
  rir: number | null;
  /** Bottom of the rep range. */
  targetReps: number;
  /** Top of the rep range (defaults to targetReps). */
  repsMax?: number;
  /** Weight +/- step (defaults to the Settings step for the unit). */
  weightStep?: number;
  /** Shows the per-dumbbell weight under the total. */
  paired?: boolean;
}>();

const emit = defineEmits<{
  'update:reps': [value: number];
  'update:weight': [value: number];
  'update:rir': [value: number | null];
}>();

const settings = useSettingsStore();
const weightStep = computed(
  () =>
    props.weightStep ??
    (props.unit === 'kg' ? settings.settings.weightStepKg || 2.5 : settings.settings.weightStepLb || 5),
);

const top = computed(() => Math.max(props.targetReps, props.repsMax ?? props.targetReps));
const isRange = computed(() => top.value > props.targetReps);

const repsTone = computed(() => (props.reps >= props.targetReps ? 'good' : 'short'));

const RIR_OPTIONS = [
  { value: 0, label: '0', hint: 'Failure' },
  { value: 1, label: '1', hint: '' },
  { value: 2, label: '2', hint: '' },
  { value: 3, label: '3', hint: '' },
  { value: 4, label: '4+', hint: 'Easy' },
];

function pickRir(v: number): void {
  emit('update:rir', props.rir === v ? null : v);
}
</script>

<template>
  <div class="w-full">
    <div class="space-y-2">
      <NumberStepper
        :model-value="reps"
        label="Reps"
        layout="row"
        :tone="repsTone"
        @update:model-value="emit('update:reps', $event)"
      />
      <p class="tnum -mt-1 text-right text-xs text-faint">
        <template v-if="isRange">
          Range {{ targetReps }}–{{ top }}
          <template v-if="reps >= top"> · <span class="text-work">top of range</span></template>
          <template v-else-if="reps >= targetReps"> · <span class="text-work">in range</span>, {{ top - reps }} to the top</template>
          <template v-else> · {{ targetReps - reps }} below range</template>
        </template>
        <template v-else>
          Target {{ targetReps }}
          <template v-if="reps >= targetReps"> · <span class="text-work">target hit</span></template>
          <template v-else> · {{ targetReps - reps }} short</template>
        </template>
      </p>
      <NumberStepper
        :model-value="weight"
        label="Weight"
        layout="row"
        :step="weightStep"
        :max="9999"
        :suffix="unit"
        zero-text="BW"
        @update:model-value="emit('update:weight', $event)"
      />
      <p v-if="paired && weight > 0" class="tnum -mt-1 text-right text-xs text-faint">
        2 × {{ Number.isInteger(weight / 2) ? weight / 2 : (weight / 2).toFixed(1) }} {{ unit }} dumbbells
      </p>
    </div>

    <fieldset class="mt-3">
      <legend class="w-full text-center text-[11px] font-semibold uppercase tracking-widest text-muted">
        Reps left in the tank
      </legend>
      <div class="mt-1.5 flex justify-center gap-1.5" role="radiogroup" aria-label="Reps left in the tank">
        <button
          v-for="opt in RIR_OPTIONS"
          :key="opt.value"
          type="button"
          role="radio"
          :aria-checked="rir === opt.value"
          :aria-label="`${opt.label} reps left${opt.hint ? ` (${opt.hint})` : ''}`"
          class="tnum flex h-11 min-w-[48px] flex-col items-center justify-center rounded-xl border text-sm font-semibold transition"
          :class="
            rir === opt.value
              ? 'border-accent bg-accent text-accent-ink'
              : 'border-border bg-surface-2 text-text hover:border-muted'
          "
          @click="pickRir(opt.value)"
        >
          {{ opt.label }}
        </button>
      </div>
      <p class="mt-1 text-center text-[11px] text-faint">0 = could not do another · aim for 1–3</p>
    </fieldset>
  </div>
</template>

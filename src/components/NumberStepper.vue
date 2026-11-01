<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import { haptics } from '@/lib/haptics';

const props = withDefaults(
  defineProps<{
    modelValue: number;
    /** Visible label above the value, also used for button names. */
    label: string;
    step?: number;
    min?: number;
    max?: number;
    /** Text after the value, like "lb". */
    suffix?: string;
    /** Shown instead of the value when it is 0 (e.g. "BW"). */
    zeroText?: string;
    /** Highlights the value against a target. */
    tone?: 'default' | 'good' | 'short';
    size?: 'md' | 'lg';
    /** 'stack' puts the label above; 'row' puts it on the left. */
    layout?: 'stack' | 'row';
  }>(),
  { step: 1, min: 0, max: 999, suffix: '', zeroText: '', tone: 'default', size: 'md', layout: 'stack' },
);

const emit = defineEmits<{ 'update:modelValue': [value: number] }>();

const editing = ref(false);
const inputEl = ref<HTMLInputElement | null>(null);

function clamp(v: number): number {
  const rounded = Math.round(v * 100) / 100;
  return Math.min(props.max, Math.max(props.min, rounded));
}

function commit(v: number): void {
  emit('update:modelValue', clamp(v));
}

function stepBy(dir: -1 | 1): void {
  haptics.tap();
  commit(props.modelValue + dir * props.step);
}

/* Press and hold repeats the step. */
let holdTimeout: ReturnType<typeof setTimeout> | null = null;
let holdInterval: ReturnType<typeof setInterval> | null = null;
let held = false;

function holdStart(dir: -1 | 1, e: PointerEvent): void {
  if (e.button !== 0) return;
  held = false;
  holdTimeout = setTimeout(() => {
    held = true;
    holdInterval = setInterval(() => stepBy(dir), 120);
  }, 420);
}

function holdEnd(dir: -1 | 1, apply: boolean): void {
  if (holdTimeout) clearTimeout(holdTimeout);
  if (holdInterval) clearInterval(holdInterval);
  holdTimeout = null;
  holdInterval = null;
  if (apply && !held) stepBy(dir);
  held = false;
}

onBeforeUnmount(() => holdEnd(1, false));

function openEditor(): void {
  editing.value = true;
  requestAnimationFrame(() => {
    inputEl.value?.focus();
    inputEl.value?.select();
  });
}

function closeEditor(e: Event): void {
  const parsed = Number.parseFloat((e.target as HTMLInputElement).value);
  if (!Number.isNaN(parsed)) commit(parsed);
  editing.value = false;
}

const display = computed(() => {
  if (props.modelValue === 0 && props.zeroText) return props.zeroText;
  const v = props.modelValue;
  return Number.isInteger(v) ? String(v) : v.toFixed(1).replace(/\.0$/, '');
});

const toneClass = computed(() =>
  props.tone === 'good' ? 'text-work' : props.tone === 'short' ? 'text-warn' : 'text-text',
);

const btn = computed(() =>
  props.size === 'lg' ? 'h-14 w-14 text-3xl' : 'h-12 w-12 text-2xl',
);
const valueText = computed(() => (props.size === 'lg' ? 'text-5xl' : 'text-4xl'));
</script>

<template>
  <div :class="layout === 'row' ? 'flex items-center justify-between gap-3' : 'flex flex-col items-center'">
    <span class="text-[11px] font-semibold uppercase tracking-widest text-muted">{{ label }}</span>
    <div class="flex items-center gap-2" :class="layout === 'row' ? '' : 'mt-1'">
      <button
        type="button"
        class="flex shrink-0 select-none items-center justify-center rounded-full bg-surface-2 font-semibold text-text transition active:scale-95 hover:bg-border"
        :class="btn"
        :aria-label="`Decrease ${label}`"
        @pointerdown="holdStart(-1, $event)"
        @pointerup="holdEnd(-1, true)"
        @pointerleave="holdEnd(-1, false)"
        @pointercancel="holdEnd(-1, false)"
        @keydown.enter.prevent="stepBy(-1)"
        @keydown.space.prevent="stepBy(-1)"
        @contextmenu.prevent
      >
        &minus;
      </button>

      <button
        v-if="!editing"
        type="button"
        class="tnum min-w-[88px] rounded-xl px-1 text-center font-bold leading-none tracking-tight"
        :class="[valueText, toneClass]"
        :aria-label="`${label}: ${display}${suffix ? ' ' + suffix : ''}. Tap to type a value`"
        @click="openEditor"
      >
        {{ display }}<span v-if="suffix && !(modelValue === 0 && zeroText)" class="ml-1 text-base font-semibold text-muted">{{ suffix }}</span>
      </button>
      <input
        v-else
        ref="inputEl"
        type="number"
        inputmode="decimal"
        :min="min"
        :max="max"
        :step="step"
        :value="modelValue"
        :aria-label="label"
        class="tnum w-[100px] rounded-xl border border-border bg-surface-2 px-2 py-1 text-center text-3xl font-bold"
        @blur="closeEditor"
        @keydown.enter="($event.target as HTMLInputElement).blur()"
      />

      <button
        type="button"
        class="flex shrink-0 select-none items-center justify-center rounded-full bg-surface-2 font-semibold text-text transition active:scale-95 hover:bg-border"
        :class="btn"
        :aria-label="`Increase ${label}`"
        @pointerdown="holdStart(1, $event)"
        @pointerup="holdEnd(1, true)"
        @pointerleave="holdEnd(1, false)"
        @pointercancel="holdEnd(1, false)"
        @keydown.enter.prevent="stepBy(1)"
        @keydown.space.prevent="stepBy(1)"
        @contextmenu.prevent
      >
        +
      </button>
    </div>
  </div>
</template>

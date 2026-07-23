<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue';
import { haptics } from '@/lib/haptics';

const props = defineProps<{
  modelValue: number;
  label?: string;
}>();

const emit = defineEmits<{ 'update:modelValue': [value: number] }>();

const editing = ref(false);
const inputEl = ref<HTMLInputElement | null>(null);

function commit(value: number): void {
  emit('update:modelValue', Math.min(999, Math.max(0, Math.round(value))));
}

function step(delta: number): void {
  haptics.tap();
  commit(props.modelValue + delta);
}

/* Long-press repeats the step. */
let holdTimeout: ReturnType<typeof setTimeout> | null = null;
let holdInterval: ReturnType<typeof setInterval> | null = null;
let held = false;

function holdStart(delta: number): void {
  held = false;
  holdTimeout = setTimeout(() => {
    held = true;
    holdInterval = setInterval(() => step(delta), 140);
  }, 450);
}

function holdEnd(delta: number, apply: boolean): void {
  if (holdTimeout) clearTimeout(holdTimeout);
  if (holdInterval) clearInterval(holdInterval);
  holdTimeout = null;
  holdInterval = null;
  if (apply && !held) step(delta);
  held = false;
}

onBeforeUnmount(() => holdEnd(0, false));

function openEditor(): void {
  editing.value = true;
  requestAnimationFrame(() => {
    inputEl.value?.focus();
    inputEl.value?.select();
  });
}

function closeEditor(e: Event): void {
  const raw = (e.target as HTMLInputElement).value;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isNaN(parsed)) commit(parsed);
  editing.value = false;
}
</script>

<template>
  <div class="flex items-center justify-center gap-4">
    <button
      type="button"
      class="flex h-16 w-16 items-center justify-center rounded-full bg-surface-2 text-3xl font-semibold text-text active:scale-95"
      :aria-label="`Fewer reps${label ? ` for ${label}` : ''}`"
      @pointerdown="holdStart(-1)"
      @pointerup="holdEnd(-1, true)"
      @pointerleave="holdEnd(-1, false)"
      @pointercancel="holdEnd(-1, false)"
      @keydown.enter.prevent="step(-1)"
      @keydown.space.prevent="step(-1)"
      @contextmenu.prevent
    >
      &minus;
    </button>

    <button
      v-if="!editing"
      type="button"
      class="tnum min-w-[96px] rounded-xl px-2 py-1 text-center text-6xl font-bold tracking-tight"
      aria-label="Edit rep count"
      @click="openEditor"
    >
      {{ modelValue }}
    </button>
    <input
      v-else
      ref="inputEl"
      type="number"
      inputmode="numeric"
      min="0"
      max="999"
      :value="modelValue"
      class="tnum w-[110px] rounded-xl border border-border bg-surface-2 px-2 py-1 text-center text-6xl font-bold"
      @blur="closeEditor"
      @keydown.enter="($event.target as HTMLInputElement).blur()"
    />

    <button
      type="button"
      class="flex h-16 w-16 items-center justify-center rounded-full bg-surface-2 text-3xl font-semibold text-text active:scale-95"
      :aria-label="`More reps${label ? ` for ${label}` : ''}`"
      @pointerdown="holdStart(1)"
      @pointerup="holdEnd(1, true)"
      @pointerleave="holdEnd(1, false)"
      @pointercancel="holdEnd(1, false)"
      @keydown.enter.prevent="step(1)"
      @keydown.space.prevent="step(1)"
      @contextmenu.prevent
    >
      +
    </button>
  </div>
</template>

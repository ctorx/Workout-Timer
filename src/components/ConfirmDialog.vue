<script setup lang="ts">
import { computed, ref, watch } from 'vue';

const props = withDefaults(
  defineProps<{
    open: boolean;
    title: string;
    message?: string;
    confirmLabel: string;
    cancelLabel?: string;
    danger?: boolean;
    /** When set, the user must type this exact word to enable confirm. */
    typedConfirmation?: string;
  }>(),
  { cancelLabel: 'Cancel', danger: false },
);

const emit = defineEmits<{ confirm: []; cancel: [] }>();

const typed = ref('');
watch(
  () => props.open,
  () => {
    typed.value = '';
  },
);

const confirmEnabled = computed(
  () => !props.typedConfirmation || typed.value === props.typedConfirmation,
);
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-4 sm:items-center"
      role="dialog"
      aria-modal="true"
      :aria-label="title"
      @click.self="emit('cancel')"
      @keydown.escape="emit('cancel')"
    >
      <div class="w-full max-w-sm rounded-2xl border border-border bg-surface-1 p-5 shadow-xl">
        <h2 class="text-lg font-semibold">{{ title }}</h2>
        <p v-if="message" class="mt-2 whitespace-pre-line text-sm text-muted">{{ message }}</p>
        <div v-if="typedConfirmation" class="mt-4">
          <label class="text-sm text-muted" for="typed-confirm">
            Type <span class="font-mono font-semibold text-text">{{ typedConfirmation }}</span> to confirm
          </label>
          <input
            id="typed-confirm"
            v-model="typed"
            type="text"
            autocomplete="off"
            autocapitalize="characters"
            class="mt-1 w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-text"
          />
        </div>
        <div class="mt-5 flex gap-3">
          <button
            type="button"
            class="min-h-[44px] flex-1 rounded-xl bg-surface-2 px-4 font-medium text-text"
            @click="emit('cancel')"
          >
            {{ cancelLabel }}
          </button>
          <button
            type="button"
            class="min-h-[44px] flex-1 rounded-xl px-4 font-semibold disabled:opacity-40"
            :class="danger ? 'bg-danger text-white' : 'bg-accent text-accent-ink'"
            :disabled="!confirmEnabled"
            @click="emit('confirm')"
          >
            {{ confirmLabel }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

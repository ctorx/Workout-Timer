<script setup lang="ts">
import { computed } from 'vue';

const props = withDefaults(
  defineProps<{
    /** 0..1 — how much of the ring is drawn */
    fraction: number;
    /** px */
    size?: number;
    thickness?: number;
  }>(),
  { size: 280, thickness: 10 },
);

const radius = computed(() => (props.size - props.thickness) / 2);
const circumference = computed(() => 2 * Math.PI * radius.value);
const dashOffset = computed(
  () => circumference.value * (1 - Math.min(1, Math.max(0, props.fraction))),
);
</script>

<template>
  <div class="relative inline-flex items-center justify-center" :style="{ width: `${size}px`, height: `${size}px` }">
    <svg :width="size" :height="size" class="-rotate-90" aria-hidden="true">
      <circle
        :cx="size / 2"
        :cy="size / 2"
        :r="radius"
        fill="none"
        stroke="currentColor"
        :stroke-width="thickness"
        class="opacity-15"
      />
      <circle
        :cx="size / 2"
        :cy="size / 2"
        :r="radius"
        fill="none"
        stroke="currentColor"
        :stroke-width="thickness"
        stroke-linecap="round"
        :stroke-dasharray="circumference"
        :stroke-dashoffset="dashOffset"
        class="ring-arc"
      />
    </svg>
    <div class="absolute inset-0 flex items-center justify-center">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.ring-arc {
  transition: stroke-dashoffset 120ms linear;
}
@media (prefers-reduced-motion: reduce) {
  .ring-arc {
    transition: none;
  }
}
</style>

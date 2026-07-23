<script setup lang="ts">
import { computed } from 'vue';

const props = withDefaults(
  defineProps<{
    values: number[];
    width?: number;
    height?: number;
  }>(),
  { width: 120, height: 32 },
);

const points = computed(() => {
  const vs = props.values;
  if (vs.length === 0) return '';
  const max = Math.max(...vs, 1);
  const min = Math.min(...vs, 0);
  const range = max - min || 1;
  const stepX = vs.length > 1 ? props.width / (vs.length - 1) : 0;
  return vs
    .map((v, i) => {
      const x = vs.length > 1 ? i * stepX : props.width / 2;
      const y = props.height - 3 - ((v - min) / range) * (props.height - 6);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
});

const lastPoint = computed(() => {
  const parts = points.value.split(' ');
  const last = parts[parts.length - 1];
  if (!last) return null;
  const [x, y] = last.split(',');
  return { x, y };
});
</script>

<template>
  <svg
    :width="width"
    :height="height"
    :viewBox="`0 0 ${width} ${height}`"
    class="text-accent"
    aria-hidden="true"
  >
    <polyline
      v-if="values.length > 1"
      :points="points"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
    <circle v-if="lastPoint" :cx="lastPoint.x" :cy="lastPoint.y" r="2.5" fill="currentColor" />
  </svg>
</template>

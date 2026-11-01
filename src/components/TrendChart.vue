<script setup lang="ts">
/**
 * One-series trend line with a tap/hover tooltip.
 * 2 px line, 8 px markers, a faint min/max grid, labels in text colors.
 * The page shows the same data as a list, which serves as the table view.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

const props = withDefaults(
  defineProps<{
    points: { label: string; value: number; detail?: string }[];
    /** Formats a value for axis labels and the tooltip. */
    format?: (v: number) => string;
    height?: number;
    label: string;
  }>(),
  { format: (v: number) => String(Math.round(v)), height: 150 },
);

const box = ref<HTMLDivElement | null>(null);
const width = ref(320);
let observer: ResizeObserver | null = null;

onMounted(() => {
  if (!box.value) return;
  width.value = box.value.clientWidth || 320;
  observer = new ResizeObserver((entries) => {
    width.value = Math.max(200, entries[0]!.contentRect.width);
  });
  observer.observe(box.value);
});
onBeforeUnmount(() => observer?.disconnect());

const PAD = { top: 16, right: 16, bottom: 26, left: 44 };

const scale = computed(() => {
  const vs = props.points.map((p) => p.value);
  let min = Math.min(...vs);
  let max = Math.max(...vs);
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const pad = (max - min) * 0.12;
  return { min: min - pad, max: max + pad };
});

const plotW = computed(() => width.value - PAD.left - PAD.right);
const plotH = computed(() => props.height - PAD.top - PAD.bottom);

function x(i: number): number {
  const n = props.points.length;
  return PAD.left + (n > 1 ? (i / (n - 1)) * plotW.value : plotW.value / 2);
}
function y(v: number): number {
  const { min, max } = scale.value;
  return PAD.top + (1 - (v - min) / (max - min)) * plotH.value;
}

const path = computed(() =>
  props.points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' '),
);

const gridValues = computed(() => {
  const vs = props.points.map((p) => p.value);
  return [Math.max(...vs), Math.min(...vs)];
});

const active = ref<number | null>(null);
function pick(e: PointerEvent): void {
  const rect = (e.currentTarget as SVGElement).getBoundingClientRect();
  const px = e.clientX - rect.left;
  let best = 0;
  let bestDist = Infinity;
  props.points.forEach((_, i) => {
    const d = Math.abs(x(i) - px);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  });
  active.value = best;
}

const tip = computed(() => {
  if (active.value === null) return null;
  const p = props.points[active.value];
  if (!p) return null;
  const left = Math.min(Math.max(x(active.value), 70), width.value - 70);
  return { ...p, left, top: y(p.value) };
});
</script>

<template>
  <div ref="box" class="relative w-full select-none">
    <svg
      :width="width"
      :height="height"
      :viewBox="`0 0 ${width} ${height}`"
      role="img"
      :aria-label="label"
      class="block touch-none"
      @pointermove="pick"
      @pointerdown="pick"
      @pointerleave="active = null"
    >
      <!-- recessive grid at the best and lowest values -->
      <g v-for="g in gridValues" :key="g">
        <line
          :x1="PAD.left"
          :x2="width - PAD.right"
          :y1="y(g)"
          :y2="y(g)"
          stroke="var(--c-border)"
          stroke-dasharray="3 4"
        />
        <text :x="PAD.left - 8" :y="y(g) + 4" text-anchor="end" class="tnum fill-[var(--c-text-faint)] text-[11px]">
          {{ format(g) }}
        </text>
      </g>
      <text :x="PAD.left" :y="height - 6" class="fill-[var(--c-text-faint)] text-[11px]">
        {{ points[0]?.label }}
      </text>
      <text
        v-if="points.length > 1"
        :x="width - PAD.right"
        :y="height - 6"
        text-anchor="end"
        class="fill-[var(--c-text-faint)] text-[11px]"
      >
        {{ points[points.length - 1]?.label }}
      </text>

      <line
        v-if="tip"
        :x1="x(active!)"
        :x2="x(active!)"
        :y1="PAD.top"
        :y2="PAD.top + plotH"
        stroke="var(--c-text-faint)"
        stroke-width="1"
      />
      <path
        v-if="points.length > 1"
        :d="path"
        fill="none"
        stroke="var(--c-accent)"
        stroke-width="2"
        stroke-linejoin="round"
        stroke-linecap="round"
      />
      <circle
        v-for="(p, i) in points"
        :key="i"
        :cx="x(i)"
        :cy="y(p.value)"
        :r="active === i ? 5.5 : 4"
        fill="var(--c-accent)"
        stroke="var(--c-surface-1)"
        stroke-width="2"
      />
    </svg>
    <div
      v-if="tip"
      class="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-lg border border-border bg-surface-2 px-2.5 py-1.5 text-xs shadow-lg"
      :style="{ left: `${tip.left}px`, top: `${tip.top - 10}px` }"
    >
      <p class="tnum font-semibold text-text">{{ format(tip.value) }}</p>
      <p class="text-muted">{{ tip.label }}</p>
      <p v-if="tip.detail" class="tnum text-faint">{{ tip.detail }}</p>
    </div>
  </div>
</template>

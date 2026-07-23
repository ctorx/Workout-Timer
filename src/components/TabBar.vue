<script setup lang="ts">
import { useRoute } from 'vue-router';

const route = useRoute();

const tabs = [
  {
    to: '/',
    label: 'Today',
    match: (name: unknown) => name === 'today' || name === 'workout-edit',
    icon: 'M8 2v3M16 2v3M4.5 8h15M5 4.5h14a1 1 0 0 1 1 1V20a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5.5a1 1 0 0 1 1-1Z',
  },
  {
    to: '/history',
    label: 'History',
    match: (name: unknown) => name === 'history' || name === 'session-detail',
    icon: 'M12 8v4l3 2M21 12a9 9 0 1 1-9-9 9 9 0 0 1 9 9Z',
  },
  {
    to: '/settings',
    label: 'Settings',
    match: (name: unknown) => name === 'settings',
    icon: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-3a7.4 7.4 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7.5 7.5 0 0 0-2-1.2L14.5 3h-5l-.4 2.6a7.5 7.5 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7.5 7.5 0 0 0 2 1.2l.4 2.6h5l.4-2.6a7.5 7.5 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.06-.4.1-.8.1-1.2Z',
  },
];
</script>

<template>
  <nav
    class="safe-bottom sticky bottom-0 z-20 border-t border-border bg-surface-1"
    aria-label="Main"
  >
    <div class="mx-auto flex max-w-xl">
      <router-link
        v-for="tab in tabs"
        :key="tab.to"
        :to="tab.to"
        class="flex min-h-[56px] flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-medium"
        :class="tab.match(route.name) ? 'text-accent' : 'text-muted'"
        :aria-current="tab.match(route.name) ? 'page' : undefined"
      >
        <svg
          viewBox="0 0 24 24"
          class="h-6 w-6"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path :d="tab.icon" />
        </svg>
        {{ tab.label }}
      </router-link>
    </div>
  </nav>
</template>

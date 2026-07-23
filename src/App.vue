<script setup lang="ts">
import { useRoute } from 'vue-router';
import TabBar from '@/components/TabBar.vue';

const route = useRoute();
</script>

<template>
  <div class="flex min-h-dvh flex-col bg-bg text-text">
    <router-view v-slot="{ Component }">
      <transition name="screen" mode="out-in">
        <component :is="Component" class="flex-1" />
      </transition>
    </router-view>
    <TabBar v-if="route.meta.tab" />
  </div>
</template>

<style>
.screen-enter-active,
.screen-leave-active {
  transition: opacity 120ms ease;
}
.screen-enter-from,
.screen-leave-to {
  opacity: 0;
}
</style>

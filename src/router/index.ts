import { createRouter, createWebHistory } from 'vue-router';
import { usePlayerStore } from '@/stores/player';

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/',
      name: 'today',
      component: () => import('@/views/TodayView.vue'),
      meta: { tab: true, title: 'Today' },
    },
    {
      path: '/workouts/:id/edit',
      name: 'workout-edit',
      component: () => import('@/views/WorkoutEditView.vue'),
      meta: { tab: true, title: 'Edit workout' },
    },
    {
      path: '/play/:workoutId',
      name: 'play',
      component: () => import('@/views/PlayerView.vue'),
      meta: { tab: false, title: 'Player' },
    },
    {
      path: '/history',
      name: 'history',
      component: () => import('@/views/HistoryView.vue'),
      meta: { tab: true, title: 'History' },
    },
    {
      path: '/history/:id',
      name: 'session-detail',
      component: () => import('@/views/SessionDetailView.vue'),
      meta: { tab: true, title: 'Session' },
    },
    {
      path: '/settings',
      name: 'settings',
      component: () => import('@/views/SettingsView.vue'),
      meta: { tab: true, title: 'Settings' },
    },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
});

// A workout cannot be edited while it is being played (§11.10).
router.beforeEach((to) => {
  if (to.name === 'workout-edit') {
    const player = usePlayerStore();
    if (player.isRunning && player.workout?.id === to.params.id) {
      return { name: 'play', params: { workoutId: to.params.id as string } };
    }
  }
  return true;
});

export default router;

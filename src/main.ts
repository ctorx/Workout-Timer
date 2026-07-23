import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { registerSW } from 'virtual:pwa-register';
import App from '@/App.vue';
import router from '@/router';
import { initPersistence } from '@/lib/persistence';
import { useSettingsStore } from '@/stores/settings';
import { useWorkoutsStore } from '@/stores/workouts';
import { useSessionsStore } from '@/stores/sessions';
import { usePlayerStore } from '@/stores/player';
import { resumeAudioIfNeeded } from '@/lib/audio';
import '@/style.css';

registerSW({ immediate: true });

async function boot(): Promise<void> {
  const app = createApp(App);
  app.use(createPinia());

  const settings = useSettingsStore();
  settings.initTheme();

  // A storage failure (quota, private browsing quirks) must never blank
  // the app — the UI itself is where the user can export or free space.
  try {
    await initPersistence();
    await Promise.all([useWorkoutsStore().load(), useSessionsStore().load()]);
  } catch (err) {
    console.error('Storage unavailable at boot:', err);
  }

  app.use(router);
  app.mount('#app');

  // Background tabs throttle timers and iOS suspends audio: reconcile the
  // player clock and the AudioContext whenever we come back.
  const player = usePlayerStore();
  const reconcile = () => {
    resumeAudioIfNeeded();
    player.tick(Date.now());
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') reconcile();
  });
  window.addEventListener('focus', reconcile);
  window.addEventListener('pageshow', reconcile);
}

void boot();

import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from '@/App.vue';
import router from '@/router';
import { initPersistence } from '@/lib/persistence';
import { initUpdates } from '@/lib/updates';
import { useSettingsStore } from '@/stores/settings';
import { useWorkoutsStore } from '@/stores/workouts';
import { useSessionsStore } from '@/stores/sessions';
import { startPlayerRuntime } from '@/lib/playerRuntime';
import '@/style.css';

initUpdates();

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

  // Clock, scheduled sound, vibration and wake lock for the whole app.
  startPlayerRuntime();
}

void boot();

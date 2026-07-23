import { defineStore } from 'pinia';
import type { Settings } from '@/types';
import { LS_KEYS, readLocal, writeLocal } from '@/lib/persistence';

export const DEFAULT_SETTINGS: Settings = {
  defaultUnit: 'lb',
  defaultRestBetweenSets: 90,
  defaultRestAfterExercise: 120,
  soundEnabled: true,
  vibrationEnabled: true,
  keepScreenAwake: true,
  countdownBeepsAt: [5, 4, 3, 2, 1],
  theme: 'dark',
};

let mediaListenerAttached = false;

function applyTheme(theme: Settings['theme']): void {
  if (typeof document === 'undefined') return;
  const prefersLight =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: light)').matches;
  const light = theme === 'light' || (theme === 'system' && prefersLight);
  document.documentElement.classList.toggle('light', light);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', light ? '#f2f4f7' : '#0E1116');
}

export const useSettingsStore = defineStore('settings', {
  state: (): { settings: Settings } => ({
    settings: { ...DEFAULT_SETTINGS, ...(readLocal<Partial<Settings>>(LS_KEYS.settings) ?? {}) },
  }),
  actions: {
    update(patch: Partial<Settings>) {
      this.settings = { ...this.settings, ...patch };
      writeLocal(LS_KEYS.settings, this.settings);
      if (patch.theme !== undefined) applyTheme(this.settings.theme);
    },
    initTheme() {
      applyTheme(this.settings.theme);
      if (!mediaListenerAttached && typeof window.matchMedia === 'function') {
        window
          .matchMedia('(prefers-color-scheme: light)')
          .addEventListener('change', () => applyTheme(this.settings.theme));
        mediaListenerAttached = true;
      }
    },
    reset() {
      this.settings = { ...DEFAULT_SETTINGS };
      writeLocal(LS_KEYS.settings, this.settings);
      applyTheme(this.settings.theme);
    },
  },
});

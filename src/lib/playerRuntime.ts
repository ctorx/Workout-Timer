/**
 * Runs the player for the whole app, not just while the player screen is
 * mounted, so a workout keeps timing and alerting if you navigate away or
 * the page goes to the background.
 *
 * - Clock: a 200 ms interval calls player.tick(). Unlike
 *   requestAnimationFrame, intervals keep running (throttled) in hidden pages.
 * - Sound: whenever the player's timing changes, the upcoming cues are placed
 *   on the audio clock (lib/cuePlan.ts), up to two minutes ahead, so they
 *   play on time even when JavaScript is throttled.
 * - Keep-alive: an inaudible tone while a workout runs stops Chrome from
 *   throttling or freezing the page (Settings → background sound).
 * - Vibration follows the player's events while the page is awake.
 * - Screen wake lock while a workout runs.
 * - Any tap resumes a suspended audio context (after a refresh, or after
 *   iOS interrupted it).
 */
import { watch } from 'vue';
import { ALARM_INTERVAL_MS, usePlayerStore } from '@/stores/player';
import { useSettingsStore } from '@/stores/settings';
import {
  audioIsReady,
  cancelScheduledCues,
  onAudioStateChange,
  playCue,
  resumeAudioIfNeeded,
  scheduleCue,
  startKeepAlive,
  stopKeepAlive,
  unlockAudio,
} from '@/lib/audio';
import { planCues } from '@/lib/cuePlan';
import { haptics } from '@/lib/haptics';
import { releaseWakeLock, requestWakeLock } from '@/lib/wakeLock';

const LOOKAHEAD_MS = 120_000;
const REFILL_BELOW_MS = 60_000;

let started = false;

export function startPlayerRuntime(): void {
  if (started) return;
  started = true;

  const player = usePlayerStore();
  const settingsStore = useSettingsStore();

  /* ------------------------------ clock ------------------------------ */

  setInterval(() => {
    player.tick(Date.now());
    syncCues(false);
  }, 200);

  /* ------------------------------ sound ------------------------------ */

  let cueKey = '';
  let horizon = 0;
  /** Cues already handed to the audio clock, so a replan never repeats one. */
  const placed = new Map<string, number>();

  function currentKey(): string {
    const t = player.timer;
    return [
      player.phase,
      t.kind,
      t.endsAt,
      t.startedAt,
      player.countdownBeepsAt.join(','),
    ].join('|');
  }

  function syncCues(force: boolean): void {
    const now = Date.now();
    const wanted = player.isRunning && settingsStore.settings.soundEnabled && audioIsReady();
    if (!wanted) {
      if (cueKey !== '') {
        cancelScheduledCues();
        placed.clear();
        cueKey = '';
      }
      return;
    }
    const key = currentKey();
    if (force || key !== cueKey) {
      cancelScheduledCues();
      for (const [k, at] of placed) if (at > now) placed.delete(k);
      cueKey = key;
      horizon = now - 300; // include a cue that is due right now
    } else if (horizon - now > REFILL_BELOW_MS) {
      return;
    }
    const until = Math.max(now, player.timer.endsAt ?? now) + LOOKAHEAD_MS;
    const cues = planCues(
      {
        phase: player.phase,
        timer: player.timer,
        beepsAt: player.countdownBeepsAt,
        alarmIntervalMs: ALARM_INTERVAL_MS,
      },
      horizon,
      until,
    );
    for (const c of cues) {
      const k = `${c.kind}@${Math.round(c.atMs)}`;
      if (placed.has(k)) continue;
      placed.set(k, c.atMs);
      scheduleCue(c.kind, c.atMs, now);
    }
    horizon = until;
    for (const [k, at] of placed) if (at < now - 10_000) placed.delete(k);
  }

  watch(
    () => [currentKey(), player.isRunning, settingsStore.settings.soundEnabled] as const,
    () => syncCues(false),
  );
  onAudioStateChange(() => syncCues(true));

  watch(
    () => settingsStore.settings.countdownBeepsAt,
    (beeps) => player.setCountdownBeeps(beeps),
    { immediate: true },
  );

  /* ------------------ immediate cues and vibration ------------------- */

  player.onEvent((event) => {
    const s = settingsStore.settings;
    if (s.soundEnabled && audioIsReady()) {
      // Timed cues (ticks, alarm) are scheduled ahead; only these play now.
      if (event === 'go') playCue('go');
      else if (event === 'complete') playCue('complete');
    }
    if (s.vibrationEnabled) {
      if (event === 'beep') haptics.beep();
      else if (event === 'go' || event === 'alarm') haptics.go();
      else if (event === 'new_exercise') haptics.newExercise();
      else if (event === 'complete') haptics.complete();
    }
  });

  /* ---------------------- keep-alive and wake lock ------------------- */

  let audioState = 0; // bumps when the context changes state
  onAudioStateChange(() => {
    audioState += 1;
  });

  function syncKeepAlive(): void {
    const s = settingsStore.settings;
    if (player.isRunning && s.soundEnabled && s.backgroundAudio && audioIsReady()) startKeepAlive();
    else stopKeepAlive();
  }
  watch(
    () => [
      player.isRunning,
      settingsStore.settings.soundEnabled,
      settingsStore.settings.backgroundAudio,
      audioState,
    ],
    syncKeepAlive,
  );
  onAudioStateChange(syncKeepAlive);

  watch(
    () => [player.isRunning, settingsStore.settings.keepScreenAwake] as const,
    ([running, wanted]) => {
      if (running && wanted) requestWakeLock();
      else releaseWakeLock();
    },
    { immediate: true },
  );

  /* --------------------------- reconcile ----------------------------- */

  // A tap anywhere revives audio the browser suspended (refresh, iOS
  // interruption) without needing a dedicated button.
  document.addEventListener(
    'pointerdown',
    () => {
      if (player.isRunning) unlockAudio();
      else resumeAudioIfNeeded();
    },
    { capture: true, passive: true },
  );

  const reconcile = () => {
    resumeAudioIfNeeded();
    player.tick(Date.now());
    syncCues(true);
    syncKeepAlive();
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') reconcile();
  });
  window.addEventListener('focus', reconcile);
  window.addEventListener('pageshow', reconcile);
}

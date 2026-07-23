/**
 * Screen wake lock for the duration of a workout. Feature-detected;
 * degrades silently where unsupported. Re-acquired on visibilitychange
 * because the browser releases it when the page is hidden.
 */

let sentinel: WakeLockSentinel | null = null;
let wanted = false;
let listenerAttached = false;

async function acquire(): Promise<void> {
  if (!wanted || document.visibilityState !== 'visible') return;
  if (!('wakeLock' in navigator)) return;
  try {
    sentinel = await navigator.wakeLock.request('screen');
    sentinel.addEventListener('release', () => {
      sentinel = null;
    });
  } catch {
    // Denied (low battery, browser policy) — degrade silently.
  }
}

function onVisibilityChange(): void {
  if (wanted && document.visibilityState === 'visible' && !sentinel) {
    void acquire();
  }
}

export function requestWakeLock(): void {
  wanted = true;
  if (!listenerAttached) {
    document.addEventListener('visibilitychange', onVisibilityChange);
    listenerAttached = true;
  }
  void acquire();
}

export function releaseWakeLock(): void {
  wanted = false;
  if (sentinel) {
    void sentinel.release().catch(() => undefined);
    sentinel = null;
  }
}

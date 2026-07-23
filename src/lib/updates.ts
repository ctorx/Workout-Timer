/**
 * Service worker registration + forced update check for the PWA.
 */
import { registerSW } from 'virtual:pwa-register';
import { APP_VERSION } from '@/lib/version';

export type UpdateCheckResult =
  | 'updated' // new SW found; page is reloading
  | 'current' // already on the latest build
  | 'unavailable' // no service worker (e.g. local `npm run dev`)
  | 'error';

let updateSW: ((reloadPage?: boolean) => Promise<void>) | undefined;
let registration: ServiceWorkerRegistration | null = null;
let waitingForRefresh = false;

export function initUpdates(): void {
  updateSW = registerSW({
    immediate: true,
    onNeedRefresh() {
      waitingForRefresh = true;
    },
    onRegisteredSW(_url, reg) {
      registration = reg ?? null;
    },
  });
}

/**
 * Ask the browser for a fresh service worker. If one is waiting (or becomes
 * waiting), activate it and reload so the new commit is live.
 */
export async function checkForAppUpdate(): Promise<UpdateCheckResult> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return 'unavailable';
  }

  try {
    // Compare against a network-only version.json so we know if the host has a newer build.
    const remoteSha = await fetchRemoteVersion();
    const reg =
      registration ?? (await navigator.serviceWorker.getRegistration()) ?? null;
    registration = reg;

    if (reg) {
      await reg.update();
      await waitBriefly(400);

      if (reg.installing) {
        await waitForInstalled(reg.installing);
        await waitBriefly(100);
      }

      if (reg.waiting || waitingForRefresh) {
        waitingForRefresh = false;
        await updateSW?.(true);
        return 'updated';
      }
    }

    // No waiting SW, but the hosted version.json is newer — hard reload as fallback.
    if (remoteSha && remoteSha !== APP_VERSION) {
      const url = new URL(window.location.href);
      url.searchParams.set('v', remoteSha.slice(0, 7));
      window.location.replace(url.toString());
      return 'updated';
    }

    if (!reg) return 'unavailable';
    return 'current';
  } catch {
    return 'error';
  }
}

async function fetchRemoteVersion(): Promise<string | null> {
  try {
    const base = import.meta.env.BASE_URL || '/';
    const res = await fetch(`${base}version.json?t=${Date.now()}`, {
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { sha?: string };
    return typeof data.sha === 'string' ? data.sha : null;
  } catch {
    return null;
  }
}

function waitBriefly(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForInstalled(worker: ServiceWorker): Promise<void> {
  if (worker.state === 'installed') return Promise.resolve();
  return new Promise((resolve) => {
    const onState = () => {
      if (worker.state === 'installed' || worker.state === 'activated') {
        worker.removeEventListener('statechange', onState);
        resolve();
      }
    };
    worker.addEventListener('statechange', onState);
  });
}

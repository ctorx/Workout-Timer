/**
 * Single persistence module. All IndexedDB access goes through here.
 *
 * Layout (one object store, key-value):
 *   meta                 -> { schemaVersion: number }
 *   workouts             -> Workout[]
 *   session:<uuid>       -> Session          (one key per session; history
 *                                             grows without rewriting a blob)
 *   player-state         -> PersistedPlayerState | absent
 *
 * localStorage (settings + trivial preferences only, never history):
 *   wt.settings, wt.lastExportAt, wt.iosAudioNoteDismissed, wt.seeded
 */
import { createStore, get, set, del, entries, clear, type UseStore } from 'idb-keyval';
import type { PersistedPlayerState, Session, Workout } from '@/types';
import { SCHEMA_VERSION } from '@/types';

const META_KEY = 'meta';
const WORKOUTS_KEY = 'workouts';
const PLAYER_KEY = 'player-state';
const SESSION_PREFIX = 'session:';

/** Lazily created so this module can be imported in non-DOM tests. */
let _store: UseStore | null = null;
function store(): UseStore | null {
  if (typeof indexedDB === 'undefined') return null;
  if (!_store) _store = createStore('workout-timer', 'kv');
  return _store;
}

interface Meta {
  schemaVersion: number;
}

export class StorageWriteError extends Error {
  constructor(cause: unknown) {
    super(
      'Saving failed — your browser may be out of storage space. ' +
        'Export a backup from Settings before anything is lost.',
    );
    this.name = 'StorageWriteError';
    this.cause = cause;
  }
}

async function read<T>(key: string): Promise<T | undefined> {
  const s = store();
  if (!s) return undefined;
  return get<T>(key, s);
}

async function write(key: string, value: unknown): Promise<void> {
  const s = store();
  if (!s) return;
  try {
    await set(key, value, s);
  } catch (err) {
    throw new StorageWriteError(err);
  }
}

async function remove(key: string): Promise<void> {
  const s = store();
  if (!s) return;
  await del(key, s);
}

/** Runs once at startup: stamps the schema version, migrates when needed. */
export async function initPersistence(): Promise<void> {
  const meta = await read<Meta>(META_KEY);
  if (!meta) {
    await write(META_KEY, { schemaVersion: SCHEMA_VERSION } satisfies Meta);
    return;
  }
  if (meta.schemaVersion === SCHEMA_VERSION) return;
  if (meta.schemaVersion > SCHEMA_VERSION) {
    // Data written by a newer app version. Leave it untouched; the app
    // will still run, and unknown fields are harmless on read.
    return;
  }
  // Migration chain. There is only version 1 today; add steps here
  // (1 -> 2, 2 -> 3, ...) when the model changes, then re-stamp.
  await write(META_KEY, { schemaVersion: SCHEMA_VERSION } satisfies Meta);
}

/* ----------------------------- workouts ---------------------------- */

export async function loadWorkouts(): Promise<Workout[]> {
  return (await read<Workout[]>(WORKOUTS_KEY)) ?? [];
}

export async function saveWorkouts(workouts: Workout[]): Promise<void> {
  await write(WORKOUTS_KEY, workouts);
}

/* ----------------------------- sessions ---------------------------- */

export async function loadSessions(): Promise<Session[]> {
  const s = store();
  if (!s) return [];
  const all = await entries<string, Session>(s);
  return all
    .filter(([key]) => typeof key === 'string' && key.startsWith(SESSION_PREFIX))
    .map(([, value]) => value);
}

export async function saveSession(session: Session): Promise<void> {
  await write(SESSION_PREFIX + session.id, session);
}

export async function deleteSession(id: string): Promise<void> {
  await remove(SESSION_PREFIX + id);
}

/* --------------------------- player state -------------------------- */

export async function loadPlayerState(): Promise<PersistedPlayerState | null> {
  return (await read<PersistedPlayerState>(PLAYER_KEY)) ?? null;
}

export async function savePlayerState(state: PersistedPlayerState): Promise<void> {
  await write(PLAYER_KEY, state);
}

export async function clearPlayerState(): Promise<void> {
  await remove(PLAYER_KEY);
}

/* ------------------------------ global ----------------------------- */

export async function eraseAllData(): Promise<void> {
  const s = store();
  if (s) await clear(s);
  if (typeof localStorage !== 'undefined') localStorage.clear();
  await write(META_KEY, { schemaVersion: SCHEMA_VERSION } satisfies Meta);
}

export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return null;
  const { usage, quota } = await navigator.storage.estimate();
  return { usage: usage ?? 0, quota: quota ?? 0 };
}

/* --------------------------- localStorage --------------------------- */

export function readLocal<T>(key: string): T | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? null : (JSON.parse(raw) as T);
  } catch {
    return null;
  }
}

export function writeLocal(key: string, value: unknown): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Settings are non-critical; never crash on a full localStorage.
  }
}

export function removeLocal(key: string): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

export const LS_KEYS = {
  settings: 'wt.settings',
  lastExportAt: 'wt.lastExportAt',
  iosAudioNoteDismissed: 'wt.iosAudioNoteDismissed',
  seeded: 'wt.seeded',
} as const;

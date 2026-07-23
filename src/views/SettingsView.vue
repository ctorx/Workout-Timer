<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { ExportFile, Session, Workout } from '@/types';
import { useSettingsStore } from '@/stores/settings';
import { useWorkoutsStore } from '@/stores/workouts';
import { useSessionsStore } from '@/stores/sessions';
import {
  buildExportFile,
  downloadJson,
  exportFileName,
  findCollisions,
  ImportError,
  parseImportFile,
} from '@/lib/importExport';
import {
  eraseAllData,
  LS_KEYS,
  readLocal,
  saveSession,
  storageEstimate,
  writeLocal,
} from '@/lib/persistence';
import { uuid } from '@/lib/id';
import { APP_VERSION, shortVersion } from '@/lib/version';
import { checkForAppUpdate } from '@/lib/updates';
import ConfirmDialog from '@/components/ConfirmDialog.vue';

const settingsStore = useSettingsStore();
const workouts = useWorkoutsStore();
const sessions = useSessionsStore();

const s = computed(() => settingsStore.settings);

/* ------------------------------ version ------------------------------ */

const versionShort = shortVersion(APP_VERSION);
const versionFull = APP_VERSION;
const updateChecking = ref(false);
const updateMessage = ref('');
const updateIsError = ref(false);

async function onCheckForUpdates(): Promise<void> {
  updateChecking.value = true;
  updateMessage.value = '';
  updateIsError.value = false;
  const result = await checkForAppUpdate();
  updateChecking.value = false;
  if (result === 'updated') {
    updateMessage.value = 'Updating… reloading.';
    return;
  }
  if (result === 'current') {
    updateMessage.value = 'You’re on the latest version.';
    return;
  }
  if (result === 'unavailable') {
    updateMessage.value = 'Updates aren’t available here (no service worker).';
    updateIsError.value = true;
    return;
  }
  updateMessage.value = 'Couldn’t check for updates. Try again with a network connection.';
  updateIsError.value = true;
}

/* ---------------------------- basic fields --------------------------- */

const beepsText = ref(s.value.countdownBeepsAt.join(', '));
function commitBeeps(): void {
  const parsed = beepsText.value
    .split(/[,\s]+/)
    .map((x) => Number.parseInt(x, 10))
    .filter((n) => Number.isFinite(n) && n > 0 && n <= 60);
  const unique = [...new Set(parsed)].sort((a, b) => b - a);
  settingsStore.update({ countdownBeepsAt: unique });
  beepsText.value = unique.join(', ');
}

/* ------------------------------ storage ------------------------------ */

const usage = ref<{ usage: number; quota: number } | null>(null);
onMounted(async () => {
  usage.value = await storageEstimate();
});

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/* ------------------------------ export ------------------------------- */

const lastExportAt = ref(readLocal<string>(LS_KEYS.lastExportAt));

const exportStale = computed(() => {
  if (!lastExportAt.value) return sessions.ordered.length > 0 || workouts.ordered.length > 0;
  const age = Date.now() - new Date(lastExportAt.value).getTime();
  return age > 14 * 24 * 3600 * 1000;
});

function doExport(kind: 'workouts' | 'backup'): void {
  const file = buildExportFile(
    kind,
    JSON.parse(JSON.stringify(workouts.ordered)) as Workout[],
    kind === 'backup' ? s.value : null,
    kind === 'backup' ? (JSON.parse(JSON.stringify(sessions.ordered)) as Session[]) : null,
  );
  downloadJson(exportFileName(kind), file);
  lastExportAt.value = new Date().toISOString();
  writeLocal(LS_KEYS.lastExportAt, lastExportAt.value);
}

/* ------------------------------ import ------------------------------- */

const fileInput = ref<HTMLInputElement | null>(null);
const importErrors = ref<string[]>([]);
const importSuccess = ref('');
const pendingImport = ref<ExportFile | null>(null);
const collisionOpen = ref(false);
const collisionSummary = ref('');

async function onFilePicked(e: Event): Promise<void> {
  importErrors.value = [];
  importSuccess.value = '';
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  let parsed: ExportFile;
  try {
    parsed = parseImportFile(await file.text());
  } catch (err) {
    importErrors.value =
      err instanceof ImportError ? err.problems : ['Could not read the file.'];
    return;
  }
  const collisions = findCollisions(parsed, workouts.ordered, sessions.ordered);
  if (collisions.workoutIds.length > 0 || collisions.sessionIds.length > 0) {
    pendingImport.value = parsed;
    const parts: string[] = [];
    if (collisions.workoutIds.length > 0) parts.push(`${collisions.workoutIds.length} workout(s)`);
    if (collisions.sessionIds.length > 0) parts.push(`${collisions.sessionIds.length} session(s)`);
    collisionSummary.value =
      `${parts.join(' and ')} in this file already exist here.\n\n` +
      'Merge keeps both copies (imported items get new IDs). ' +
      'Replace overwrites the existing items with the file’s version.';
    collisionOpen.value = true;
    return;
  }
  await applyImport(parsed, 'merge');
}

async function applyImport(file: ExportFile, mode: 'merge' | 'replace'): Promise<void> {
  collisionOpen.value = false;
  pendingImport.value = null;
  try {
    await applyImportInner(file, mode);
  } catch (err) {
    importErrors.value = [err instanceof Error ? err.message : 'Import failed while saving.'];
  }
}

async function applyImportInner(file: ExportFile, mode: 'merge' | 'replace'): Promise<void> {

  const existingWorkoutIds = new Set(workouts.ordered.map((w) => w.id));
  const existingSessionIds = new Set(sessions.ordered.map((x) => x.id));

  let importedWorkouts = 0;
  let importedSessions = 0;

  const nextOrderBase =
    workouts.ordered.length > 0 ? Math.max(...workouts.ordered.map((w) => w.order)) + 1 : 0;

  const incoming = JSON.parse(JSON.stringify(file.workouts)) as Workout[];
  const merged = [...workouts.workouts];
  incoming
    .sort((a, b) => a.order - b.order)
    .forEach((w, i) => {
      const collides = existingWorkoutIds.has(w.id);
      if (collides && mode === 'replace') {
        const idx = merged.findIndex((m) => m.id === w.id);
        merged[idx >= 0 ? idx : merged.length] = w;
        importedWorkouts += 1;
        return;
      }
      if (collides && mode === 'merge') {
        w.id = uuid();
        w.exercises = w.exercises.map((ex) => ({ ...ex, id: uuid() }));
        w.name = `${w.name} (imported)`;
      }
      w.order = nextOrderBase + i;
      merged.push(w);
      importedWorkouts += 1;
    });
  await workouts.replaceAll(merged);

  if (file.sessions) {
    for (const sess of JSON.parse(JSON.stringify(file.sessions)) as Session[]) {
      const collides = existingSessionIds.has(sess.id);
      if (collides && mode === 'merge') sess.id = uuid();
      await saveSession(sess);
      const idx = sessions.sessions.findIndex((x) => x.id === sess.id);
      if (idx >= 0) sessions.sessions[idx] = sess;
      else sessions.sessions.push(sess);
      importedSessions += 1;
    }
  }

  if (file.settings) {
    settingsStore.update(file.settings);
    beepsText.value = settingsStore.settings.countdownBeepsAt.join(', ');
  }

  importSuccess.value =
    `Imported ${importedWorkouts} workout${importedWorkouts === 1 ? '' : 's'}` +
    (importedSessions > 0
      ? ` and ${importedSessions} session${importedSessions === 1 ? '' : 's'}`
      : '') +
    '.';
}

function cancelImport(): void {
  collisionOpen.value = false;
  pendingImport.value = null;
}

/* ------------------------------- erase -------------------------------- */

const eraseOpen = ref(false);
async function eraseAll(): Promise<void> {
  eraseOpen.value = false;
  await eraseAllData();
  window.location.href = '/';
}
</script>

<template>
  <main class="safe-top mx-auto w-full max-w-xl px-4 pb-8">
    <header class="py-4">
      <h1 class="text-2xl font-bold tracking-tight">Settings</h1>
    </header>

    <!-- Backup nudge: the safety net, not an afterthought -->
    <section
      v-if="exportStale"
      class="mb-4 rounded-2xl border border-warn/50 bg-surface-1 p-4 text-sm"
      aria-live="polite"
    >
      <p class="font-semibold text-warn">Back up your data</p>
      <p class="mt-1 text-muted">
        {{
          lastExportAt
            ? `Your last export was on ${new Date(lastExportAt).toLocaleDateString()} — more than two weeks ago.`
            : 'You have never exported your data.'
        }}
        Everything lives in this browser’s storage, which the browser can clear.
      </p>
      <button
        type="button"
        class="mt-2 min-h-[44px] rounded-xl bg-warn px-4 font-semibold text-black"
        @click="doExport('backup')"
      >
        Export full backup
      </button>
    </section>

    <!-- Defaults -->
    <section class="rounded-2xl border border-border bg-surface-1 p-4">
      <h2 class="text-xs font-semibold uppercase tracking-widest text-faint">Defaults</h2>

      <div class="mt-3 flex min-h-[44px] items-center justify-between">
        <span>Unit for new exercises</span>
        <div class="flex gap-1" role="radiogroup" aria-label="Default unit">
          <button
            v-for="u in ['lb', 'kg'] as const"
            :key="u"
            type="button"
            role="radio"
            :aria-checked="s.defaultUnit === u"
            class="min-h-[44px] rounded-xl px-4 text-sm font-semibold"
            :class="s.defaultUnit === u ? 'bg-accent text-accent-ink' : 'bg-surface-2 text-muted'"
            @click="settingsStore.update({ defaultUnit: u })"
          >
            {{ u }}
          </button>
        </div>
      </div>
      <p class="mt-1 text-xs text-faint">
        Existing exercises keep their own unit; numbers are never converted.
      </p>

      <div class="mt-3 grid grid-cols-2 gap-3">
        <div>
          <label class="text-xs text-faint" for="def-rbs">Rest between sets (s)</label>
          <input
            id="def-rbs"
            type="number"
            inputmode="numeric"
            min="0"
            :value="s.defaultRestBetweenSets"
            class="tnum mt-1 w-full rounded-xl border border-border bg-surface-2 px-3 py-2.5"
            @change="
              settingsStore.update({
                defaultRestBetweenSets: Math.max(
                  0,
                  Number.parseInt(($event.target as HTMLInputElement).value, 10) || 0,
                ),
              })
            "
          />
        </div>
        <div>
          <label class="text-xs text-faint" for="def-rae">Rest after exercise (s)</label>
          <input
            id="def-rae"
            type="number"
            inputmode="numeric"
            min="0"
            :value="s.defaultRestAfterExercise"
            class="tnum mt-1 w-full rounded-xl border border-border bg-surface-2 px-3 py-2.5"
            @change="
              settingsStore.update({
                defaultRestAfterExercise: Math.max(
                  0,
                  Number.parseInt(($event.target as HTMLInputElement).value, 10) || 0,
                ),
              })
            "
          />
        </div>
      </div>
    </section>

    <!-- Alerts -->
    <section class="mt-4 rounded-2xl border border-border bg-surface-1 p-4">
      <h2 class="text-xs font-semibold uppercase tracking-widest text-faint">Alerts</h2>

      <label class="mt-2 flex min-h-[44px] items-center justify-between">
        <span>Sound</span>
        <input
          type="checkbox"
          class="h-6 w-6 accent-[var(--c-accent)]"
          :checked="s.soundEnabled"
          @change="settingsStore.update({ soundEnabled: ($event.target as HTMLInputElement).checked })"
        />
      </label>
      <label class="flex min-h-[44px] items-center justify-between">
        <span>
          Vibration
          <span class="block text-xs text-faint">Not supported by iOS Safari</span>
        </span>
        <input
          type="checkbox"
          class="h-6 w-6 accent-[var(--c-accent)]"
          :checked="s.vibrationEnabled"
          @change="settingsStore.update({ vibrationEnabled: ($event.target as HTMLInputElement).checked })"
        />
      </label>
      <label class="flex min-h-[44px] items-center justify-between">
        <span>Keep screen awake during workouts</span>
        <input
          type="checkbox"
          class="h-6 w-6 accent-[var(--c-accent)]"
          :checked="s.keepScreenAwake"
          @change="settingsStore.update({ keepScreenAwake: ($event.target as HTMLInputElement).checked })"
        />
      </label>

      <label class="mt-2 block text-xs text-faint" for="beeps">
        Countdown beeps at (seconds before zero)
      </label>
      <input
        id="beeps"
        v-model="beepsText"
        type="text"
        inputmode="numeric"
        class="tnum mt-1 w-full rounded-xl border border-border bg-surface-2 px-3 py-2.5"
        @blur="commitBeeps"
        @keydown.enter="($event.target as HTMLInputElement).blur()"
      />
    </section>

    <!-- About / version -->
    <section class="mt-4 rounded-2xl border border-border bg-surface-1 p-4">
      <h2 class="text-xs font-semibold uppercase tracking-widest text-faint">About</h2>
      <div class="mt-3 flex items-baseline justify-between gap-3">
        <span class="text-sm text-muted">Version</span>
        <code
          class="tnum rounded-lg bg-surface-2 px-2 py-1 text-sm font-medium text-text"
          :title="versionFull"
        >
          {{ versionShort }}
        </code>
      </div>
      <p class="mt-1 text-xs text-faint">
        Build commit
        <span class="tnum break-all">{{ versionFull }}</span>
      </p>
      <button
        type="button"
        class="mt-3 min-h-[48px] w-full rounded-xl bg-surface-2 px-4 font-medium disabled:opacity-50"
        :disabled="updateChecking"
        @click="onCheckForUpdates"
      >
        {{ updateChecking ? 'Checking…' : 'Check for updates' }}
      </button>
      <p
        v-if="updateMessage"
        class="mt-2 text-sm"
        :class="updateIsError ? 'text-warn' : 'text-muted'"
        aria-live="polite"
      >
        {{ updateMessage }}
      </p>
    </section>

    <!-- Appearance -->
    <section class="mt-4 rounded-2xl border border-border bg-surface-1 p-4">
      <h2 class="text-xs font-semibold uppercase tracking-widest text-faint">Appearance</h2>
      <div class="mt-3 flex gap-1" role="radiogroup" aria-label="Theme">
        <button
          v-for="t in ['dark', 'light', 'system'] as const"
          :key="t"
          type="button"
          role="radio"
          :aria-checked="s.theme === t"
          class="min-h-[44px] flex-1 rounded-xl text-sm font-semibold capitalize"
          :class="s.theme === t ? 'bg-accent text-accent-ink' : 'bg-surface-2 text-muted'"
          @click="settingsStore.update({ theme: t })"
        >
          {{ t }}
        </button>
      </div>
    </section>

    <!-- Data -->
    <section class="mt-4 rounded-2xl border border-border bg-surface-1 p-4">
      <h2 class="text-xs font-semibold uppercase tracking-widest text-faint">Your data</h2>
      <p class="mt-2 text-sm text-muted">
        Everything is stored on this device, in this browser. Clearing site
        data — by you or by the browser under storage pressure — deletes it.
        Exports are the only backup.
      </p>
      <p class="tnum mt-2 text-xs text-faint">
        <template v-if="usage">Storage used: {{ formatBytes(usage.usage) }} of {{ formatBytes(usage.quota) }}.</template>
        <template v-if="lastExportAt">
          Last export: {{ new Date(lastExportAt).toLocaleDateString() }}.
        </template>
        <template v-else>Never exported.</template>
      </p>

      <div class="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <button
          type="button"
          class="min-h-[48px] rounded-xl bg-surface-2 px-4 font-medium"
          @click="doExport('workouts')"
        >
          Export workouts
        </button>
        <button
          type="button"
          class="min-h-[48px] rounded-xl bg-surface-2 px-4 font-medium"
          @click="doExport('backup')"
        >
          Export full backup
        </button>
      </div>

      <button
        type="button"
        class="mt-2 min-h-[48px] w-full rounded-xl bg-surface-2 px-4 font-medium"
        @click="fileInput?.click()"
      >
        Import from file
      </button>
      <input
        ref="fileInput"
        type="file"
        accept="application/json,.json"
        class="hidden"
        @change="onFilePicked"
      />

      <div
        v-if="importErrors.length > 0"
        class="mt-3 rounded-xl border border-danger/60 bg-surface-2 p-3 text-sm"
        role="alert"
      >
        <p class="font-semibold text-danger">Import rejected — nothing was changed:</p>
        <ul class="mt-1 list-inside list-disc text-muted">
          <li v-for="(problem, i) in importErrors.slice(0, 8)" :key="i">{{ problem }}</li>
          <li v-if="importErrors.length > 8">…and {{ importErrors.length - 8 }} more.</li>
        </ul>
      </div>
      <p v-if="importSuccess" class="mt-3 text-sm font-medium text-work" aria-live="polite">
        {{ importSuccess }}
      </p>
    </section>

    <!-- Danger zone -->
    <section class="mt-4 rounded-2xl border border-danger/40 bg-surface-1 p-4">
      <h2 class="text-xs font-semibold uppercase tracking-widest text-danger">Danger zone</h2>
      <button
        type="button"
        class="mt-3 min-h-[48px] w-full rounded-xl border border-danger/60 font-semibold text-danger"
        @click="eraseOpen = true"
      >
        Erase all data
      </button>
    </section>

    <!-- Merge / Replace / Cancel on ID collision -->
    <Teleport to="body">
      <div
        v-if="collisionOpen"
        class="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-4 sm:items-center"
        role="dialog"
        aria-modal="true"
        aria-label="Items already exist"
        @click.self="cancelImport"
        @keydown.escape="cancelImport"
      >
        <div class="w-full max-w-sm rounded-2xl border border-border bg-surface-1 p-5 shadow-xl">
          <h2 class="text-lg font-semibold">Items already exist</h2>
          <p class="mt-2 whitespace-pre-line text-sm text-muted">{{ collisionSummary }}</p>
          <div class="mt-5 flex flex-col gap-2">
            <button
              type="button"
              class="min-h-[48px] rounded-xl bg-accent font-semibold text-accent-ink"
              @click="pendingImport && applyImport(pendingImport, 'merge')"
            >
              Merge (keep both)
            </button>
            <button
              type="button"
              class="min-h-[48px] rounded-xl border border-danger/60 font-semibold text-danger"
              @click="pendingImport && applyImport(pendingImport, 'replace')"
            >
              Replace existing
            </button>
            <button
              type="button"
              class="min-h-[48px] rounded-xl bg-surface-2 font-medium text-muted"
              @click="cancelImport"
            >
              Cancel import
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <ConfirmDialog
      :open="eraseOpen"
      title="Erase all data?"
      message="Every workout, session and setting on this device will be deleted. This cannot be undone. Consider exporting a backup first."
      confirm-label="Erase all data"
      danger
      typed-confirmation="ERASE"
      @confirm="eraseAll"
      @cancel="eraseOpen = false"
    />
  </main>
</template>

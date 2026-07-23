# Workout Timer

A single-user workout timer that runs entirely in the browser, installs to a
phone home screen, and works with the network switched off. No backend, no
accounts, no telemetry — all data stays on the device, with JSON export/import
as the backup and transfer mechanism.

## Setup

Requires Node 20+.

```sh
npm install
npm run dev        # dev server
npm test           # unit tests (state machine, timer engine, import/export, stats)
npm run build      # type-check (vue-tsc) + production build with service worker
npm run preview    # serve the built bundle locally
```

Optional verification aids (not part of the shipped app):

```sh
npm run icons             # regenerate public/icons/*.png from scripts/icon.svg
node scripts/smoke.mjs    # headless end-to-end smoke test against `npm run preview`
```

## Installing on a phone

Serve the `dist/` folder over HTTPS (or use `npm run preview` on a LAN).

- **iOS Safari:** Share → *Add to Home Screen*. Launches standalone with the
  bundled icon.
- **Android Chrome/Edge:** the browser offers *Install app* / *Add to Home
  screen* automatically once the service worker is active.

After the first load the app is fully precached; it makes **zero** runtime
network requests (fonts, icons, and all assets are bundled locally).

## Architecture

```
src/
  types.ts               Data model (Workout, Exercise, Session, SetLog, Settings)
  lib/
    persistence.ts       The single IndexedDB/localStorage gateway; schemaVersion + migrations
    importExport.ts      Export file building; strict, path-specific import validation
    validation.ts        Workout/exercise form validation
    stats.ts             Volume, streaks, per-exercise progression
    audio.ts             Web Audio tone synthesis (no audio files)
    haptics.ts           navigator.vibrate wrapper (feature-detected)
    wakeLock.ts          Screen wake lock with visibilitychange re-acquire
    time.ts, id.ts, seed.ts
  stores/
    player.ts            THE CORE: headless finite state machine + timer engine
    workouts.ts          Workout CRUD, ordering, duplication
    sessions.ts          Session history
    settings.ts          Settings in localStorage; theme application
  views/                 One file per screen (Today, Editor, Player, History, Detail, Settings)
  components/            ProgressRing, RepStepper, ConfirmDialog, SparkLine, TabBar
test/                    Vitest suites driven with an explicit mocked clock
```

### The player state machine

`stores/player.ts` is a headless Pinia store — the player screen only renders
store state and dispatches actions. States:
`idle → exercise_intro → set_active → rest_set/rest_exercise → … → complete`,
with `paused` as an overlay and `abandoned` as the terminal stop state.

Timing rules:

- Countdowns store an absolute `endsAt` epoch; elapsed timers store
  `startedAt`. Nothing counts interval ticks; `tick(now)` derives everything
  from the wall clock, so throttled/backgrounded tabs reconcile exactly.
- `tick` walks through *all* expired boundaries in order (rest end → intro
  end → active set), anchoring each successor timer at the previous boundary.
- A finished set becomes `pending` while its rest runs; the rep count commits
  when the rest ends, or earlier via **Done**. Rep entry never blocks the
  rest countdown.
- Every transition persists the full player state to IndexedDB, so a crash,
  refresh, or killed tab resumes exactly (including remaining rest).

### Persistence

- **IndexedDB** (`workout-timer` database, via `idb-keyval`): workouts, one
  key per session, and the in-progress player state.
- **localStorage**: settings and trivial UI preferences only — never history.
- All writes go through `lib/persistence.ts`, which stamps a `schemaVersion`
  and holds the migration chain.

### Design tokens

`src/style.css` defines semantic CSS custom properties per theme (dark-first,
`.light` override) and maps them into Tailwind v4 via `@theme inline`. Color
encodes player state: green = work, blue = rest, violet = transition, amber =
warnings/skips; everything outside the player stays near-monochrome with one
accent.

## Platform limitations

- **iOS cannot vibrate**: `navigator.vibrate` does not exist in iOS Safari.
  Haptics degrade silently; audio cues are unaffected.
- **iOS suppresses Web Audio while the screen is locked.** The player shows a
  one-time note recommending keeping the screen on; the wake-lock setting
  (default on) does that automatically while a workout runs.
- **The browser owns the storage.** IndexedDB can be evicted under storage
  pressure or by clearing site data. Settings surfaces this, shows the last
  export date, and nags when it is more than two weeks old.
- **Lighthouse no longer has a PWA category** (removed in v12). Accessibility
  scores 100 on all audited screens; installability (manifest, icons, active
  service worker, offline reload) is verified by the smoke test instead.

See `DECISIONS.md` for every judgment call made against the spec.

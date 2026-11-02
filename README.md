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

`stores/player.ts` is a headless Pinia store. The player screen only renders
store state and dispatches actions. States:
`set_active → rest → awaiting_set (alarm) → set_active → … → complete`,
plus `ready` (a set is queued after a skip, jump or back: no timer, no alarm).

- **The cursor is the set on screen.** During rest it is the upcoming set,
  so "Skip set 2" means exactly what it says.
- **Navigation never deletes data.** Back, Jump (tap any set in the plan) and
  Skip only move the cursor or log skipped sets. A logged set keeps its log
  until it is completed again.
- **After each set the player goes to the next set with no log**, wrapping to
  earlier gaps, so jumping ahead never strands earlier sets.
- **Rest logs the set just finished:** reps, the weight used, and reps left in
  the tank. A weight change carries to the remaining sets of that exercise.
- Countdowns store an absolute `endsAt`; elapsed timers store `startedAt`.
  `tick(now)` derives everything from the wall clock, so throttled or
  backgrounded pages reconcile exactly.
- Every transition persists the full player state to IndexedDB, so a crash,
  refresh, or killed tab resumes exactly (including remaining rest).

### Background timing and sound

`lib/playerRuntime.ts` runs for the whole app, not just the player screen:

- A 200 ms interval drives `tick()`. requestAnimationFrame stops in hidden
  pages, but intervals keep running.
- Sounds are placed ahead of time on the Web Audio clock (`lib/cuePlan.ts`
  decides which), up to two minutes past the end of rest. The audio clock keeps
  running when JavaScript is throttled, so the countdown and alarm play on time
  when the app is in the background or the window is covered.
- While a workout runs, an inaudible 30 Hz tone keeps the page counted as
  "playing audio", which stops Chrome from throttling or freezing it
  (Settings → *Keep alerts working in the background*).
- Any tap revives an audio context the browser suspended.

### Tracking

`lib/stats.ts` provides last-time performance, estimated one-rep max (Epley),
personal-record detection, plateau detection, and `progressionAdvice`.

Progression is double progression. Each exercise has a rep range (bottom
`targetReps`, optional top `repsMax`), an optional `weightStep`, and an
optional `pairedDumbbells` flag (the weight is the total of two dumbbells,
so the default step doubles). When every set reaches the top of the range,
the app suggests one step up and the goal returns to the bottom. A set
logged with 0 reps left in the tank delays that by one session.

Bodyweight exercises (pull-ups, push-ups, dips) set `bodyweightShare`, the
share of bodyweight the movement moves (pull-up 1, push-up 0.65). On these
exercises `weight` is added weight, and a negative weight is band or machine
assistance. With a bodyweight set in Settings, each logged set stores its
bodyweight part as `bodyLoad`, and the total load (`bodyLoad + weight`)
drives the estimated one-rep max, records, volume and charts. So assisted,
bodyweight-only and weighted sessions sit on one trend line. Sets logged
before that get their bodyweight part from the current bodyweight at read
time (`sessions.forStats`). Stored history is never rewritten.

The player shows last time's numbers, the current goal, and a plateau
notice. The summary flags records, lets you correct any set, and offers to
update the plan's weight. History links each exercise to a trend page
(`/history/exercise/:name`).

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
- **iOS suppresses Web Audio while the screen is locked or the app is in the
  background.** Scheduled sound and the keep-alive tone cannot change that.
  The wake-lock setting (default on) keeps the screen on while a workout runs.
  Android and desktop browsers keep playing alerts in the background.
- **The browser owns the storage.** IndexedDB can be evicted under storage
  pressure or by clearing site data. Settings surfaces this, shows the last
  export date, and nags when it is more than two weeks old.
- **Lighthouse no longer has a PWA category** (removed in v12). Accessibility
  scores 100 on all audited screens; installability (manifest, icons, active
  service worker, offline reload) is verified by the smoke test instead.

See `DECISIONS.md` for every judgment call made against the spec.

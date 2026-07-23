# Decisions

Judgment calls made where the spec left room, in roughly the order they came
up. Section references are to the build prompt (`plan.md`).

## Stack and tooling

- **Tailwind CSS v4 via `@tailwindcss/vite` worked without issues** — no
  fallback to v3 was needed.
- **TypeScript is pinned to 5.9.** npm resolved "latest" to TypeScript 7 (the
  native compiler preview), which `vue-tsc` cannot drive yet
  (`ERR_PACKAGE_PATH_NOT_EXPORTED`). 5.9 is the newest release vue-tsc
  supports; strict mode is on.
- **Production dependencies (5 of the allowed 10):** `vue`, `vue-router`,
  `pinia`, `idb-keyval`, `@fontsource-variable/inter`. The font package exists
  only to bundle Inter locally (no CDN); it ships no JS.
- **Dev-only extras:** `sharp` renders the PNG icons from `scripts/icon.svg`
  once (`npm run icons`; outputs are committed), and `playwright` powers
  `scripts/smoke.mjs`, a headless end-to-end verification of the built bundle.
  Neither ships to the browser.
- **No drag-and-drop.** Exercises and workouts reorder with ▲/▼ buttons
  (44 px targets), which the spec explicitly allows; they work identically
  with touch, mouse, and keyboard, with none of the pointer-capture pitfalls
  of hand-rolled drag on iOS.

## Data model and persistence

- **Sessions are stored one IndexedDB key per session** (`session:<uuid>`),
  so an ever-growing history never rewrites one giant blob. Workouts are one
  array under a single key — they are few and edited as a set.
- **`localStorage` keys:** settings, last-export date, the dismissed flag for
  the "keep screen on" note, and a "seeded" flag. Nothing else.
- **First run seeds one sample workout** (marked Optional, unscheduled) so the
  Today screen demonstrates the row anatomy instead of opening empty. It is
  seeded only once; deleting it does not bring it back.
- **Reading data written by a future schema version is left untouched** at
  boot (no down-migration guessing); *importing* a future-version file is
  refused with a clear message per §11.13.

## Player semantics

- **Cursor convention:** `(exerciseIndex, setIndex)` always points at the set
  being performed or *prepared*. When a set finishes, the cursor advances
  immediately and the finished set becomes `pending` while its rest runs.
  This makes the transport buttons unambiguous during rest: *Previous set*
  re-enters the set you just finished; *Skip set* skips the upcoming one.
- **Skip set runs the skipped set's rest** ("advance as if completed", §6
  verbatim). The rep stepper still shows during that rest pre-filled with 0,
  so a mis-tap is recoverable by dialing the real rep count back in.
- **A committed rep count of 0 records the set as `skipped`** — outcome
  follows the data (0 reps = no work done), regardless of which button got
  the user there.
- **Skip exercise goes straight to the next exercise's intro** with no
  `restAfterExercise` (you didn't do the work, you don't need its rest).
  §6 says "advance to the next exercise's rest/intro"; intro was chosen.
- **Previous exercise enters the target exercise's intro** (5 s to get set
  up) rather than dropping straight into `set_active`. It is disabled at
  exercise 0, mirroring the previous-set rule at (0, 0).
- **Transport actions while paused auto-resume first**, then apply. The tray
  stays available in every non-terminal state as specified, and this avoids
  a "frozen but mutated" state.
- **The final set of the workout has no rest, so no stepper screen.** Its
  reps auto-commit at target, and the completion summary shows a stepper to
  adjust the final set's count before *Save & finish*. This is the only place
  reps are editable after commit; rewinding out of `complete` stays
  unsupported per §6.
- **Simple rest loop.** Set complete → log reps during rest → ticks at 3, 2, 1
  → alarm at 0 (`awaiting_set`) until the user taps **Stop alarm**, which
  starts the next set. Same between exercises. No Done button; rest never
  auto-starts work. (Overrides plan §6.)
- **The start sheet's "Start workout" tap is the audio-unlocking gesture and
  starts the player directly.** The player's `idle` pre-flight state (with
  its own Start button, also unlocking audio) appears only when navigating to
  `/play/:id` directly. Requiring two Start taps in the normal flow served
  nobody.
- **Elapsed-time ring sweeps once per minute** during `set_active`. Work time
  has no known endpoint, so the ring communicates motion, not progress;
  countdown rests drain the ring, exactly as specified.
- **Paused rest counts toward `restSeconds`.** If you pause during rest you
  are still resting; the log records wall-clock rest actually taken. Pausing
  during a *set* excludes the paused span from `workSeconds` (the timer is
  frozen).
- **Catch-up transitions older than ~1.5 s fire no audio cues.** Returning
  from a long background gap replays the machine silently instead of a stack
  of stale beeps (the AudioContext was suspended anyway).
- **`durationSeconds` is wall time** from start to end; "active time" on the
  detail screen is Σ `workSeconds`. Pauses therefore show up as the gap
  between duration and active+rest, which matches intuition about "how long
  was I at the gym".
- **Abandoning with zero completed sets still saves the session** — §6 calls
  abandoned "partial session saved" without a floor, and a visible abandoned
  row is more honest than silently discarding the attempt.

## Screens

- **Tab bar has three tabs** (Today, History, Settings). §5 says "bottom tab
  bar for the first four" screens, but the editor is per-workout
  (`/workouts/:id/edit`) and unreachable as a bare tab; it keeps the tab bar
  visible and lives under Today. New workouts use the `id = "new"` route.
- **Day groups on Today are all expanded by default**; today's group is
  pinned first and always expanded, other groups can be collapsed. (Original
  collapsed-by-default hid workouts on first run.) Empty non-today days are
  hidden entirely; an empty *today* shows guidance text.
- **Starting a workout while another session is resumable asks first**
  ("Discard unfinished session?") — never silently clobbers an in-progress
  session.
- **Session detail is a sub-route of History** (`/history/:id`), keeping the
  five top-level screens as specified.
- **Editing a workout that is currently playing** is blocked by a router
  guard (redirects to the player); the player itself contains no edit links.
  Editing a *different* workout mid-session is allowed.
- **History progression is keyed by exercise name** (case-insensitive), not
  exercise id, so progress survives deleting and recreating a workout.
  Mixed-unit history for one name reports in the most recently used unit.
- **Volume with mixed units is shown per unit** ("1,600 lb + 400 kg") —
  never converted, consistent with §11.12's "never silently convert".
- **Streak weeks are Sunday-based calendar weeks** (the app's day picker is
  Sunday-first). The current streak survives a week in progress with no
  workout yet; abandoned sessions and optional workouts never count.

## Import / export

- **Merge regenerates ids only for colliding items** and appends
  "(imported)" to collided workout names so both copies are tellable apart.
  Imported workouts are appended after existing ones in order.
- **Replace overwrites items with matching ids and adds the rest** — a
  superset of the file, never a wipe of unrelated local data.
- **The collision prompt is a three-way choice** (Merge / Replace / Cancel);
  Escape and backdrop-click cancel the import rather than picking a side.
- **Importing a backup with settings applies those settings.** Restoring a
  full backup means restoring the app, not just its lists.
- **Import success/failure messaging is inline in Settings**, listing up to
  8 specific problems (path + expectation) on rejection; nothing is applied
  on any validation failure.

## Design

- **Type: Inter Variable** with `font-variant-numeric: tabular-nums` on every
  numeric readout (`.tnum`), tight tracking on the big countdown only.
- **State hues:** work `#3DDC84`, rest `#38BDF8`, transition `#A78BFA`,
  warnings/skips amber, one blue accent outside the player. Light theme uses
  darker variants of the same hues; all text combinations were verified at
  ≥ 4.5:1 (see below).
- **Optional workouts are de-emphasized via a muted title and softer border**,
  not whole-card opacity — an earlier opacity approach pushed the badge text
  below WCAG contrast and failed the Lighthouse audit.
- **Screen transitions are a 120 ms crossfade**; the progress ring animates
  at 120 ms linear; `prefers-reduced-motion` disables all of it globally.

## Verification notes

- Lighthouse v12 has **no PWA category anymore**, so §13's "Lighthouse PWA
  95+" cannot be produced literally. Substituted: accessibility 100 on
  Today, History, and Settings, plus scripted verification (service worker
  active, manifest present, app reloads and functions fully offline).
- The acceptance items that need physical devices (iOS home-screen install,
  iOS audio-after-Start behavior) were implemented to spec (touch icons,
  standalone meta, AudioContext unlock on the Start gesture, `resume()` on
  `visibilitychange`) but could not be executed on real hardware here.

## Out of scope (deliberately)

- No File System Access API, no background sync, no share targets.
- No exercise database, plate calculators, or rest suggestions — §14.
- Sessions are never editable after saving (except the final-set rep count
  on the completion screen, before saving).

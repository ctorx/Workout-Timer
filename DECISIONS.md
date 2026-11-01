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

- **Cursor convention (revised):** `(exerciseIndex, setIndex)` is always
  the set shown on screen. When a set finishes, the cursor moves to the next
  set with no log and the finished set becomes `pending` while its rest
  runs. Every control is labeled with the set it acts on ("Skip set 2",
  "Redo set 1"), which removed the old ambiguity of icon-only buttons.
- **Skip lands in a `ready` state**, not "paused at 0:00". `ready` has no
  timer and no alarm, and the main button reads "Start set N". The old
  paused-at-zero state looked frozen behind a dimmed overlay.
- **Back, Jump and Skip never delete logs.** The original Previous set and
  Previous exercise discarded every log at or after the target, so a
  mis-tap lost real data. Now a logged set keeps its log until it is
  completed again, and the logger starts from the old values when redoing.
- **The next set is the next one without a log, wrapping around.** Jumping
  ahead and coming back works without manual bookkeeping. The workout
  completes when every set has a log (completed or skipped).
- **Rest has an explicit "End rest · start set N" button.** The earlier
  "Done" button was removed because it was ambiguous. A label that names
  both effects is not, and starting early is a normal need.
- **Rest logs weight and effort, not just reps.** Weight per set was already
  in the data model but could not be changed. A weight change carries to
  the rest of that exercise in this session only. The summary offers to
  save it to the plan. Effort is "reps left in the tank" (0 to 4+), stored
  as optional `rir` on `SetLog`, so older data and backups stay valid.
- **The summary screen can correct any set**, not only the final one.
  Sessions remain read-only after saving.
- **Personal records compare against earlier sessions only** (estimated
  one-rep max for weighted sets, reps for bodyweight). A first-ever
  session shows no records.
- **Progression is double progression over a rep range.** Each exercise
  has a range: `targetReps` is the bottom and the optional `repsMax` is the
  top. An empty top means a single target, which behaves like a range of
  one. Work up through the range at one weight. When every planned set
  reaches the top, the app suggests one weight step and the goal returns to
  the bottom of the range. The range itself never changes, so "resetting
  to the bottom" needs no stored state.
- **A set taken to failure delays the weight increase.** If every set hit
  the top but any set was logged with 0 reps left in the tank, the advice
  is to repeat the weight once. Sets with no effort logged count as not to
  failure, so the rule still works when effort is not logged.
- **The weight step belongs to the exercise.** An exercise can set its own
  `weightStep`. Otherwise it uses the Settings step for its unit, doubled
  when `pairedDumbbells` is set, because the stored weight is the total of
  two dumbbells (120 lb = two 60s) and the next real option is two 65s.
  Paired weights display as "120 lb (2 × 60)".
- **A plateau is three sessions without a new best**, measured by the
  estimated one-rep max (or most reps for bodyweight), and needs at least
  four sessions of history. The app only points it out. It never changes
  the plan.
- **Advice is a suggestion.** Nothing changes the plan without a tap on
  "Update plan". Advice that has already been applied (the plan weight is
  already at the suggested weight) turns into "New weight today".
- **Transport actions while paused auto-resume first**, then apply. The tray
  stays available in every non-terminal state as specified, and this avoids
  a "frozen but mutated" state.
- **The final set of the workout has no rest, so no logger during rest.**
  Its reps commit at target and the completion summary lets you correct it,
  along with any other set, before *Save & finish*.
- **Simple rest loop.** Finish set → log the set during rest → countdown
  ticks (Settings → countdown beeps, which the player previously ignored) →
  alarm at 0 (`awaiting_set`) until the user taps **Start set N**. Same
  between exercises. Rest never auto-starts work. (Overrides plan §6.)
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
- **Sound is scheduled, not fired from the clock.** The player computes the
  upcoming cues from its state and places them on the Web Audio timeline up
  to two minutes ahead. This is what makes alerts work while the page is in
  the background. Cues more than 300 ms late are dropped instead of played
  stale. Vibration still follows the clock, since it cannot be scheduled.
- **An inaudible keep-alive tone runs during workouts** (30 Hz at about
  -56 dB, toggle in Settings) so Chrome treats the page as playing audio and
  does not throttle or freeze it. iOS ignores this and still suspends web
  audio when locked.
- **The player clock and cues live in `lib/playerRuntime.ts`**, started once
  at boot. Before, they lived in the player screen and stopped whenever that
  screen was not mounted or the page was hidden.
- **`durationSeconds` is wall time** from start to end; "active time" on the
  detail screen is Σ `workSeconds`. Pauses therefore show up as the gap
  between duration and active+rest, which matches intuition about "how long
  was I at the gym".
- **Abandoning with zero completed sets still saves the session** — §6 calls
  abandoned "partial session saved" without a floor, and a visible abandoned
  row is more honest than silently discarding the attempt.

## Screens

- **On screens 768 px and wider the tab bar becomes a left rail**, and the
  player shows the workout plan beside the timer from 1024 px. Space or Enter
  runs the main player button on desktop.
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
- Sessions are never editable after saving. Any set can be corrected on the
  completion screen before saving.

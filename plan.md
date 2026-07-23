# Build Prompt: Offline Workout Timer PWA

You are building a complete, production-quality workout timer web app. Read this entire spec before writing code. Where a detail is unspecified, pick the simplest option that satisfies the acceptance criteria, and record the choice in a `DECISIONS.md` at the repo root. Do not ask me questions before starting unless something here is genuinely contradictory.

---

## 1. Objective

A single-user workout timer that runs entirely in the browser, installs to a phone home screen, and works with the network switched off. I use it in a gym: it must be readable at arm's length, operable one-handed with sweaty fingers, and it must never lose my logged sets.

---

## 2. Hard constraints

- **No backend.** No server, no API, no auth, no cloud sync, no telemetry, no analytics.
- **Fully offline after first load.** No runtime network requests of any kind. Bundle all fonts, icons, and assets locally — no Google Fonts, no CDN links, no remote SVG sprites.
- **Installable PWA** with a valid manifest, service worker precache, and iOS-compatible icons/meta.
- **All data stays on device**, with explicit user-driven JSON export/import as the backup and transfer mechanism.
- Must work in mobile Safari (iOS 16+) and Chrome/Edge on Android and desktop. Mobile portrait is the primary target; desktop must be usable, not an afterthought.

---

## 3. Tech stack

- **Vue 3** with `<script setup>` and **TypeScript** (strict mode).
- **Vite** as the build tool.
- **Tailwind CSS v4** via `@tailwindcss/vite` (fall back to v3 + PostCSS if you hit tooling problems; note it in `DECISIONS.md`).
- **Pinia** for state, **vue-router** for screens.
- **`vite-plugin-pwa`** for manifest + service worker (`registerType: 'autoUpdate'`, precache all build assets).
- **`idb-keyval`** or a thin hand-rolled IndexedDB wrapper for persistence. No ORM.
- **Vitest** for unit tests.
- **No UI component library, no chart library, no drag-and-drop library** unless you can justify it in `DECISIONS.md`. Native HTML5 drag events plus pointer events for touch, or simple up/down reorder buttons that also work on touch, are acceptable.

Keep total production dependencies under ten packages.

---

## 4. Data model

Use these types verbatim as the source of truth.

```ts
type UUID = string;
type Unit = 'lb' | 'kg';

interface Exercise {
  id: UUID;
  name: string;
  weight: number;             // >= 0; 0 means bodyweight
  unit: Unit;
  sets: number;               // >= 1
  targetReps: number;         // >= 1
  restBetweenSets: number;    // seconds, >= 0
  restAfterExercise: number;  // seconds, >= 0; ignored when this is the last exercise
  notes?: string;
}

interface Workout {
  id: UUID;
  name: string;
  dayOfWeek: 0 | 1 | 2 | 3 | 4 | 5 | 6 | null;  // 0 = Sunday; null = unscheduled
  optional: boolean;
  order: number;              // sort order among workouts
  exercises: Exercise[];      // array index IS the exercise order
  createdAt: string;          // ISO 8601
  updatedAt: string;          // ISO 8601
}
```

### Resolving the "rest" ambiguity

There are exactly **two** rest values, both owned by the exercise:

1. `restBetweenSets` — runs after every set of that exercise **except the last**.
2. `restAfterExercise` — runs after the **last** set of that exercise, before advancing to the next exercise. Skipped entirely when it is the final exercise of the workout.

Do not model rests as separate list items between exercises. This keeps reordering trivial and makes "individually configurable" true.

### Session logging types

```ts
type SetOutcome = 'completed' | 'skipped';

interface SetLog {
  setIndex: number;        // 0-based within the exercise
  targetReps: number;
  actualReps: number;      // 0 when skipped
  weight: number;
  unit: Unit;
  outcome: SetOutcome;
  startedAt: string;
  completedAt: string;
  workSeconds: number;     // measured active time for the set
  restSeconds: number;     // actual rest taken after this set
}

interface ExerciseLog {
  exerciseId: UUID;
  name: string;            // denormalized snapshot at session time
  targetSets: number;
  sets: SetLog[];
  outcome: 'completed' | 'partial' | 'skipped';
}

interface Session {
  id: UUID;
  workoutId: UUID;
  workoutName: string;     // denormalized snapshot
  startedAt: string;
  endedAt: string | null;
  status: 'in_progress' | 'completed' | 'abandoned';
  exercises: ExerciseLog[];
  durationSeconds: number;
  totalRestSeconds: number;
}

interface Settings {
  defaultUnit: Unit;
  defaultRestBetweenSets: number;
  defaultRestAfterExercise: number;
  soundEnabled: boolean;
  vibrationEnabled: boolean;
  keepScreenAwake: boolean;
  countdownBeepsAt: number[];   // default [3, 2, 1]
  theme: 'dark' | 'light' | 'system';
}
```

Sessions denormalize workout and exercise names on purpose: deleting a workout must never corrupt or erase past history.

---

## 5. Screens

Five routes. Bottom tab bar on mobile for the first four; the player takes over the full screen.

1. **`/` — Today / Week.** Workouts grouped by assigned day, Sunday→Saturday, unscheduled at the bottom. Today's group is visually pinned and expanded. Optional workouts carry a clear "Optional" badge and are visually de-emphasized. Each row shows name, exercise count, estimated duration, and last-completed date. Tapping a row opens a start sheet; a single large primary action starts the workout. If a session is `in_progress` in storage, show a "Resume workout" banner above everything.
2. **`/workouts/:id/edit` — Workout editor.** Name, day-of-week picker (including "Unscheduled"), optional toggle, and the exercise list. Per exercise: name, weight + unit, sets, target reps, rest between sets, rest after exercise, notes. Reorder exercises via drag or up/down controls. Duplicate and delete an exercise. Duplicate and delete the workout. Inline validation with clear messages; never let invalid data reach storage. Also reorder whole workouts from the Today screen (drag or an explicit "Reorder" mode).
3. **`/play/:workoutId` — Player.** See §6. No editing allowed here.
4. **`/history` — History and stats.** See §8.
5. **`/settings` — Settings.** All `Settings` fields, plus export/import, storage usage, and "Erase all data" behind a typed confirmation.

---

## 6. Player: the state machine

This is the core of the app. Implement it as a **headless Pinia store with an explicit finite state machine**, fully unit-testable without any DOM. The player component only renders store state and dispatches actions.

### States

| State | Timer | Primary action | Notes |
|---|---|---|---|
| `idle` | — | Start workout | Pre-flight; unlocks audio on the tap |
| `exercise_intro` | 5s countdown down | Skip | Shows exercise name, weight, sets × reps. Auto-advances to `set_active` |
| `set_active` | elapsed, counts **up** | **Set complete** | No countdown. The app is quiet while I lift |
| `rest_set` | countdown down | Done | Rest after a non-final set. Rep entry lives here |
| `rest_exercise` | countdown down | Done | Rest after the final set. Previews the next exercise |
| `paused` | frozen | Resume | Overlay over any timed state; remembers the exact remaining ms |
| `complete` | — | Save & finish | Session summary |
| `abandoned` | — | — | Terminal; partial session saved |

### Transitions

- `idle` → `exercise_intro` (exercise 0, set 0)
- `exercise_intro` → `set_active` on countdown end or Skip
- `set_active` → **Set complete** tapped:
  - if this is **not** the last set of the exercise → `rest_set`, countdown = `restBetweenSets`
  - if this **is** the last set and there **is** a next exercise → `rest_exercise`, countdown = `restAfterExercise`
  - if this **is** the last set of the **last** exercise → `complete`
- `rest_set` → `set_active` (next set) on countdown reaching 0 or Skip rest
- `rest_exercise` → `exercise_intro` (next exercise, set 0) on countdown reaching 0 or Skip rest
- `restBetweenSets` or `restAfterExercise` equal to 0 → pass straight through without rendering a rest screen
- Any timed state ↔ `paused` via the pause control
- Any state → `abandoned` via Stop (confirmation dialog: "End workout? Your completed sets will be saved.")

### Rep logging — important UX detail

Tapping **Set complete** starts the rest countdown *immediately* and, on the same screen, shows a rep stepper for the set just finished:

- Pre-filled with the exercise's `targetReps`.
- Large `−` and `+` buttons, minimum 56 px tap targets, on either side of the number. Long-press to repeat. Tapping the number opens a numeric keypad input.
- **Done** commits the log early and skips the remaining rest.
- If I never touch the stepper, the displayed value auto-commits when the rest countdown hits 0.

Rest time is precious; never make me finish data entry before the clock starts.

### Transport controls

A control tray with four transport buttons plus pause and stop, available in every non-terminal state:

- ⏮ **Previous exercise** — jump to set 0 of the previous exercise
- ◀ **Previous set** — re-enter the previous set of the current exercise; at set 0, behaves as Previous exercise; at exercise 0 set 0, disabled
- ▶ **Skip set** — log the current set as `skipped` with `actualReps: 0`, advance as if completed
- ⏭ **Skip exercise** — log all remaining sets of this exercise as `skipped`, advance to the next exercise's rest/intro

Rewinding **discards** the log entries for the steps being re-entered so they can be re-recorded. Rewinding out of `complete` is not supported.

### Player UI requirements

- The current countdown or elapsed time is the largest element on screen — target roughly 20–25% of viewport height, tabular numerals, `mm:ss`.
- A circular or linear progress ring around the timer, filling for elapsed time and draining for countdowns.
- Persistent context, always visible without scrolling: exercise name, weight and unit, "Set 2 of 4", "Exercise 3 of 7", and a thin overall workout progress bar.
- The primary action is a single full-width button anchored to the bottom, at least 64 px tall, inside `env(safe-area-inset-bottom)`, reachable with a thumb.
- During rest: **+30s** and **−15s** buttons that adjust the current countdown only.
- Distinct, unmistakable color state for work vs. rest vs. transition (see §10).

---

## 7. Timer engine, audio, and screen wake

### Timer engine (get this right)

- **Never accumulate elapsed time by counting `setInterval` ticks.** Store an absolute `endsAtEpochMs` (countdowns) or `startedAtEpochMs` (elapsed), and derive remaining/elapsed from `Date.now()` on every frame.
- Drive display updates with `requestAnimationFrame`, or `setInterval` at 100 ms, purely for rendering.
- Pausing stores `remainingMs`; resuming recomputes `endsAtEpochMs = Date.now() + remainingMs`.
- Background tabs throttle timers. Recompute and reconcile on `visibilitychange` and on `focus`. If a countdown expired while backgrounded, fire its completion transition immediately on return, and if multiple boundaries were crossed, advance through them correctly rather than losing state.
- Persist the active session and full player state to IndexedDB on every state transition and at least every 5 seconds, so a crash, refresh, or accidental app switch can be resumed exactly.

Write unit tests for the engine with a mocked clock: pause/resume accuracy, zero-length rests, backgrounded expiry, and multi-boundary catch-up.

### Audio

- Web Audio API only — synthesize tones with `OscillatorNode` + `GainNode`. No audio files.
- Create the `AudioContext` on the first user gesture (the Start button) and never close it. Call `resume()` on `visibilitychange` since iOS suspends it.
- Apply a short attack/release envelope on every tone so there are no clicks.
- Cues: a short high blip at each second in `countdownBeepsAt` (default 3, 2, 1); a longer, lower "go" tone at 0; a distinct two-tone cue when advancing to a new exercise; a three-note ascending motif on workout complete. Make all cues clearly distinguishable with the phone in a pocket.

### Haptics and wake lock

- Vibrate alongside audio cues via `navigator.vibrate` where supported. Feature-detect; iOS Safari does not support it — degrade silently, and never gate a cue on vibration succeeding.
- Request `navigator.wakeLock.request('screen')` when a workout starts; release it when the workout ends or is abandoned; re-acquire on `visibilitychange` when the document becomes visible. Feature-detect and degrade silently.
- Because iOS may suppress Web Audio when the screen is locked, show a one-time, dismissible note on the player: keep the screen on for reliable alerts.

---

## 8. History and stats

`/history` has two levels:

**Session list** — reverse chronological, grouped by month. Each row: date, weekday, start time, workout name, duration, completion percentage, total volume. Filterable by workout. `abandoned` sessions are visibly marked but never hidden.

**Session detail** — the full exercise-by-exercise, set-by-set breakdown: target vs. actual reps, weight, per-set work and rest seconds, and skipped sets marked as skipped. Show session totals: duration, active time, rest time, total volume (Σ weight × actual reps, unit-aware).

**Stats** — a summary panel above the list:

- Current streak and longest streak, in weeks with at least one completed non-optional workout.
- Sessions completed in the last 7 and 30 days.
- Per-exercise progression: heaviest weight, best single-set volume, and a small trend chart of volume per session over time.

Charts are **hand-rolled inline SVG** — sparklines and simple bars. No chart library. Empty states must say what to do, not just that there is nothing here.

---

## 9. Persistence, import, and export

- **IndexedDB** for workouts, sessions, and the in-progress player state. Sessions accumulate indefinitely; do not put them in `localStorage`.
- **`localStorage`** only for `Settings` and trivial UI preferences.
- All writes go through a single persistence module with a `schemaVersion` and a migration path, so a future model change does not strand my data.

### Export

Two buttons, clearly labeled:

- **Export workouts** — portable, shareable, no history.
- **Export full backup** — workouts + settings + all sessions.

Both download a `.json` file named `workout-timer-<workouts|backup>-YYYY-MM-DD.json`.

```json
{
  "app": "workout-timer",
  "schemaVersion": 1,
  "exportedAt": "2026-07-23T15:04:05.000Z",
  "kind": "workouts",
  "settings": null,
  "sessions": null,
  "workouts": [
    {
      "id": "b1e8...",
      "name": "Push A",
      "dayOfWeek": 1,
      "optional": false,
      "order": 0,
      "createdAt": "2026-07-01T12:00:00.000Z",
      "updatedAt": "2026-07-20T09:30:00.000Z",
      "exercises": [
        {
          "id": "9f2c...",
          "name": "Bench Press",
          "weight": 135,
          "unit": "lb",
          "sets": 4,
          "targetReps": 8,
          "restBetweenSets": 90,
          "restAfterExercise": 120,
          "notes": "Pause at the chest"
        }
      ]
    }
  ]
}
```

### Import

- Validate the parsed file against the schema before touching stored data. Reject with a specific, human-readable error listing what is wrong and where — never partially apply a bad import.
- On ID collision, ask: **Merge** (regenerate IDs, keep both) or **Replace** (overwrite matching IDs). Never silently clobber.
- Accept files exported by either mode.

### Storage boundary

Browser storage is the only store. Do not use the File System Access API, directory handles, or any other mechanism for writing to the device filesystem. The export buttons trigger a plain browser download and nothing more; there is no automatic or background backup.

Because IndexedDB can be cleared by the browser or by clearing site data, Settings must state this plainly and show the date of the last export, with a nudge to export when the most recent one is more than two weeks old. Treat that reminder as the safety net, not an afterthought.

---

## 10. Design direction

Aim for something that looks like a considered, opinionated product, not a Tailwind starter template. Ship a small token system defined once in CSS custom properties and used everywhere.

- **Dark-first**, for gym lighting and OLED battery. A deep desaturated ink base rather than pure black — around `#0E1116` — with two elevation steps above it.
- **Color encodes player state**, which is the one place color carries real information: work is a bright active hue, rest is a calm cool hue, exercise transitions are a third distinct hue, and warnings/skips are amber. Everything outside the player stays near-monochrome so those state colors mean something. Use no more than one accent outside the player.
- **Typography:** one bundled variable font, weights used with intent. Timers, weights, reps, and set counters use `font-variant-numeric: tabular-nums` so digits do not jitter as they change. The countdown deserves a genuinely large, tight-tracked treatment; the rest of the type stays quiet and small.
- **Spend boldness in one place.** The player's timer and its progress ring are the signature element. Everything else — lists, forms, history — should be disciplined, dense, and calm. Cut any decoration that does not encode information.
- **Motion:** brief and functional. State transitions crossfade, the ring animates smoothly, numbers do not bounce. Respect `prefers-reduced-motion` fully.
- **Copy:** active voice, sentence case, plain verbs. A button says exactly what happens: "Set complete", "End workout", "Import workouts". Buttons and their resulting confirmations use the same word.
- **Quality floor, unannounced:** minimum 44 px tap targets everywhere and 56 px in the player; visible keyboard focus rings; correct labels and `aria-live` announcements for timer state changes; safe-area insets honored; usable from 320 px wide up to desktop; a light theme that is properly designed, not an inverted afterthought.

---

## 11. Edge cases to handle explicitly

1. Workout with one exercise; exercise with one set.
2. `restAfterExercise` on the final exercise — never runs.
3. Any rest set to 0 — passes straight through with no rest screen.
4. Previous-set pressed at exercise 0, set 0 — control is disabled, not a crash.
5. Skip exercise on the final exercise → goes to `complete`.
6. Every set skipped → session saved with `status: 'completed'`, exercise outcomes `skipped`, volume 0.
7. Refresh, crash, or OS-killed tab mid-workout → "Resume workout" restores exact state including remaining rest.
8. Deleting or editing a workout that has history → history is untouched and still readable.
9. Multiple workouts assigned to the same day → both shown, in `order`.
10. Editing a workout while it is playing → blocked; the editor is unreachable from the player.
11. Empty workout (zero exercises) → cannot be started; the Start button explains why.
12. Unit changed in settings → existing exercises keep their stored unit; never silently convert numbers.
13. Import of a file from a future `schemaVersion` → refuse with a clear message rather than guessing.
14. Storage quota exceeded → surface a real error and offer export before anything is lost.
15. Device sleeps or a call comes in mid-rest → countdown reconciles correctly on return.

---

## 12. Build order

Work in these phases and keep the app runnable at the end of each.

1. Scaffold: Vite + Vue + TS + Tailwind + Pinia + router + PWA plugin. Persistence module, types, seed data.
2. Workout CRUD: editor, validation, reordering of exercises and workouts, Today screen.
3. Headless player store: the full state machine and timer engine, plus Vitest coverage. No player UI yet.
4. Player UI, audio cues, haptics, wake lock, rep stepper, transport controls.
5. Session logging, history list, session detail, stats and SVG charts.
6. Import/export, settings, last-export reminder, erase-all-data.
7. PWA polish: icons, manifest, offline verification, install prompt handling plus an iOS "Add to Home Screen" hint.
8. Edge-case pass against §11, accessibility pass, light theme, final visual critique.

---

## 13. Acceptance checklist

Verify each of these yourself before telling me you are done, and report the results:

- [ ] `npm run build` produces a bundle that loads and functions with the network fully disabled after the first visit.
- [ ] Installs to an iOS home screen and an Android home screen, launches without browser chrome, and shows the correct icon and name.
- [ ] A complete workout can be created, ordered, assigned a day, marked optional, played end to end, and appears in history with correct per-set reps.
- [ ] A rest countdown started, then backgrounded for longer than its duration, resolves to the correct subsequent state on return.
- [ ] Pause, resume, previous set, previous exercise, skip set, skip exercise, and stop all behave per §6, with no way to reach an invalid state.
- [ ] Audio cues fire on iOS Safari with the screen on, after the initial Start tap.
- [ ] Killing the tab mid-workout and reopening restores the session with the correct remaining rest.
- [ ] Exported JSON re-imports cleanly into a freshly cleared install and reproduces the workouts exactly.
- [ ] A deliberately malformed JSON import is rejected with a specific message and leaves stored data unchanged.
- [ ] Lighthouse PWA and Accessibility both score 95+.
- [ ] The state machine and timer engine have unit tests, and they pass.

---

## 14. Do not

- Do not add a backend, an account system, or cloud sync.
- Do not load anything from a CDN at runtime, including fonts.
- Do not store session history in `localStorage`.
- Do not use the File System Access API or any other device-filesystem write path. Browser storage plus manual JSON export is the whole persistence story.
- Do not count `setInterval` ticks to measure time.
- Do not block the rest countdown behind rep entry.
- Do not add a chart library, a UI kit, or a state library other than Pinia.
- Do not add features I did not ask for — no social sharing, no exercise database, no AI coaching, no achievements.
- Do not leave `TODO` stubs in shipped screens. If something is out of scope, say so in `DECISIONS.md`.

---

## 15. Deliverables

A working repo containing: source, `README.md` with setup and build instructions plus a short architecture overview, `DECISIONS.md` recording every judgment call you made, and the passing test suite. Tell me any place where a platform limitation forced a compromise.

/**
 * Vibration alongside audio cues. Feature-detected; iOS Safari has no
 * navigator.vibrate, so this degrades silently everywhere it is missing.
 * Cues never depend on vibration succeeding.
 */
function vibrate(pattern: number | number[]): void {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    // ignore
  }
}

export const haptics = {
  beep: () => vibrate(40),
  go: () => vibrate(150),
  newExercise: () => vibrate([80, 60, 80]),
  complete: () => vibrate([100, 80, 100, 80, 220]),
  tap: () => vibrate(15),
};

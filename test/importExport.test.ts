import { describe, expect, it } from 'vitest';
import {
  buildExportFile,
  exportFileName,
  findCollisions,
  ImportError,
  parseImportFile,
} from '@/lib/importExport';
import type { Session, Settings, Workout } from '@/types';

const workout: Workout = {
  id: 'w-1',
  name: 'Push A',
  dayOfWeek: 1,
  optional: false,
  order: 0,
  createdAt: '2026-07-01T12:00:00.000Z',
  updatedAt: '2026-07-20T09:30:00.000Z',
  exercises: [
    {
      id: 'e-1',
      name: 'Bench Press',
      weight: 135,
      unit: 'lb',
      sets: 4,
      targetReps: 8,
      restBetweenSets: 90,
      restAfterExercise: 120,
      notes: 'Pause at the chest',
    },
  ],
};

const settings: Settings = {
  defaultUnit: 'lb',
  defaultRestBetweenSets: 90,
  defaultRestAfterExercise: 120,
  soundEnabled: true,
  vibrationEnabled: true,
  keepScreenAwake: true,
  countdownBeepsAt: [3, 2, 1],
  theme: 'dark',
};

const session: Session = {
  id: 's-1',
  workoutId: 'w-1',
  workoutName: 'Push A',
  startedAt: '2026-07-21T10:00:00.000Z',
  endedAt: '2026-07-21T10:40:00.000Z',
  status: 'completed',
  durationSeconds: 2400,
  totalRestSeconds: 600,
  exercises: [
    {
      exerciseId: 'e-1',
      name: 'Bench Press',
      targetSets: 4,
      outcome: 'completed',
      sets: [
        {
          setIndex: 0,
          targetReps: 8,
          actualReps: 8,
          weight: 135,
          unit: 'lb',
          outcome: 'completed',
          startedAt: '2026-07-21T10:00:10.000Z',
          completedAt: '2026-07-21T10:00:40.000Z',
          workSeconds: 30,
          restSeconds: 90,
        },
      ],
    },
  ],
};

describe('export', () => {
  it('builds a workouts export with null settings and sessions', () => {
    const file = buildExportFile('workouts', [workout], settings, [session]);
    expect(file.app).toBe('workout-timer');
    expect(file.kind).toBe('workouts');
    expect(file.settings).toBeNull();
    expect(file.sessions).toBeNull();
    expect(file.workouts).toHaveLength(1);
  });

  it('builds a full backup with everything', () => {
    const file = buildExportFile('backup', [workout], settings, [session]);
    expect(file.settings).toEqual(settings);
    expect(file.sessions).toHaveLength(1);
  });

  it('names files workout-timer-<kind>-YYYY-MM-DD.json', () => {
    expect(exportFileName('backup', new Date(2026, 6, 23))).toBe(
      'workout-timer-backup-2026-07-23.json',
    );
  });
});

describe('import validation', () => {
  it('round-trips its own exports for both kinds', () => {
    for (const kind of ['workouts', 'backup'] as const) {
      const file = buildExportFile(kind, [workout], settings, [session]);
      const parsed = parseImportFile(JSON.stringify(file));
      expect(parsed.workouts).toEqual([workout]);
    }
  });

  it('rejects non-JSON with a parse message', () => {
    expect(() => parseImportFile('{nope')).toThrowError(ImportError);
  });

  it('rejects files from other apps', () => {
    const bad = { app: 'other-app', schemaVersion: 1, kind: 'workouts', workouts: [] };
    try {
      parseImportFile(JSON.stringify(bad));
      expect.unreachable();
    } catch (err) {
      expect((err as ImportError).problems.join(' ')).toContain('workout-timer');
    }
  });

  it('refuses a future schemaVersion with a clear message', () => {
    const future = buildExportFile('workouts', [workout], null, null);
    (future as { schemaVersion: number }).schemaVersion = 99;
    try {
      parseImportFile(JSON.stringify(future));
      expect.unreachable();
    } catch (err) {
      const msg = (err as ImportError).problems.join(' ');
      expect(msg).toContain('version 99');
      expect(msg).toContain('Update the app');
    }
  });

  it('pinpoints the exact invalid field', () => {
    const file = buildExportFile('workouts', [workout], null, null);
    (file.workouts[0]!.exercises[0] as { sets: unknown }).sets = 'four';
    try {
      parseImportFile(JSON.stringify(file));
      expect.unreachable();
    } catch (err) {
      expect((err as ImportError).problems.some((p) => p.includes('workouts[0].exercises[0].sets'))).toBe(
        true,
      );
    }
  });

  it('rejects out-of-range values', () => {
    const file = buildExportFile('workouts', [workout], null, null);
    file.workouts[0]!.exercises[0]!.restBetweenSets = -5;
    (file.workouts[0] as { dayOfWeek: unknown }).dayOfWeek = 9;
    try {
      parseImportFile(JSON.stringify(file));
      expect.unreachable();
    } catch (err) {
      const problems = (err as ImportError).problems;
      expect(problems.some((p) => p.includes('restBetweenSets'))).toBe(true);
      expect(problems.some((p) => p.includes('dayOfWeek'))).toBe(true);
    }
  });

  it('validates sessions inside backups', () => {
    const file = buildExportFile('backup', [workout], settings, [session]);
    (file.sessions![0] as { status: unknown }).status = 'weird';
    expect(() => parseImportFile(JSON.stringify(file))).toThrowError(ImportError);
  });
});

describe('collision detection', () => {
  it('reports overlapping workout and session ids', () => {
    const file = buildExportFile('backup', [workout], settings, [session]);
    const collisions = findCollisions(file, [workout], [session]);
    expect(collisions.workoutIds).toEqual(['w-1']);
    expect(collisions.sessionIds).toEqual(['s-1']);
  });

  it('reports nothing when ids are new', () => {
    const file = buildExportFile('backup', [workout], settings, [session]);
    const collisions = findCollisions(file, [], []);
    expect(collisions.workoutIds).toEqual([]);
    expect(collisions.sessionIds).toEqual([]);
  });
});

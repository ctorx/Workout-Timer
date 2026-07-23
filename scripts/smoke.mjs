/**
 * Headless smoke test against a built bundle served by `vite preview`.
 * Not part of the shipped app; a manual verification aid (`node scripts/smoke.mjs`).
 */
import { chromium } from 'playwright';
import { writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const BASE = process.env.SMOKE_URL ?? 'http://localhost:4173';

const failures = [];
let shot = 0;

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await context.newPage();

async function check(name, ok) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) {
    failures.push(name);
    try {
      await page.screenshot({ path: `scripts/fail-${shot++}-${name.replace(/[^a-z0-9]+/gi, '_')}.png` });
    } catch {
      /* ignore */
    }
  }
}

async function visible(locator, timeout = 5000) {
  try {
    await locator.waitFor({ state: 'visible', timeout });
    return true;
  } catch {
    return false;
  }
}

async function atPath(pathname, timeout = 10_000) {
  try {
    await page.waitForURL((u) => new URL(u).pathname === pathname, { timeout });
    return true;
  } catch {
    return false;
  }
}

const consoleErrors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});
page.on('pageerror', (err) => consoleErrors.push(String(err)));

await page.goto(BASE, { waitUntil: 'networkidle' });
await check('Today renders', await visible(page.getByRole('heading', { name: 'Workouts' })));
await check('Seed workout visible', await visible(page.getByText('Full body (sample)').first()));

await page.getByText('Full body (sample)').first().click();
await page.getByRole('button', { name: 'Start workout' }).click();
await page.waitForURL('**/play/**');
await check('Work state', await visible(page.getByText('Work', { exact: true })));
await check('Set complete button', await visible(page.getByRole('button', { name: 'Set complete' })));

await page.getByRole('button', { name: 'Set complete' }).click();
await check('Rest state', await visible(page.getByText('Rest', { exact: true })));
await check('Rep stepper shown', await visible(page.getByLabel('Edit rep count')));
await check('No Done button', !(await page.getByRole('button', { name: 'Done', exact: true }).count()));

await page.getByRole('button', { name: /Fewer reps/ }).click();
await check(
  'Stepper decremented to 9',
  (await page.getByLabel('Edit rep count').textContent())?.trim() === '9',
);

await page.waitForTimeout(500);
await page.reload({ waitUntil: 'networkidle' });
await check('Rest restored after reload', await visible(page.getByText('Rest', { exact: true })));
await check(
  'Stepper value survives reload',
  ((await page.getByLabel('Edit rep count').textContent()) ?? '').trim() === '9',
);

// Expire rest → alarm until Stop alarm
for (let i = 0; i < 12; i++) {
  await page.getByRole('button', { name: '−15s' }).click();
}
await check('Alarm after rest', await visible(page.getByRole('button', { name: 'Stop alarm' })));
await page.getByRole('button', { name: 'Stop alarm' }).click();
await check(
  'Back to work (set 2)',
  ((await page.getByRole('status').textContent()) ?? '').includes('set 2 of 3'),
);

await page.getByRole('button', { name: 'End workout' }).first().click();
await page.getByRole('dialog').getByRole('button', { name: 'End workout' }).click();
await check('Back on Today after stop', await atPath('/'));

await page.getByRole('link', { name: 'History' }).click();
await check('History lists session', await visible(page.getByText('Abandoned').first()));
await page.getByRole('link', { name: /Full body \(sample\)/ }).click();
await check('Session detail renders', await visible(page.getByRole('heading', { name: 'Session' })));
await check('Set table shows reps', await visible(page.getByText('9/10')));

await page.getByRole('link', { name: 'Settings' }).click();
const downloadPromise = page.waitForEvent('download', { timeout: 5000 });
await page.getByRole('button', { name: 'Export workouts' }).click();
const download = await downloadPromise;
await check(
  'Export downloads JSON',
  /workout-timer-workouts-\d{4}-\d{2}-\d{2}\.json/.test(download.suggestedFilename()),
);

const dir = await mkdtemp(path.join(tmpdir(), 'wt-'));
const badFile = path.join(dir, 'bad.json');
await writeFile(badFile, JSON.stringify({ app: 'other', schemaVersion: 1, kind: 'workouts', workouts: [{}] }));
await page.locator('input[type=file]').setInputFiles(badFile);
await check('Bad import rejected', await visible(page.getByText('Import rejected — nothing was changed:')));

await page.getByRole('link', { name: 'Today' }).click();
await page.getByRole('link', { name: 'New workout' }).click();
await page.getByRole('button', { name: 'Save' }).click();
await check('Validation blocks save', await visible(page.getByText('Fix the highlighted fields')));

await page.getByLabel('Workout name').fill('Smoke Test Day');
await page.getByLabel('Exercise 1 name').fill('Squat');
await page.getByRole('button', { name: 'Save' }).click();
await check('Editor saves and returns', await atPath('/'));
await check('New workout listed', await visible(page.getByText('Smoke Test Day')));

await page.getByRole('link', { name: 'Settings' }).click();
await page.getByRole('radio', { name: 'light' }).click();
await check(
  'Light theme class applied',
  await page.evaluate(() => document.documentElement.classList.contains('light')),
);

const swReady = await page.evaluate(async () => {
  const reg = await navigator.serviceWorker?.getRegistration();
  return Boolean(reg?.active);
});
await check('Service worker active', swReady);

await context.setOffline(true);
await page.reload({ waitUntil: 'domcontentloaded' });
await check('App loads offline', await visible(page.getByRole('heading', { name: 'Settings' })));
await context.setOffline(false);

const realErrors = consoleErrors.filter((e) => !/favicon/i.test(e));
await check(`No console errors (${realErrors.length})`, realErrors.length === 0);
if (realErrors.length > 0) console.log(realErrors.join('\n'));

await browser.close();
console.log(failures.length === 0 ? '\nSMOKE: ALL PASS' : `\nSMOKE: ${failures.length} FAILURE(S)`);
process.exit(failures.length === 0 ? 0 : 1);

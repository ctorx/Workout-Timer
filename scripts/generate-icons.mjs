/**
 * One-time icon generation: renders scripts/icon.svg into the PNG sizes the
 * manifest and iOS need, plus a maskable variant with extra safe-area padding.
 * Run with: npm run icons
 */
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import sharp from 'sharp';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(root, 'public', 'icons');
await mkdir(outDir, { recursive: true });

const svg = await readFile(path.join(root, 'scripts', 'icon.svg'));

async function render(size, name) {
  await sharp(svg, { density: 300 }).resize(size, size).png().toFile(path.join(outDir, name));
  console.log('wrote', name);
}

await render(192, 'pwa-192.png');
await render(512, 'pwa-512.png');
await render(180, 'apple-touch-icon.png');

// Maskable: the artwork must sit inside the inner 80% safe zone.
const inner = await sharp(svg, { density: 300 }).resize(410, 410).png().toBuffer();
await sharp({
  create: { width: 512, height: 512, channels: 4, background: '#0E1116' },
})
  .composite([{ input: inner, left: 51, top: 51 }])
  .png()
  .toFile(path.join(outDir, 'pwa-maskable-512.png'));
console.log('wrote pwa-maskable-512.png');

// favicon: reuse the SVG directly.
await writeFile(path.join(outDir, 'favicon.svg'), svg);
console.log('wrote favicon.svg');

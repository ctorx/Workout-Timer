import { execSync } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

// GitHub Pages serves project sites from a subpath (/<repo>/). CI sets
// BASE_PATH accordingly; local dev and self-hosting stay at the root.
const base = process.env.BASE_PATH ?? '/';

function commitSha(): string {
  const fromEnv = process.env.VITE_COMMIT_SHA || process.env.GITHUB_SHA;
  if (fromEnv) return fromEnv.trim();
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'dev';
  }
}

const appVersion = commitSha();

/** Emit version.json (not precached) so the app can detect a newer deploy. */
function versionJsonPlugin(sha: string): Plugin {
  return {
    name: 'version-json',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'version.json',
        source: JSON.stringify({ sha, builtAt: new Date().toISOString() }),
      });
    },
  };
}

export default defineConfig({
  base,
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  plugins: [
    vue(),
    tailwindcss(),
    versionJsonPlugin(appVersion),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/apple-touch-icon.png', 'icons/favicon.svg'],
      manifest: {
        name: 'Workout Timer',
        short_name: 'Workout',
        description: 'Offline workout timer with rest countdowns and set logging.',
        theme_color: '#0E1116',
        background_color: '#0E1116',
        display: 'standalone',
        orientation: 'portrait',
        start_url: base,
        scope: base,
        icons: [
          { src: 'icons/pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/pwa-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'icons/pwa-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2,ico}'],
        navigateFallback: 'index.html',
        // The app is fully self-contained: never attempt runtime caching of
        // cross-origin requests (there are none). version.json is intentionally
        // not in globPatterns so update checks always hit the network.
        runtimeCaching: [],
      },
    }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});

import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

/**
 * Dev only: the daemon that `npm run dev:ui` forwards API calls and sign-in links to. Always a demo on a 17xxx port
 * with a temporary data directory: `node dist/bin.js demo --port 17338 --data-dir "$(mktemp -d)"`.
 */
const daemon = process.env.SHQ_DAEMON ?? 'http://127.0.0.1:17338';
/** The daemon accepts only its own Host and Origin: the proxy rewrites both. */
const toDaemon = { target: daemon, changeOrigin: true, headers: { origin: daemon } };

export default defineConfig({
  root: 'ui',
  base: '/ui/',
  plugins: [svelte()],
  build: {
    outDir: '../dist/ui',
    emptyOutDir: true,
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
    sourcemap: false,
    target: 'es2022',
  },
  server: {
    host: '127.0.0.1',
    port: 17173,
    strictPort: true,
    proxy: { '/api': toDaemon, '/ui/login': toDaemon },
  },
});

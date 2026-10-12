import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'node', include: ['test/**/*.test.ts'], environment: 'node', testTimeout: 15000 } },
      {
        plugins: [svelte({ configFile: 'ui/svelte.config.js' })],
        // Svelte's package exports a server build by default: UI tests need the browser one.
        resolve: { conditions: ['browser'] },
        test: {
          name: 'ui',
          include: ['ui/test/**/*.test.ts'],
          environment: 'happy-dom',
          testTimeout: 15000,
          // Vitest empties stylesheets by default; tests that read one as text (`?raw`) get its content.
          css: { include: [/\.css\?raw$/] },
        },
      },
    ],
  },
});

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';

/**
 * The browser smoke test, run by `npm run test:e2e` only: it is not part of `npm test` and does not run in CI.
 * It drives the Google Chrome installed on this machine, headless, and never downloads a browser.
 * e2e/smoke.spec.ts starts its own demo daemon on a 17xxx port with a temporary data directory.
 */
export default defineConfig({
  testDir: 'e2e',
  globalSetup: './e2e/global-setup.ts',
  // Nothing is written into the repository.
  outputDir: join(tmpdir(), 'scranton-hq-e2e'),
  reporter: 'list',
  workers: 1,
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  use: {
    channel: 'chrome',
    headless: true,
    viewport: { width: 1280, height: 800 },
    // WebGL without a GPU: Chrome's software renderer, which it no longer falls back to on its own.
    launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] },
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
});

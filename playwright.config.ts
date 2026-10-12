import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';

/**
 * Where Playwright writes, and empties at every run: a directory of this checkout's own, named by a hash of its path, so
 * a run in another checkout never empties or reads it. Nothing is written into the repository.
 */
const OUTPUT_DIR = join(tmpdir(), `scranton-hq-e2e-${createHash('sha256').update(import.meta.dirname).digest('hex').slice(0, 12)}`);

/**
 * The browser smoke test, run by `npm run test:e2e` only: it is not part of `npm test` and does not run in CI.
 * It drives the Google Chrome installed on this machine, headless, and never downloads a browser.
 * e2e/smoke.spec.ts starts its own demo daemon on a 17xxx port with a temporary data directory.
 */
export default defineConfig({
  testDir: 'e2e',
  globalSetup: './e2e/global-setup.ts',
  outputDir: OUTPUT_DIR,
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

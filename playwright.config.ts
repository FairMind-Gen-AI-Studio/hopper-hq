import { defineConfig } from '@playwright/test';
import { outputDirFor } from './e2e/output.js';

/** This checkout's own output directory, emptied at every run and removed after a passing one (e2e/clean-output-reporter.ts). */
const OUTPUT_DIR = outputDirFor(import.meta.dirname);

/**
 * The browser smoke test, run by `npm run test:e2e` only: it is not part of `npm test` and does not run in CI.
 * It drives the Google Chrome installed on this machine, headless, and never downloads a browser.
 * e2e/smoke.spec.ts starts its own demo daemon on a 17xxx port with a temporary data directory.
 */
export default defineConfig({
  testDir: 'e2e',
  globalSetup: './e2e/global-setup.ts',
  outputDir: OUTPUT_DIR,
  reporter: [['list'], ['./e2e/clean-output-reporter.ts']],
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

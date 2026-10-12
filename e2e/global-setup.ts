import { chromium } from '@playwright/test';

/**
 * The smoke test runs on the Google Chrome installed on this machine. When there is none, say so plainly: Playwright's
 * own message suggests downloading a browser, which this project does not do.
 */
export default async function requireChrome(): Promise<void> {
  try {
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    await browser.close();
  } catch (err) {
    const reason = (err instanceof Error ? err.message : String(err)).split('\n')[0];
    throw new Error(
      'npm run test:e2e runs on the Google Chrome installed on this machine, and could not start it.\n' +
        'Install Google Chrome and run it again; this test never downloads a browser.\n' +
        `Playwright said: ${reason}`,
    );
  }
}

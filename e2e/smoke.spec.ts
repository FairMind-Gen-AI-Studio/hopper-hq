import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * A black-box run of the built package (`npm run test:e2e` builds it first). The test starts a demo daemon of its
 * own on a free port in 17000-17999, with a temporary data directory, signs in through the link the demo prints,
 * and drives the UI in headless Chrome. It never connects to another daemon and never reads ~/.scranton-hq.
 *
 * The demo replays a one-minute script, so who needs you changes as it runs: the test reads what is on screen
 * instead of assuming a session or a floor.
 */

interface Demo {
  child: ChildProcess;
  dir: string;
  port: number;
  /** The one-time sign-in link the demo printed. */
  login: string;
}

const BIN = join(import.meta.dirname, '..', 'dist', 'bin.js');
const LOGIN = /http:\/\/127\.0\.0\.1:\d+\/ui\/login\?code=[0-9a-f]{48}/;

/** Runs `node dist/bin.js demo` until it prints its sign-in link. Null when the port was taken. */
function runDemo(port: number, dir: string): Promise<{ child: ChildProcess; login: string } | null> {
  const child = spawn(process.execPath, [BIN, 'demo', '--port', String(port), '--data-dir', dir], {
    // Belt and braces: whatever the daemon resolves on its own stays inside the temporary directory.
    env: { ...process.env, SCRANTON_HQ_HOME: dir, CLAUDE_CONFIG_DIR: join(dir, 'claude') },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`The demo daemon printed no sign-in link within 20 s:\n${stderr}`));
    }, 20_000);
    child.stderr!.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
      const login = LOGIN.exec(stderr)?.[0];
      if (login) {
        clearTimeout(timer);
        resolve({ child, login });
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (/already in use/.test(stderr)) resolve(null);
      else reject(new Error(`The demo daemon exited (${code}) before printing a sign-in link:\n${stderr}`));
    });
  });
}

async function startDemo(): Promise<Demo> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const port = 17000 + Math.floor(Math.random() * 1000);
    const dir = await mkdtemp(join(tmpdir(), 'scranton-hq-e2e-'));
    const started = await runDemo(port, dir).catch(async (err: unknown) => {
      await rm(dir, { recursive: true, force: true });
      throw err;
    });
    if (started) return { ...started, dir, port };
    await rm(dir, { recursive: true, force: true });
  }
  throw new Error('Found no free port for the demo daemon in 17000-17999.');
}

/** Stops the demo this test started (its own PID only) and removes its data directory. */
async function stopDemo(demo: Demo): Promise<void> {
  const { child } = demo;
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    await exited;
    clearTimeout(timer);
  }
  await rm(demo.dir, { recursive: true, force: true });
}

/** What went wrong on a page: console errors, uncaught exceptions, content-policy violations, failed requests. */
async function watch(page: Page) {
  const seen = { errors: [] as string[], violations: [] as string[], failed: [] as string[], scripts: [] as string[] };
  page.on('console', (m) => {
    if (m.type() === 'error') seen.errors.push(m.text());
  });
  page.on('pageerror', (e) => seen.errors.push(e.message));
  page.on('requestfailed', (r) => {
    const reason = r.failure()?.errorText ?? '';
    // The page closes its live stream to reopen it on another floor: that one ends as aborted, by design.
    if (new URL(r.url()).pathname === '/api/events' && reason === 'net::ERR_ABORTED') return;
    seen.failed.push(`${r.url()} ${reason}`);
  });
  page.on('response', (r) => {
    if (r.status() >= 400) seen.failed.push(`${r.url()} ${r.status()}`);
  });
  page.on('request', (r) => {
    if (r.resourceType() === 'script') seen.scripts.push(new URL(r.url()).pathname);
  });
  // Injected by the browser's debugging protocol, which the page's content policy does not apply to.
  await page.exposeFunction('reportViolation', (v: string) => seen.violations.push(v));
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      (window as unknown as { reportViolation(v: string): void }).reportViolation(`${e.violatedDirective} ${e.blockedURI}`);
    });
  });
  return seen;
}

function route(page: Page): { floor: string | null; desk: string | null } {
  const m = /^#\/floor\/([^/]+)(?:\/desk\/([^/]+))?$/.exec(new URL(page.url()).hash);
  return { floor: m ? decodeURIComponent(m[1]!) : null, desk: m?.[2] ? decodeURIComponent(m[2]) : null };
}

/** Where a desk's label sits on the screen. */
async function spot(tag: Locator): Promise<string> {
  const box = await tag.boundingBox();
  return box ? `${Math.round(box.x)},${Math.round(box.y)}` : 'hidden';
}

/** The centre of a desk's label, once the camera has stopped moving it. */
async function centre(tag: Locator): Promise<{ x: number; y: number }> {
  let last = '';
  await expect
    .poll(async () => {
      const now = await spot(tag);
      const still = now === last;
      last = now;
      return still;
    }, { intervals: [150] })
    .toBe(true);
  const box = (await tag.boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

let demo: Demo;

test.beforeAll(async () => {
  demo = await startDemo();
});

test.afterAll(async () => {
  if (demo) await stopDemo(demo);
});

test('signs in from the demo link, then walks the building, a floor in 3D and a desk', async ({ page, browser }, info) => {
  const seen = await watch(page);
  const toast = page.locator('.toast span').last();
  const canvas = page.locator('.stage .floor-stage canvas');

  await test.step('the one-time link signs the browser in and lands on the building', async () => {
    const response = await page.goto(demo.login);
    expect(new URL(page.url()).pathname).toBe('/ui/');
    const csp = response?.headers()['content-security-policy'] ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(response?.headers()['x-frame-options']).toBe('DENY');
    const cookie = (await page.context().cookies()).find((c) => c.name === `shq_${demo.port}`);
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe('Strict');
    await expect(page.locator('.stage svg.facade g.floor')).toHaveCount(3);
    await expect(page.locator('.notice')).toHaveCount(0);
    expect(seen.scripts).toHaveLength(1);
  });

  await test.step('the attention bar keeps one height however many sessions it lists, so the stage below never moves', async () => {
    await expect(page.locator('.attention .chip').first()).toBeVisible();
    const { before, after, scrolls } = await page.evaluate(() => {
      const where = () =>
        ['.attention', '.stage'].map((selector) => {
          const box = document.querySelector(selector)!.getBoundingClientRect();
          return `${selector} ${box.top} ${box.height}`;
        });
      const bar = document.querySelector('.attention')!;
      const chip = bar.querySelector('.chip')!;
      const before = where();
      // Forty more chips, as if a crowd of sessions finished at once: added and taken away before the page draws again.
      const clones = Array.from({ length: 40 }, () => chip.parentElement!.appendChild(chip.cloneNode(true) as Element));
      const after = where();
      const scrolls = bar.scrollHeight > bar.clientHeight && getComputedStyle(bar).overflowY === 'auto';
      for (const clone of clones) clone.remove();
      return { before, after, scrolls };
    });
    expect(after).toEqual(before);
    expect(scrolls).toBe(true);
  });

  let first = { floor: '', desk: '' };
  await test.step('a needs-you entry opens its desk on its floor, drawn in 3D', async () => {
    const chip = page.locator('.attention .group.needs button.open').first();
    await expect(chip).toBeVisible();
    await chip.click();
    await expect(page).toHaveURL(/#\/floor\/[^/]+\/desk\/[^/]+$/);
    const r = route(page);
    first = { floor: r.floor!, desk: r.desk! };
    await expect(canvas).toBeVisible();
    const box = (await canvas.boundingBox())!;
    expect(box.width).toBeGreaterThan(300);
    expect(box.height).toBeGreaterThan(200);
    // Desk tags exist only once the WebGL view has mounted and projected the floor.
    await expect(page.locator(`button.fv-tag[data-session="${first.desk}"]`)).toBeVisible();
    await expect(page.locator('.fv-sign').first()).toBeVisible();
    await expect(page.locator('.no-webgl')).toHaveCount(0);
    // The renderer and three.js arrive with the first floor, not with the building.
    expect(seen.scripts.length).toBeGreaterThan(1);
    await page.screenshot({ path: info.outputPath('floor.png') });
  });

  await test.step('a double-click on another desk, at a person\'s pace, selects it and goes to its pane (simulated)', async () => {
    const other = page.locator(`button.fv-tag:not([data-session="${first.desk}"])`).filter({ visible: true }).first();
    const id = (await other.getAttribute('data-session'))!;
    const name = (await other.locator('.fv-name').textContent())!;
    const { x, y } = await centre(other);
    const focus = page.waitForResponse((r) => r.url().endsWith('/api/focus') && r.request().method() === 'POST');
    // Two clicks 200 ms apart: the first selects, and the desk must still be under the pointer for the second.
    await page.mouse.click(x, y);
    await page.waitForTimeout(200);
    await page.mouse.click(x, y, { clickCount: 2 });
    const answer = await focus;
    expect(answer.request().postDataJSON()).toEqual({ sessionId: id });
    expect(answer.status()).toBe(200);
    expect(await answer.json()).toMatchObject({ simulated: true });
    await expect(toast).toHaveText(/^Demo: would switch tmux to %\d+$/);
    await expect.poll(() => route(page).desk).toBe(id);
    await expect(page.locator(`button.fv-tag[data-session="${id}"]`)).toHaveClass(/\bfv-sel\b/);
    await expect(page.locator('aside h2')).toHaveText(name);
  });

  await test.step('Go to pane in the desk panel does the same', async () => {
    const focus = page.waitForResponse((r) => r.url().endsWith('/api/focus'));
    await page.locator('aside .actions button.primary').click();
    expect((await focus).status()).toBe(200);
    await expect(toast).toHaveText(/^Demo: would switch tmux to %\d+$/);
  });

  await test.step('Q, E and R turn the floor and reset it', async () => {
    const tag = page.locator(`button.fv-tag[data-session="${first.desk}"]`);
    const before = await spot(tag);
    await page.keyboard.press('e');
    await expect.poll(() => spot(tag)).not.toBe(before);
    await page.keyboard.press('q');
    await page.keyboard.press('r');
    await page.locator('button[aria-label="Turn right"]').click();
    await page.locator('button[aria-label="Reset view"]').click();
  });

  await test.step('the theme toggle switches day and night', async () => {
    const theme = page.locator('button.theme');
    await theme.click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await theme.click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.locator(`button.fv-tag[data-session="${first.desk}"]`)).toBeVisible();
  });

  await test.step('Esc goes back up to the building, and another floor opens on a fresh canvas', async () => {
    await page.keyboard.press('Escape');
    await expect.poll(() => route(page)).toEqual({ floor: first.floor, desk: null });
    await page.keyboard.press('Escape');
    await expect(page.locator('.stage svg.facade')).toBeVisible();
    await expect(canvas).toHaveCount(0);
    const floors = page.locator('.stage svg.facade g.floor');
    await floors.last().focus();
    await page.keyboard.press('Enter');
    await expect(canvas).toBeVisible();
    await expect(page.locator('button.fv-tag').first()).toBeVisible();
    await expect(page.locator('.no-webgl')).toHaveCount(0);
  });

  await test.step('the bundled fonts load from the daemon', async () => {
    const families = await page.evaluate(async () => {
      await document.fonts.ready;
      return [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family.replace(/"/g, ''));
    });
    expect(families).toEqual(expect.arrayContaining(['IBM Plex Sans', 'IBM Plex Mono', 'Archivo']));
  });

  await test.step('nothing went wrong on the page', async () => {
    expect(seen.errors).toEqual([]);
    expect(seen.violations).toEqual([]);
    expect(seen.failed).toEqual([]);
  });

  await test.step('a used sign-in link signs nobody else in', async () => {
    const stranger = await browser.newContext();
    try {
      const other = await stranger.newPage();
      const response = await other.goto(demo.login);
      expect(response?.status()).toBe(401);
      await expect(other.locator('body')).toContainText('already used');
    } finally {
      await stranger.close();
    }
  });

  await test.step('the violation listener does catch one', async () => {
    await page.evaluate(() => {
      const style = document.createElement('style');
      style.textContent = 'body { outline: 0; }';
      document.head.append(style);
    });
    await expect.poll(() => seen.violations.length).toBe(1);
  });
});

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * A black-box run of the built package (`npm run test:e2e` builds it first). The test starts a demo daemon of its
 * own on a free port in 17000-17999, with a temporary data directory, signs in through the link the demo prints,
 * and drives the UI in headless Chrome. It never connects to another daemon and never reads ~/.hopper-hq.
 *
 * The demo replays a one-minute script, so who needs you changes as it runs: the test reads what is on screen
 * instead of assuming a session or a floor. Its two workflow runs take turns, one starting before the other ends, so
 * a meeting room is always open: the test waits for a room with time left. Sessions come to its busiest floor and leave
 * it during the minute.
 *
 * The walk through the building loads the page with ?motion=off, so that every robot stands in its place. Another case
 * loads it with walking on, and waits for a robot that has just come to the floor to reach its desk.
 */

interface Demo {
  child: ChildProcess;
  dir: string;
  port: number;
  /** The one-time sign-in link the demo printed. */
  login: string;
}

const BIN = join(import.meta.dirname, '..', 'dist', 'bin.js');
const UI = join(import.meta.dirname, '..', 'dist', 'ui');
const LOGIN = /http:\/\/127\.0\.0\.1:\d+\/ui\/login\?code=[0-9a-f]{48}/;

/** The environment the demo's commands run in: whatever they resolve on their own stays inside its directory. */
function demoEnv(dir: string): NodeJS.ProcessEnv {
  return { ...process.env, HOPPER_HQ_HOME: dir, CLAUDE_CONFIG_DIR: join(dir, 'claude') };
}

/** Runs `node dist/bin.js demo` until it prints its sign-in link. Null when the port was taken. */
function runDemo(port: number, dir: string): Promise<{ child: ChildProcess; login: string } | null> {
  const child = spawn(process.execPath, [BIN, 'demo', '--port', String(port), '--data-dir', dir], {
    // Belt and braces: whatever the daemon resolves on its own stays inside the temporary directory.
    env: demoEnv(dir),
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
    const dir = await mkdtemp(join(tmpdir(), 'hopper-hq-e2e-'));
    const started = await runDemo(port, dir).catch(async (err: unknown) => {
      await rm(dir, { recursive: true, force: true });
      throw err;
    });
    if (started) return { ...started, dir, port };
    await rm(dir, { recursive: true, force: true });
  }
  throw new Error('Found no free port for the demo daemon in 17000-17999.');
}

/** Another one-time sign-in link to the demo's building, from `hopper-hq ui --no-open`: the demo's own is spent. */
async function signInLink(demo: Demo): Promise<string> {
  const { stdout } = await promisify(execFile)(process.execPath, [BIN, 'ui', '--no-open', '--data-dir', demo.dir], { env: demoEnv(demo.dir) });
  const login = LOGIN.exec(stdout)?.[0];
  expect(login, stdout).toBeDefined();
  return login!;
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

function route(page: Page): { floor: string | null; desk: string | null; run: string | null } {
  const m = /^#\/floor\/([^/]+)(?:\/(desk|run)\/([^/]+))?$/.exec(new URL(page.url()).hash);
  const id = m?.[3] ? decodeURIComponent(m[3]) : null;
  return { floor: m ? decodeURIComponent(m[1]!) : null, desk: m?.[2] === 'desk' ? id : null, run: m?.[2] === 'run' ? id : null };
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

/**
 * What the floor's labels show now, read in one go: the placards and the desks' tags shown, the names shown on desks'
 * tags that are neither selected nor of a desk that needs you or is done, and the shown labels that overlap a later one
 * by more than a pixel of rounding, but for a tag with the pointer or the focus, which shows on top of the others.
 */
async function labelsShown(page: Page): Promise<{ signs: number; desks: number; otherNames: number; overlaps: number }> {
  return page.evaluate(() => {
    const shown = [...document.querySelectorAll('.fv-tag, .fv-sign')].filter((el) => getComputedStyle(el).visibility === 'visible');
    const desks = shown.filter((el) => el.matches('.fv-tag[data-session]'));
    const boxes = shown.filter((el) => !el.matches(':hover, :focus')).map((el) => el.getBoundingClientRect());
    return {
      signs: shown.filter((el) => el.matches('.fv-sign')).length,
      desks: desks.length,
      otherNames: desks.filter((el) => !el.matches('.fv-sel, .fv-st-needs_you, .fv-st-done') && getComputedStyle(el.querySelector('.fv-name')!).clipPath === 'none').length,
      overlaps: boxes.filter((a, i) => boxes.some((b, j) => j > i && a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1)).length,
    };
  });
}

/** What the smoke test reads of GET /api/scene. */
interface Scene {
  floors: Array<{ key: string; number: number; windows: Array<{ sessionId: string | null; state: string | null }>; counts: Record<string, number> }>;
  attention: Record<'needsYou' | 'done', Array<{ sessionId: string; name: string; floorKey: string }>>;
}

/** The building as the daemon sees it now, asked with the page's own sign-in. */
async function sceneOf(page: Page): Promise<Scene> {
  const answer = await page.request.get(new URL('/api/scene', page.url()).href);
  expect(answer.status()).toBe(200);
  return (await answer.json()) as Scene;
}

/** A session on a floor, as the smoke test reads it. */
interface Occupant {
  sessionId: string;
  summary: { text: string } | null;
}

/** What the smoke test reads of GET /api/floor. */
interface Floor {
  rooms: Array<{ runId: string; hostSessionId: string; name: string | null; phases: Array<{ title: string; state: string }> }>;
  pods: Array<{ desks: Array<{ occupant: Occupant | null }> }>;
  unseated: Occupant[];
}

/** One floor as the daemon sees it now, with its meeting rooms, asked with the page's own sign-in. */
async function floorOf(page: Page, key: string): Promise<Floor> {
  const answer = await page.request.get(new URL(`/api/floor?key=${encodeURIComponent(key)}`, page.url()).href);
  expect(answer.status()).toBe(200);
  return (await answer.json()) as Floor;
}

let demo: Demo;

test.beforeAll(async () => {
  demo = await startDemo();
});

test.afterAll(async () => {
  if (demo) await stopDemo(demo);
});

test('builds a page that writes no script, style or asset inline, where the content policy would block it', async () => {
  const files = (await readdir(UI, { recursive: true })).filter((file) => /\.(?:html|css|js)$/.test(file));
  expect(files).toContain('index.html');
  for (const file of files) {
    const text = await readFile(join(UI, file), 'utf8');
    // A data: URI with a media type, as an inlined asset has (three.js only tests for the 'data:' prefix).
    expect(text, file).not.toMatch(/data:[a-z]+\/[\w.+-]+[;,]/i);
    if (file.endsWith('.css')) continue;
    // A style attribute in the page, or in a component's HTML template.
    expect(text, file).not.toMatch(/\sstyle\s*=/i);
    expect(text, file).not.toMatch(/createElement\(\s*["'`]style["'`]\s*\)/);
    if (file.endsWith('.html')) {
      for (const tag of text.match(/<script\b[^>]*>/g) ?? []) expect(tag, file).toMatch(/\ssrc=/);
      expect(text, file).not.toMatch(/<style\b/i);
    }
  }
});

test('signs in from the demo link, then walks the building, a floor in 3D, a desk and a meeting room', async ({ page, browser }, info) => {
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
    // Every robot stands in its place from here on, with no walk and no loop at rest: the building loads again with
    // motion off, which the page reads from its address as each floor opens.
    seen.scripts.length = 0;
    await page.goto(new URL('/ui/?motion=off', page.url()).href);
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
    expect(new URL(page.url()).search).toBe('?motion=off');
    const r = route(page);
    first = { floor: r.floor!, desk: r.desk! };
    await expect(canvas).toBeVisible();
    const box = (await canvas.boundingBox())!;
    expect(box.width).toBeGreaterThan(300);
    expect(box.height).toBeGreaterThan(200);
    // Desk tags exist only once the WebGL view has mounted and projected the floor.
    await expect(page.locator(`button.fv-tag[data-session="${first.desk}"]`)).toBeVisible();
    await expect(page.locator('.no-webgl')).toHaveCount(0);
    // Even zoomed in on the desk, the floor is seen from far: every desk's tag shows its dot, with its name only when it
    // is selected or its desk needs you or is done; no placard shows, and no shown label overlaps another. Read again
    // until no floor update is half drawn.
    await expect(page.locator('.fv-labels')).toHaveClass(/\bfv-compact\b/);
    await expect.poll(() => labelsShown(page)).toMatchObject({ signs: 0, otherNames: 0, overlaps: 0 });
    expect((await labelsShown(page)).desks).toBeGreaterThan(0);
    // Closer in, tags show whole and placards come back, and still none that shows overlaps another.
    const middle = (await canvas.boundingBox())!;
    await page.mouse.move(middle.x + middle.width / 2, middle.y + middle.height / 2);
    await expect
      .poll(async () => {
        await page.mouse.wheel(0, -200);
        return page.locator('.fv-labels.fv-compact').count();
      })
      .toBe(0);
    await expect.poll(async () => (await labelsShown(page)).signs).toBeGreaterThan(0);
    await expect.poll(async () => (await labelsShown(page)).overlaps).toBe(0);
    // The renderer and three.js arrive with the first floor, not with the building.
    expect(seen.scripts.length).toBeGreaterThan(1);
    await page.screenshot({ path: info.outputPath('floor.png') });
  });

  let picked = '';
  await test.step('a double-click on another desk, at a person\'s pace, selects it and goes to its pane (simulated)', async () => {
    // A desk's tag: a room's tag is a button.fv-tag too, with a data-run instead.
    const other = page.locator(`button.fv-tag[data-session]:not([data-session="${first.desk}"])`).filter({ visible: true }).first();
    const id = (await other.getAttribute('data-session'))!;
    picked = id;
    const name = (await other.locator('.fv-name').textContent())!;
    const { x, y } = await centre(other);
    // The point hits that desk's own tag, not a neighbour's laid over it.
    const hit = await page.evaluate(({ px, py }) => document.elementFromPoint(px, py)?.closest('button.fv-tag')?.getAttribute('data-session') ?? null, { px: x, py: y });
    expect(hit).toBe(id);
    const focus = page.waitForResponse((r) => r.url().endsWith('/api/focus') && r.request().method() === 'POST');
    // A double-click at a person's pace, two clicks and no more: a press and a release, 200 ms, then a press and a
    // release the browser counts as the second click. The first selects; the desk must still be under the pointer.
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(200);
    await page.mouse.down({ clickCount: 2 });
    await page.mouse.up({ clickCount: 2 });
    const answer = await focus;
    expect(answer.request().postDataJSON()).toEqual({ sessionId: id });
    expect(answer.status()).toBe(200);
    const { pane, simulated } = (await answer.json()) as { pane: string; simulated: boolean };
    expect(simulated).toBe(true);
    expect(pane).toMatch(/^%\d+$/);
    // The pane the daemon answered for that desk, not just any pane.
    await expect(toast).toHaveText(`Demo: would switch tmux to ${pane}`);
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
    // The selected desk's tag always shows.
    const tag = page.locator(`button.fv-tag[data-session="${picked}"]`);
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
    await expect(page.locator(`button.fv-tag[data-session="${picked}"]`)).toBeVisible();
  });

  let second = '';
  await test.step('an attention entry on another floor opens that floor straight from this one, on a fresh canvas', async () => {
    const { attention } = await sceneOf(page);
    const entry = [...attention.needsYou, ...attention.done].find((e) => e.floorKey !== first.floor);
    expect(entry, 'an attention entry on another floor than the first').toBeDefined();
    const old = await canvas.elementHandle();
    await page.locator('.attention li.chip').filter({ has: page.getByText(entry!.name, { exact: true }) }).locator('button.open').click();
    await expect.poll(() => route(page)).toEqual({ floor: entry!.floorKey, desk: entry!.sessionId, run: null });
    await expect(page.locator(`button.fv-tag[data-session="${entry!.sessionId}"]`)).toBeVisible();
    await expect(page.locator('.no-webgl, .load-failed')).toHaveCount(0);
    expect(await canvas.evaluate((now, before) => now !== before, old)).toBe(true);
    second = entry!.floorKey;
  });

  await test.step('Esc goes back up to the building, and a floor not opened yet opens on a fresh canvas', async () => {
    await page.keyboard.press('Escape');
    await expect.poll(() => route(page)).toEqual({ floor: second, desk: null, run: null });
    await page.keyboard.press('Escape');
    await expect(page.locator('.stage svg.facade')).toBeVisible();
    await expect(canvas).toHaveCount(0);
    const { floors } = await sceneOf(page);
    const next = floors.find((f) => f.key !== first.floor && f.key !== second) ?? floors.find((f) => f.key !== second);
    expect(next, 'a floor other than the one just left').toBeDefined();
    await page.locator(`.stage svg.facade g.floor[aria-label^="Floor ${next!.number}, "]`).focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => route(page).floor).toBe(next!.key);
    await expect(canvas).toBeVisible();
    // Its desks' tags are on the page once the view has drawn the floor; one may be hidden under a tag that ranks higher.
    const seated = next!.windows.find((w) => w.sessionId !== null && w.state !== 'dormant');
    await expect(page.locator(`button.fv-tag[data-session="${seated!.sessionId}"]`)).toBeAttached();
    await expect(page.locator('.no-webgl, .load-failed')).toHaveCount(0);
  });

  let run = { floor: '', host: '' };
  await test.step('a meeting room\'s tag opens its workflow run, with its phases', async () => {
    // Wait for a room whose last phase has not begun, so that it stays open a while: the demo's two runs take turns, so
    // one comes within 4 s.
    const { floors } = await sceneOf(page);
    let found: { floor: Scene['floors'][number]; room: Floor['rooms'][number] } | undefined;
    await expect
      .poll(
        async () => {
          for (const floor of floors) {
            const room = (await floorOf(page, floor.key)).rooms.find((r) => r.phases.at(-1)?.state === 'upcoming');
            if (room) {
              found = { floor, room };
              return true;
            }
          }
          return false;
        },
        { timeout: 30_000 },
      )
      .toBe(true);
    const { floor, room } = found!;
    await page.keyboard.press('Escape');
    await expect(page.locator('.stage svg.facade')).toBeVisible();
    await page.locator(`.stage svg.facade g.floor[aria-label^="Floor ${floor.number}, "]`).focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => route(page)).toEqual({ floor: floor.key, desk: null, run: null });
    const tag = page.locator(`button.fv-tag.fv-room[data-run="${room.runId}"]`);
    await expect(tag).toBeVisible();
    await tag.click();
    await expect.poll(() => route(page)).toEqual({ floor: floor.key, desk: null, run: room.runId });
    await expect(tag).toHaveClass(/\bfv-sel\b/);
    await expect(page.locator('aside h2')).toHaveText(room.name ?? room.runId);
    await expect(page.locator('aside .phases .ph-title')).toHaveText(room.phases.map((p) => p.title));
    await expect(page.locator('aside .phases li.ph-current')).toHaveCount(1);
    await page.screenshot({ path: info.outputPath('run.png') });
    run = { floor: floor.key, host: room.hostSessionId };
  });

  await test.step('the desk of the session that started the run says in one line where it stands', async () => {
    await page.locator('aside dd button.host').click();
    await expect.poll(() => route(page)).toEqual({ floor: run.floor, desk: run.host, run: null });
    // The demo writes it 8 s after the session's turn ends.
    const line = page.locator('aside section.summary .s-text');
    await expect(line).toBeVisible({ timeout: 20_000 });
    const floor = await floorOf(page, run.floor);
    const desk = [...floor.pods.flatMap((p) => p.desks.flatMap((d) => (d.occupant ? [d.occupant] : []))), ...floor.unseated].find((o) => o.sessionId === run.host);
    expect(desk?.summary?.text).toBeTruthy();
    await expect(line).toHaveText(desk!.summary!.text);
    await expect(page.locator('aside section.summary .s-age')).toHaveText(/^\d+[smhd] ago/);
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

test('with walking on, the robot of a session that comes to the floor walks to its desk, and its tag comes to hang over it', async ({ page }) => {
  test.setTimeout(120_000);
  const seen = await watch(page);
  // Walking on, even where the system asks for reduced motion.
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto(await signInLink(demo));
  expect(new URL(page.url()).search).toBe('');
  // The busiest floor, where the demo's sessions come and go.
  const { floors } = await sceneOf(page);
  const total = (f: Scene['floors'][number]) => Object.values(f.counts).reduce((a, b) => a + b, 0);
  const floor = [...floors].sort((a, b) => total(b) - total(a))[0]!;
  await page.locator(`.stage svg.facade g.floor[aria-label^="Floor ${floor.number}, "]`).focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => route(page)).toEqual({ floor: floor.key, desk: null, run: null });
  const tags = page.locator('button.fv-tag[data-session]');
  await expect(tags.first()).toBeAttached();
  const ids = () => tags.evaluateAll((els) => els.map((el) => el.getAttribute('data-session')!));
  // Those there at first sight stand in their places already.
  const there = new Set(await ids());

  // A session comes to the floor: its tag appears as its robot steps out of the elevator.
  let id = '';
  await expect
    .poll(
      async () => {
        id = (await ids()).find((s) => !there.has(s)) ?? '';
        return id;
      },
      { timeout: 60_000, intervals: [100] },
    )
    .not.toBe('');
  const tag = page.locator(`button.fv-tag[data-session="${id}"]`);
  const transform = () => tag.evaluate((el) => (el as HTMLElement).style.transform);
  let from = '';
  await expect.poll(async () => (from = await transform())).not.toBe('');
  await expect(page.locator('.stage .floor-stage')).toHaveAttribute('data-moving', 'true');

  // Where its tag hangs once it sits at its desk: where a first sight puts it, on a page of its own with motion off,
  // the same size and seen from the same place.
  const still = await page.context().newPage();
  await still.goto(new URL(`/ui/?motion=off${new URL(page.url()).hash}`, page.url()).href);
  const placed = still.locator(`button.fv-tag[data-session="${id}"]`);
  await expect(placed).toBeAttached();
  let desk = '';
  await expect
    .poll(
      async () => {
        const now = await placed.evaluate((el) => (el as HTMLElement).style.transform);
        const same = now !== '' && now === desk;
        desk = now;
        return same;
      },
      { intervals: [250] },
    )
    .toBe(true);
  await still.close();

  // It walks there: its tag leaves where it first hung and comes to hang over its desk, while the rest of the floor may
  // still move.
  expect(from).not.toBe(desk);
  await expect.poll(transform, { timeout: 20_000, intervals: [100] }).toBe(desk);

  expect(seen.errors).toEqual([]);
  expect(seen.violations).toEqual([]);
  expect(seen.failed).toEqual([]);
});

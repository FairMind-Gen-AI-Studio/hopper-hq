import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Collector } from '../../src/collector.js';
import { CSP } from '../../src/server/headers.js';
import { createApiServer } from '../../src/server/http.js';
import { loadUiBundle } from '../../src/server/static.js';
import { call, close, listen } from '../helpers/http.js';

const INDEX = '<!doctype html><title>hopper-hq</title><script type="module" src="/ui/assets/index-abc.js"></script>';
const FONT = Buffer.from([0x77, 0x4f, 0x46, 0x32, 0, 1, 2, 3]);
const MANIFEST = '{"name":"Hopper HQ"}';
const SW = 'self.addEventListener("install", () => {});\n';
const ICON = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);

async function fixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'shq-ui-'));
  await mkdir(join(dir, 'assets', 'img'), { recursive: true });
  await writeFile(join(dir, 'index.html'), INDEX);
  await writeFile(join(dir, 'assets', 'index-abc.js'), 'console.log(1);\n');
  await writeFile(join(dir, 'assets', 'index-abc.css'), 'body{margin:0}\n');
  await writeFile(join(dir, 'assets', 'archivo-latin.woff2'), FONT);
  await writeFile(join(dir, 'assets', 'img', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await writeFile(join(dir, 'assets', 'notes.md'), '# not served\n');
  await writeFile(join(dir, 'assets', 'stray.html'), '<!doctype html><script src="/ui/assets/index-abc.js"></script>');
  await writeFile(join(dir, 'secret.txt'), 'outside assets\n');
  await symlink(join(dir, 'secret.txt'), join(dir, 'assets', 'linked.txt'));
  await mkdir(join(dir, 'outside'));
  await writeFile(join(dir, 'outside', 'evil.js'), 'alert(1);\n');
  await symlink(join(dir, 'outside'), join(dir, 'assets', 'linked-dir'));
  return dir;
}

/**
 * A build with the PWA files too, each next to index.html, as vite's public dir copies them. A plain index.html and
 * assets/ of its own, not `fixture()`'s: its symlinks test a different thing (the bundle keeps no file reached
 * through one), and reading through this fixture's own set of files keeps that unrelated to what is asserted here.
 */
async function pwaFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'shq-ui-'));
  await mkdir(join(dir, 'assets'), { recursive: true });
  await writeFile(join(dir, 'index.html'), INDEX);
  await writeFile(join(dir, 'assets', 'index-abc.js'), 'console.log(1);\n');
  await writeFile(join(dir, 'manifest.webmanifest'), MANIFEST);
  await writeFile(join(dir, 'sw.js'), SW);
  await writeFile(join(dir, 'icon-192.png'), ICON);
  await writeFile(join(dir, 'icon-512.png'), ICON);
  await writeFile(join(dir, 'icon-512-maskable.png'), ICON);
  await writeFile(join(dir, 'apple-touch-icon.png'), ICON);
  return dir;
}

const collector = new Collector({ resolveWorkspace: async (cwd) => ({ cwd, repoRoot: cwd, repoName: basename(cwd), worktree: false, branch: 'main' }), saveDelayMs: 0 });

describe('loadUiBundle', () => {
  it('reads index.html and the regular files under assets/ with an allowed extension', async () => {
    const bundle = (await loadUiBundle(await fixture()))!;
    expect([...bundle.keys()].sort()).toEqual([
      '/ui/assets/archivo-latin.woff2',
      '/ui/assets/img/logo.svg',
      '/ui/assets/index-abc.css',
      '/ui/assets/index-abc.js',
      '/ui/index.html',
    ]);
    expect(bundle.get('/ui/assets/archivo-latin.woff2')).toEqual({ body: FONT, type: 'font/woff2' });
  });

  it('also reads the manifest, the service worker and the icons, next to index.html, when the build has them', async () => {
    const bundle = (await loadUiBundle(await pwaFixture()))!;
    expect([...bundle.keys()].sort()).toEqual([
      '/ui/apple-touch-icon.png',
      '/ui/assets/index-abc.js',
      '/ui/icon-192.png',
      '/ui/icon-512-maskable.png',
      '/ui/icon-512.png',
      '/ui/index.html',
      '/ui/manifest.webmanifest',
      '/ui/sw.js',
    ]);
    expect(bundle.get('/ui/manifest.webmanifest')).toEqual({ body: Buffer.from(MANIFEST), type: 'application/manifest+json' });
    expect(bundle.get('/ui/sw.js')).toEqual({ body: Buffer.from(SW), type: 'text/javascript; charset=utf-8' });
    expect(bundle.get('/ui/icon-192.png')).toEqual({ body: ICON, type: 'image/png' });
  });

  it('is null when there is no index.html', async () => {
    expect(await loadUiBundle(await mkdtemp(join(tmpdir(), 'shq-ui-')))).toBeNull();
    expect(await loadUiBundle(join(tmpdir(), 'shq-no-such-dir'))).toBeNull();
  });

  it('stops at the file and byte limits, and says how many files it left out', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'shq-ui-'));
    await mkdir(join(dir, 'assets'));
    await writeFile(join(dir, 'index.html'), 'x'.repeat(10));
    for (let i = 0; i < 5; i++) await writeFile(join(dir, 'assets', `f${i}.js`), 'y'.repeat(10));
    const log = vi.fn();
    expect((await loadUiBundle(dir, { files: 3, bytes: 1000 }, log))!.size).toBe(3);
    expect((await loadUiBundle(dir, { files: 300, bytes: 35 }, log))!.size).toBe(3);
    expect(log.mock.calls).toEqual([
      ['hopper-hq left 3 UI files out, over its limits of 3 files and 1000 bytes: the browser view may not work.'],
      ['hopper-hq left 3 UI files out, over its limits of 300 files and 35 bytes: the browser view may not work.'],
    ]);
    log.mockClear();
    expect((await loadUiBundle(dir, { files: 6, bytes: 60 }, log))!.size).toBe(6);
    expect(log).not.toHaveBeenCalled();
  });
});

describe('serving the UI', () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    server = createApiServer({ collector, token: 'e'.repeat(48), ui: await loadUiBundle(await fixture()) });
    port = await listen(server);
  });
  afterAll(() => close(server));

  it('serves index.html at /ui/ with the strict policy and no caching', async () => {
    for (const path of ['/ui/', '/ui/index.html']) {
      const r = await call(port, { path });
      expect(r.status).toBe(200);
      expect(r.text).toBe(INDEX);
      expect(r.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(r.headers['content-security-policy']).toBe(CSP);
      expect(r.headers['cross-origin-opener-policy']).toBe('same-origin');
      expect(r.headers['cache-control']).toBe('no-cache');
      expect(r.headers['x-content-type-options']).toBe('nosniff');
    }
    expect(CSP).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
  });

  it('serves assets with their type, the strict policy and a year of immutable caching', async () => {
    const expected: Record<string, string> = {
      '/ui/assets/index-abc.js': 'text/javascript; charset=utf-8',
      '/ui/assets/index-abc.css': 'text/css; charset=utf-8',
      '/ui/assets/archivo-latin.woff2': 'font/woff2',
      '/ui/assets/img/logo.svg': 'image/svg+xml',
    };
    for (const [path, type] of Object.entries(expected)) {
      const r = await call(port, { path });
      expect(r.status).toBe(200);
      expect(r.headers['content-type']).toBe(type);
      expect(r.headers['cache-control']).toBe('public, max-age=31536000, immutable');
      expect(r.headers['content-security-policy']).toBe(CSP);
      expect(r.headers['cross-origin-resource-policy']).toBe('same-origin');
    }
  });

  it('answers HEAD with the headers and no body', async () => {
    const r = await call(port, { method: 'HEAD', path: '/ui/assets/index-abc.js' });
    expect(r.status).toBe(200);
    expect(r.headers['content-length']).toBe('16');
    expect(r.text).toBe('');
  });

  it('serves nothing outside the bundle', async () => {
    const paths = [
      '/ui/../package.json',
      '/ui/assets/../../package.json',
      '/ui/assets/%2e%2e/%2e%2e/package.json',
      '/ui/assets/..%2f..%2fpackage.json',
      '/ui/assets/img%2f..%2f..%2fsecret.txt',
      '/ui/assets\\..\\..\\package.json',
      '/ui/assets/notes.md',
      '/ui/assets/stray.html',
      '/ui/assets/linked.txt',
      '/ui/assets/linked-dir/evil.js',
      '/ui/assets/missing.js',
      '/ui/assets/%E0%A4%A',
      '/ui/secret.txt',
    ];
    for (const path of paths) expect([path, (await call(port, { path })).status]).toEqual([path, 404]);
  });

  it('answers 404 to other methods', async () => {
    expect((await call(port, { method: 'POST', path: '/ui/' })).status).toBe(404);
    expect((await call(port, { method: 'POST', path: '/ui/assets/index-abc.js' })).status).toBe(404);
  });

  it('still checks the Host header', async () => {
    expect((await call(port, { path: '/ui/', headers: { host: `evil.example:${port}` } })).status).toBe(403);
  });
});

describe('serving the PWA files', () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    server = createApiServer({ collector, token: 'e'.repeat(48), ui: await loadUiBundle(await pwaFixture()) });
    port = await listen(server);
  });
  afterAll(() => close(server));

  it('serves the manifest with its own type, no caching, and the strict policy', async () => {
    const r = await call(port, { path: '/ui/manifest.webmanifest' });
    expect(r.status).toBe(200);
    expect(r.text).toBe(MANIFEST);
    expect(r.headers['content-type']).toBe('application/manifest+json');
    expect(r.headers['cache-control']).toBe('no-cache');
    expect(r.headers['content-security-policy']).toBe(CSP);
    expect(CSP).toContain("manifest-src 'self'");
  });

  it('serves the service worker as JavaScript, never cached and never immutable', async () => {
    const r = await call(port, { path: '/ui/sw.js' });
    expect(r.status).toBe(200);
    expect(r.text).toBe(SW);
    expect(r.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(r.headers['cache-control']).toBe('no-cache');
    expect(r.headers['cache-control']).not.toMatch(/immutable/);
    expect(r.headers['content-security-policy']).toBe(CSP);
    expect(CSP).toContain("worker-src 'self'");
  });

  it('serves the icons as PNG, with a day of caching, not immutable', async () => {
    for (const path of ['/ui/icon-192.png', '/ui/icon-512.png', '/ui/icon-512-maskable.png', '/ui/apple-touch-icon.png']) {
      const r = await call(port, { path });
      expect([path, r.status]).toEqual([path, 200]);
      expect([path, r.headers['content-type']]).toEqual([path, 'image/png']);
      expect([path, r.headers['cache-control']]).toEqual([path, 'public, max-age=86400']);
      expect([path, r.headers['content-security-policy']]).toEqual([path, CSP]);
    }
  });

  it('answers HEAD with the headers and no body', async () => {
    const r = await call(port, { method: 'HEAD', path: '/ui/sw.js' });
    expect(r.status).toBe(200);
    expect(r.headers['content-length']).toBe(String(SW.length));
    expect(r.text).toBe('');
  });

  it('answers 404 for a name that is not one of the PWA files', async () => {
    for (const path of ['/ui/icon-1024.png', '/ui/manifest.json', '/ui/service-worker.js']) {
      expect([path, (await call(port, { path })).status]).toEqual([path, 404]);
    }
  });
});

describe('without a built UI', () => {
  it('answers 503 with a hint at /ui/ and 404 for assets', async () => {
    const server = createApiServer({ collector, token: 'e'.repeat(48) });
    const port = await listen(server);
    const index = await call(port, { path: '/ui/' });
    expect(index.status).toBe(503);
    expect(index.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(index.text).toBe('The UI is not built. Run: npm run build\n');
    expect((await call(port, { path: '/ui/assets/index-abc.js' })).status).toBe(404);
    expect((await call(port, { path: '/ui/manifest.webmanifest' })).status).toBe(404);
    expect((await call(port, { path: '/ui/sw.js' })).status).toBe(404);
    expect((await call(port, { path: '/ui/icon-192.png' })).status).toBe(404);
    await close(server);
  });

  it('answers 404 for the PWA files on a build that predates them', async () => {
    const server = createApiServer({ collector, token: 'e'.repeat(48), ui: await loadUiBundle(await fixture()) });
    const port = await listen(server);
    expect((await call(port, { path: '/ui/manifest.webmanifest' })).status).toBe(404);
    expect((await call(port, { path: '/ui/sw.js' })).status).toBe(404);
    expect((await call(port, { path: '/ui/icon-512-maskable.png' })).status).toBe(404);
    await close(server);
  });
});

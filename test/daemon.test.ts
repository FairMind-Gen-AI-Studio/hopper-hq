import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newSession } from '../src/core/reducer.js';
import { readDaemonFile } from '../src/daemon-file.js';
import { startDaemon } from '../src/daemon.js';
import { CSP } from '../src/server/headers.js';
import { Store } from '../src/store/store.js';
import { bearer, call } from './helpers/http.js';
import { isEvent, openSse } from './helpers/sse.js';

const tmp = (p: string) => mkdtemp(join(tmpdir(), p));
const quiet = () => {};

function health(port: number, token: string): Promise<number> {
  return new Promise((resolve, reject) => {
    request({ host: '127.0.0.1', port, path: '/api/health', headers: { authorization: `Bearer ${token}` } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    }).on('error', reject).end();
  });
}

describe('startDaemon', () => {
  it('writes a private daemon file, serves the API and cleans up on stop', async () => {
    const dataDir = await tmp('shq-data-');
    const d = await startDaemon({ port: 0, dataDir, claudeDir: await tmp('shq-claude-'), watchFiles: false, log: quiet });
    const info = await readDaemonFile(dataDir);
    expect(info).toMatchObject({ port: d.port, pid: process.pid });
    expect(info!.token).toMatch(/^[0-9a-f]{48}$/);
    expect((await stat(join(dataDir, 'daemon.json'))).mode & 0o077).toBe(0);
    expect((await stat(join(dataDir, 'token'))).mode & 0o077).toBe(0);
    expect(await health(d.port, info!.token)).toBe(200);
    await d.stop();
    expect(await readDaemonFile(dataDir)).toBeNull();
  });

  it('removes the daemon file even when the last save fails', async () => {
    const dataDir = await tmp('shq-data-');
    const d = await startDaemon({ port: 0, dataDir, claudeDir: await tmp('shq-claude-'), watchFiles: false, log: quiet });
    expect(await readDaemonFile(dataDir)).not.toBeNull();
    vi.spyOn(d.collector, 'close').mockRejectedValue(new Error('database is locked'));
    await expect(d.stop()).rejects.toThrow('database is locked');
    expect(await readDaemonFile(dataDir)).toBeNull();
  });

  it('keeps the same token across restarts', async () => {
    const dataDir = await tmp('shq-data-');
    const claudeDir = await tmp('shq-claude-');
    const a = await startDaemon({ port: 0, dataDir, claudeDir, watchFiles: false, log: quiet });
    const first = (await readDaemonFile(dataDir))!.token;
    await a.stop();
    const b = await startDaemon({ port: 0, dataDir, claudeDir, watchFiles: false, log: quiet });
    expect((await readDaemonFile(dataDir))!.token).toBe(first);
    await b.stop();
  });

  it('tells whoever runs it that the CLI asked it to stop', async () => {
    const dataDir = await tmp('shq-data-');
    const d = await startDaemon({ port: 0, dataDir, claudeDir: await tmp('shq-claude-'), watchFiles: false, log: quiet });
    try {
      const r = await call(d.port, { method: 'POST', path: '/api/shutdown', headers: bearer((await readDaemonFile(dataDir))!.token) });
      expect(r.status).toBe(202);
      await d.stopRequested;
    } finally {
      await d.stop();
    }
  });

  it('fails clearly when the port is taken', async () => {
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r));
    const port = (blocker.address() as AddressInfo).port;
    await expect(startDaemon({ port, dataDir: await tmp('shq-data-'), claudeDir: await tmp('shq-claude-'), watchFiles: false, log: quiet }))
      .rejects.toMatchObject({ code: 'EADDRINUSE' });
    await new Promise<void>((r) => blocker.close(() => r()));
  });
});

describe('startDaemon and the sessions it saved', () => {
  /** A data directory that holds one session, saved while it was working an hour ago, and a Claude directory with no session file. */
  async function leftBehind(): Promise<{ dataDir: string; claudeDir: string }> {
    const dataDir = await tmp('shq-data-');
    const claudeDir = await tmp('shq-claude-');
    await mkdir(join(claudeDir, 'sessions'));
    const store = await Store.open(join(dataDir, 'scranton.db'));
    const cwd = '/w/alpha';
    store.saveSessions([{ ...newSession('S1', Date.now() - 60 * 60_000, { cwd, repoRoot: cwd, repoName: 'alpha', worktree: false, branch: 'main' }), state: 'working' }], Date.now());
    store.close();
    return { dataDir, claudeDir };
  }

  it('ends a saved session whose process exited while it was down, once it has looked for the live ones', async () => {
    const d = await startDaemon({ port: 0, ...(await leftBehind()), log: quiet });
    try {
      for (let i = 0; i < 300 && d.collector.liveViews().length > 0; i++) await new Promise((r) => setTimeout(r, 10));
      expect(d.collector.liveViews()).toEqual([]);
      expect(d.collector.view('S1')?.state).toBe('ended');
    } finally {
      await d.stop();
    }
  });

  it('leaves saved sessions as they are when it does not watch files', async () => {
    const d = await startDaemon({ port: 0, ...(await leftBehind()), watchFiles: false, log: quiet });
    try {
      await d.collector.idle();
      expect(d.collector.view('S1')?.state).toBe('working');
    } finally {
      await d.stop();
    }
  });
});

describe('startDaemon and the browser', () => {
  it('serves the UI bundle from uiDir', async () => {
    const uiDir = await tmp('shq-ui-');
    await mkdir(join(uiDir, 'assets'));
    await writeFile(join(uiDir, 'index.html'), '<!doctype html><title>scranton-hq</title>');
    await writeFile(join(uiDir, 'assets', 'index-abc.js'), 'export {};\n');
    const d = await startDaemon({ port: 0, dataDir: await tmp('shq-data-'), claudeDir: await tmp('shq-claude-'), watchFiles: false, log: quiet, uiDir });
    const index = await call(d.port, { path: '/ui/' });
    expect(index.status).toBe(200);
    expect(index.headers['content-security-policy']).toBe(CSP);
    expect((await call(d.port, { path: '/ui/assets/index-abc.js' })).status).toBe(200);
    await d.stop();
  });

  it('mints sign-in links itself', async () => {
    const d = await startDaemon({ port: 0, dataDir: await tmp('shq-data-'), claudeDir: await tmp('shq-claude-'), watchFiles: false, log: quiet });
    const link = new URL(d.loginUrl());
    expect(link.origin).toBe(`http://127.0.0.1:${d.port}`);
    expect((await call(d.port, { path: link.pathname + link.search })).status).toBe(303);
    await d.stop();
  });

  it('ends live views on stop', async () => {
    const dataDir = await tmp('shq-data-');
    const d = await startDaemon({ port: 0, dataDir, claudeDir: await tmp('shq-claude-'), watchFiles: false, log: quiet });
    const stream = await openSse(d.port, '/api/events', bearer((await readDaemonFile(dataDir))!.token));
    await stream.take(isEvent('scene'));
    await d.stop();
    await stream.ended;
  });
});

import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readDaemonFile } from '../src/daemon-file.js';
import { startDaemon } from '../src/daemon.js';
import { CSP } from '../src/server/headers.js';
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

  it('fails clearly when the port is taken', async () => {
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r));
    const port = (blocker.address() as AddressInfo).port;
    await expect(startDaemon({ port, dataDir: await tmp('shq-data-'), claudeDir: await tmp('shq-claude-'), watchFiles: false, log: quiet }))
      .rejects.toMatchObject({ code: 'EADDRINUSE' });
    await new Promise<void>((r) => blocker.close(() => r()));
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

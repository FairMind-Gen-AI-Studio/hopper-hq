import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

// No test may run the real tmux: the module that would spawn it is replaced for this whole file.
vi.mock('node:child_process', () => ({ execFile: vi.fn() }));

import { execFile } from 'node:child_process';
import { Collector } from '../../src/collector.js';
import type { RawEvent, Workspace } from '../../src/core/types.js';
import { readDaemonFile } from '../../src/daemon-file.js';
import { startDaemon } from '../../src/daemon.js';
import { UiAuth } from '../../src/server/auth.js';
import { simulatedFocusDriver, tmuxFocusDriver, type FocusDriver, type FocusOutcome, type TmuxRunner } from '../../src/server/focus.js';
import { createApiServer } from '../../src/server/http.js';
import { bearer, call, close, listen } from '../helpers/http.js';

type Reply = { code: number; stdout?: string; stderr?: string };

/** A runner that answers by tmux subcommand and records every argument vector. */
function fakeTmux(replies: Record<string, Reply>) {
  const calls: string[][] = [];
  const run: TmuxRunner = async (args) => {
    calls.push(args);
    const r = replies[args[0]!] ?? { code: 0 };
    return { code: r.code, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
  return { run, calls };
}

const CLIENTS = '1791700000 /dev/ttys001\n1791700100 /dev/ttys004\n1791699999 /dev/pts/2\n';
const LIST = ['list-clients', '-F', '#{client_activity} #{client_tty}'];

beforeEach(() => {
  vi.mocked(execFile).mockReset();
});

describe('tmuxFocusDriver', () => {
  it('switches the most recently active client to the pane', async () => {
    const t = fakeTmux({ 'list-clients': { code: 0, stdout: CLIENTS } });
    const driver = tmuxFocusDriver(t.run);
    expect(driver.simulated).toBe(false);
    expect(await driver.focus('%7')).toEqual({ ok: true });
    expect(t.calls).toEqual([
      LIST,
      ['switch-client', '-c', '/dev/ttys004', '-t', '%7'],
      ['select-window', '-t', '%7'],
      ['select-pane', '-t', '%7'],
    ]);
  });

  it('skips clients whose tty does not look like a device path', async () => {
    const t = fakeTmux({ 'list-clients': { code: 0, stdout: '1791700200 /dev/tty;id\n1791700300 not-a-tty\n1791700100 /dev/ttys004\n' } });
    expect(await tmuxFocusDriver(t.run).focus('%7')).toEqual({ ok: true });
    expect(t.calls[1]).toEqual(['switch-client', '-c', '/dev/ttys004', '-t', '%7']);
  });

  it('reports no_client when nothing is attached or tmux is not running', async () => {
    for (const reply of [{ code: 0, stdout: '' }, { code: 1, stderr: 'no server running on /tmp/tmux-501/default' }, { code: 0, stdout: 'garbage\n' }]) {
      const t = fakeTmux({ 'list-clients': reply });
      expect(await tmuxFocusDriver(t.run).focus('%7')).toEqual({ ok: false, reason: 'no_client' });
      expect(t.calls).toEqual([LIST]);
    }
  });

  it('rejects a malformed pane before running anything', async () => {
    for (const pane of ['7', '%', '%7;rm', 'x:@1.%7', '%7 ', '-t%7']) {
      const t = fakeTmux({});
      expect(await tmuxFocusDriver(t.run).focus(pane)).toEqual({ ok: false, reason: 'invalid_pane' });
      expect(t.calls).toEqual([]);
    }
  });

  it('reports tmux_failed when switch-client fails, and stops there', async () => {
    const t = fakeTmux({ 'list-clients': { code: 0, stdout: CLIENTS }, 'switch-client': { code: 1, stderr: "can't find pane: %7" } });
    expect(await tmuxFocusDriver(t.run).focus('%7')).toEqual({ ok: false, reason: 'tmux_failed' });
    expect(t.calls).toHaveLength(2);
  });

  it('reports tmux_failed when select-pane fails, and ignores select-window', async () => {
    const paneFails = fakeTmux({ 'list-clients': { code: 0, stdout: CLIENTS }, 'select-pane': { code: 1 } });
    expect(await tmuxFocusDriver(paneFails.run).focus('%7')).toEqual({ ok: false, reason: 'tmux_failed' });
    const windowFails = fakeTmux({ 'list-clients': { code: 0, stdout: CLIENTS }, 'select-window': { code: 1 } });
    expect(await tmuxFocusDriver(windowFails.run).focus('%7')).toEqual({ ok: true });
  });

  it('never reaches the default runner when a runner is injected', async () => {
    await tmuxFocusDriver(fakeTmux({ 'list-clients': { code: 0, stdout: CLIENTS } }).run).focus('%7');
    expect(execFile).not.toHaveBeenCalled();
  });

  it('runs tmux through execFile with a timeout by default', async () => {
    vi.mocked(execFile).mockImplementation(((_file: string, args: string[], _opts: object, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      cb(null, args[0] === 'list-clients' ? CLIENTS : '', '');
    }) as unknown as typeof execFile);
    expect(await tmuxFocusDriver().focus('%7')).toEqual({ ok: true });
    expect(vi.mocked(execFile).mock.calls.map((c) => [c[0], c[1], c[2]])).toEqual([
      ['tmux', LIST, { timeout: 2000 }],
      ['tmux', ['switch-client', '-c', '/dev/ttys004', '-t', '%7'], { timeout: 2000 }],
      ['tmux', ['select-window', '-t', '%7'], { timeout: 2000 }],
      ['tmux', ['select-pane', '-t', '%7'], { timeout: 2000 }],
    ]);
  });

  it('reports no_client when tmux is not installed', async () => {
    vi.mocked(execFile).mockImplementation(((_file: string, _args: string[], _opts: object, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      cb(Object.assign(new Error('spawn tmux ENOENT'), { code: 'ENOENT' }), '', '');
    }) as unknown as typeof execFile);
    expect(await tmuxFocusDriver().focus('%7')).toEqual({ ok: false, reason: 'no_client' });
  });
});

describe('simulatedFocusDriver', () => {
  it('says it is simulated, checks the pane, and runs nothing', async () => {
    expect(simulatedFocusDriver.simulated).toBe(true);
    expect(await simulatedFocusDriver.focus('%7')).toEqual({ ok: true });
    expect(await simulatedFocusDriver.focus('7')).toEqual({ ok: false, reason: 'invalid_pane' });
    expect(execFile).not.toHaveBeenCalled();
  });
});

describe('POST /api/focus', () => {
  const TOKEN = 'h'.repeat(48);
  const T0 = 1_791_700_000_000;
  const ws = (cwd: string): Workspace => ({ cwd, repoRoot: cwd, repoName: basename(cwd), worktree: false, branch: 'main' });
  const seenIn = (sessionId: string, tmuxPane: string | null): RawEvent => ({
    type: 'session.seen', sessionId, ts: T0 - 5000, source: 'hook', cwd: '/w/orders-api', workspace: ws('/w/orders-api'), pid: null, name: null, tmuxPane, startedAt: T0 - 5000,
  });
  const waiting = (sessionId: string): RawEvent => ({ type: 'waiting', sessionId, ts: T0 - 4000, source: 'hook', cwd: '/w/orders-api', reason: { kind: 'permission', text: 'Bash' }, agentId: null });

  let collector: Collector;
  let auth: UiAuth;
  const panes: string[] = [];
  let outcome: FocusOutcome = { ok: true };
  const driver: FocusDriver = {
    simulated: false,
    focus: async (pane) => {
      panes.push(pane);
      return outcome;
    },
  };
  let server: Server;
  let port: number;

  beforeAll(async () => {
    collector = new Collector({ resolveWorkspace: async (cwd) => ws(cwd), saveDelayMs: 0, now: () => T0 });
    for (const e of [seenIn('LOCAL', '%7'), waiting('LOCAL'), waiting('NOPANE'), seenIn('ENDED', '%8')]) void collector.ingest(e);
    void collector.ingest({ type: 'session.ended', sessionId: 'ENDED', ts: T0 - 3000, source: 'hook', reason: 'exit' });
    await collector.idle();
    auth = new UiAuth({ token: TOKEN, now: () => T0 });
    server = createApiServer({ collector, token: TOKEN, auth, focus: driver });
    port = await listen(server);
  });
  afterAll(() => close(server));
  beforeEach(() => {
    panes.length = 0;
    outcome = { ok: true };
  });

  const focus = (body: string, headers: Record<string, string> = bearer(TOKEN)) =>
    call(port, { method: 'POST', path: '/api/focus', headers: { 'content-type': 'application/json', ...headers }, body });

  it("switches to the session's own pane, whatever the request says", async () => {
    const r = await focus(JSON.stringify({ sessionId: 'LOCAL', pane: '%99' }));
    expect(r).toMatchObject({ status: 200, json: { pane: '%7', simulated: false } });
    expect(panes).toEqual(['%7']);
  });

  it('says when the driver only simulates', async () => {
    const demo = createApiServer({ collector, token: TOKEN, focus: simulatedFocusDriver });
    const demoPort = await listen(demo);
    const r = await call(demoPort, { method: 'POST', path: '/api/focus', headers: { ...bearer(TOKEN), 'content-type': 'application/json' }, body: '{"sessionId":"LOCAL"}' });
    await close(demo);
    expect(r).toMatchObject({ status: 200, json: { pane: '%7', simulated: true } });
    expect(execFile).not.toHaveBeenCalled();
  });

  it('answers 404 for an unknown session', async () => {
    expect(await focus('{"sessionId":"NOBODY"}')).toMatchObject({ status: 404, json: { error: 'No such session' } });
  });

  it('answers 409 for a session that ended, runs elsewhere or has no pane', async () => {
    expect((await focus('{"sessionId":"ENDED"}')).status).toBe(409);
    expect((await focus('{"sessionId":"NOPANE"}')).status).toBe(409);
    const local = collector.view('LOCAL')!;
    const spy = vi.spyOn(collector, 'view').mockReturnValueOnce({ ...local, location: 'cloud' });
    expect((await focus('{"sessionId":"LOCAL"}')).status).toBe(409);
    spy.mockRestore();
    expect(panes).toEqual([]);
  });

  it("maps the driver's failures", async () => {
    outcome = { ok: false, reason: 'no_client' };
    expect(await focus('{"sessionId":"LOCAL"}')).toMatchObject({ status: 409, json: { error: 'No tmux client is attached' } });
    outcome = { ok: false, reason: 'invalid_pane' };
    expect((await focus('{"sessionId":"LOCAL"}')).status).toBe(409);
    outcome = { ok: false, reason: 'tmux_failed' };
    expect(await focus('{"sessionId":"LOCAL"}')).toMatchObject({ status: 502, json: { error: 'tmux could not switch to the pane' } });
  });

  it('answers 415 to a body that is not JSON', async () => {
    expect((await call(port, { method: 'POST', path: '/api/focus', headers: { ...bearer(TOKEN), 'content-type': 'text/plain' }, body: '{"sessionId":"LOCAL"}' })).status).toBe(415);
    expect((await call(port, { method: 'POST', path: '/api/focus', headers: bearer(TOKEN), body: '{"sessionId":"LOCAL"}' })).status).toBe(415);
    expect(panes).toEqual([]);
  });

  it('answers 400 to a bad body, including one over 1 KB', async () => {
    const bodies = ['{oops', '', 'null', '[]', '{}', '{"sessionId":5}', '{"sessionId":""}', JSON.stringify({ sessionId: 'LOCAL', pad: 'x'.repeat(1100) })];
    for (const body of bodies) expect([body.slice(0, 20), (await focus(body)).status]).toEqual([body.slice(0, 20), 400]);
    expect((await focus('{"sessionId":"LOCAL"}', { ...bearer(TOKEN), 'content-type': 'application/json; charset=utf-8' })).status).toBe(200);
    expect(panes).toEqual(['%7']);
  });

  it('takes the browser cookie only with this origin', async () => {
    const cookie = auth.cookie(port).split(';')[0]!;
    expect((await focus('{"sessionId":"LOCAL"}', { cookie })).status).toBe(403);
    expect((await focus('{"sessionId":"LOCAL"}', { cookie, origin: `http://127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin' })).status).toBe(200);
    expect((await focus('{"sessionId":"LOCAL"}', {})).status).toBe(401);
    expect(panes).toEqual(['%7']);
  });
});

describe('the demo daemon', () => {
  it('only simulates tmux focus', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'shq-data-'));
    const d = await startDaemon({ demo: true, port: 0, dataDir, log: () => {} });
    for (let i = 0; i < 100 && !d.collector.view('demo-oa-c3'); i++) await new Promise((r) => setTimeout(r, 10));
    const r = await call(d.port, {
      method: 'POST',
      path: '/api/focus',
      headers: { ...bearer((await readDaemonFile(dataDir))!.token), 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'demo-oa-c3' }),
    });
    await d.stop();
    expect(r).toMatchObject({ status: 200, json: { pane: '%7', simulated: true } });
    expect(execFile).not.toHaveBeenCalled();
  });
});

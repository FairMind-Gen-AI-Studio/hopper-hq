import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, type Io } from '../src/cli.js';
import { startDaemon, type RunningDaemon } from '../src/daemon.js';
import { call } from './helpers/http.js';

let d: RunningDaemon;
let dataDir: string;

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (l) => out.push(l), err: (l) => err.push(l) };
  return { io, out, err };
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'shq-cli-'));
  d = await startDaemon({ port: 0, dataDir, claudeDir: await mkdtemp(join(tmpdir(), 'shq-claude-')), watchFiles: false, log: () => {} });
  await d.collector.ingest({ type: 'waiting', sessionId: 'S1', ts: Date.now(), source: 'hook', cwd: '/w/orders-api', reason: { kind: 'permission', text: 'Bash', detail: 'Bash: rm -rf dist' }, agentId: null });
  await d.collector.idle();
});
afterAll(() => d.stop());

describe('cli', () => {
  it('status --format tmux prints the counters', async () => {
    const c = capture();
    expect(await main(['status', '--format', 'tmux', '--data-dir', dataDir], c.io)).toBe(0);
    expect(c.out).toEqual(['#[fg=colour203,bold]◉1#[default]']);
  });

  it('status prints text and json', async () => {
    const t = capture();
    expect(await main(['status', '--data-dir', dataDir], t.io)).toBe(0);
    expect(t.out[0]).toContain('Bash (Bash: rm -rf dist)');
    const j = capture();
    expect(await main(['status', '--format', 'json', '--data-dir', dataDir], j.io)).toBe(0);
    expect(JSON.parse(j.out[0]!)).toMatchObject({ needsYou: 1, done: 0 });
  });

  it('ls prints the building', async () => {
    const c = capture();
    expect(await main(['ls', '--data-dir', dataDir], c.io)).toBe(0);
    expect(c.out[0]).toContain('orders-api  (department)');
    expect(c.out[0]).toContain('needs you');
  });

  it('ack marks finished sessions as seen', async () => {
    await d.collector.ingest({ type: 'turn.finished', sessionId: 'S2', ts: Date.now(), source: 'hook', cwd: '/w/orders-api', backgroundTasks: 0 });
    await d.collector.ingest({ type: 'turn.finished', sessionId: 'S3', ts: Date.now(), source: 'hook', cwd: '/w/orders-api', backgroundTasks: 0 });
    await d.collector.idle();
    const one = capture();
    expect(await main(['ack', 'S2', '--data-dir', dataDir], one.io)).toBe(0);
    expect(one.out).toEqual(['Marked S2 as seen.']);
    const missing = capture();
    expect(await main(['ack', 'S2', '--data-dir', dataDir], missing.io)).toBe(1);
    expect(missing.err).toEqual(['No finished session with id S2.']);
    const all = capture();
    expect(await main(['ack', '--data-dir', dataDir], all.io)).toBe(0);
    expect(all.out).toEqual(['Marked 1 session as seen.']);
  });

  it('reports a daemon that is not running', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'shq-none-'));
    const tmux = capture();
    expect(await main(['status', '--format', 'tmux', '--data-dir', empty], tmux.io)).toBe(0);
    expect(tmux.out).toEqual(['']);
    const text = capture();
    expect(await main(['status', '--data-dir', empty], text.io)).toBe(1);
    expect(text.err[0]).toContain('not running');
  });

  it('prints help and rejects unknown commands and options', async () => {
    const h = capture();
    expect(await main(['--help'], h.io)).toBe(0);
    expect(h.out[0]).toContain('Usage');
    expect(await main(['bogus'], capture().io)).toBe(2);
    expect(await main(['status', '--bogus'], capture().io)).toBe(2);
    expect(await main(['status', '--format', 'xml'], capture().io)).toBe(2);
  });
});

/** Lets a test end a long-running command (start, demo) once it has printed everything. */
function stopper() {
  let stop!: () => void;
  let ready!: () => void;
  const stopped = new Promise<void>((r) => (stop = r));
  const started = new Promise<void>((r) => (ready = r));
  return {
    stop,
    started,
    untilStopped: () => {
      ready();
      return stopped;
    },
  };
}

/** Follows a printed sign-in link the way a browser would. */
async function follow(link: string) {
  const url = new URL(link);
  return call(Number(url.port), { path: url.pathname + url.search });
}

describe('cli ui', () => {
  it('prints a one-time sign-in link that sets the cookie', async () => {
    const c = capture();
    expect(await main(['ui', '--no-open', '--data-dir', dataDir], c.io)).toBe(0);
    expect(c.out).toHaveLength(1);
    expect(c.out[0]).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${d.port}/ui/login\\?code=[0-9a-f]{48}$`));
    expect(c.err.join('\n')).toContain('works once');
    const r = await follow(c.out[0]!);
    expect(r.status).toBe(303);
    expect(r.headers['set-cookie']![0]).toMatch(new RegExp(`^shq_${d.port}=`));
    expect((await follow(c.out[0]!)).status).toBe(401);
  });

  it('opens the link in the browser unless told not to', async () => {
    const opened: string[] = [];
    const open = async (url: string) => {
      opened.push(url);
    };
    const c = capture();
    expect(await main(['ui', '--data-dir', dataDir], { ...c.io, open })).toBe(0);
    expect(opened).toEqual(c.out);
    expect(await main(['ui', '--no-open', '--data-dir', dataDir], { ...capture().io, open })).toBe(0);
    expect(opened).toHaveLength(1);
  });

  it('reports a daemon that is not running', async () => {
    const c = capture();
    expect(await main(['ui', '--data-dir', await mkdtemp(join(tmpdir(), 'shq-none-'))], c.io)).toBe(1);
    expect(c.err[0]).toContain('not running');
    expect(c.out).toEqual([]);
  });

  it('is listed in the help', async () => {
    const h = capture();
    await main(['--help'], h.io);
    expect(h.out[0]).toContain('scranton-hq ui [--no-open] [--data-dir DIR]');
  });
});

describe('cli start and demo', () => {
  it('start points at the ui command', async () => {
    const s = stopper();
    const c = capture();
    const run = main(['start', '--port', '0', '--no-watch', '--data-dir', await mkdtemp(join(tmpdir(), 'shq-start-')), '--claude-dir', await mkdtemp(join(tmpdir(), 'shq-claude-'))], { ...c.io, untilStopped: s.untilStopped });
    await s.started;
    expect(c.err.join('\n')).toContain('scranton-hq ui');
    s.stop();
    expect(await run).toBe(0);
  });

  it('demo prints a sign-in link that works', async () => {
    const s = stopper();
    const c = capture();
    const run = main(['demo', '--port', '0', '--data-dir', await mkdtemp(join(tmpdir(), 'shq-demo-'))], { ...c.io, untilStopped: s.untilStopped });
    await s.started;
    const link = c.err.join('\n').match(/http:\/\/127\.0\.0\.1:\d+\/ui\/login\?code=[0-9a-f]{48}/)?.[0];
    expect(link).toBeDefined();
    expect(c.err.join('\n')).toContain('10 minutes');
    expect((await follow(link!)).status).toBe(303);
    s.stop();
    expect(await run).toBe(0);
  });
});

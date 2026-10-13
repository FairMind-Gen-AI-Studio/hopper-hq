import { describe, expect, it, vi } from 'vitest';
import { spawn, type SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { writeSync } from 'node:fs';
import { appendFile, mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { main, type Background, type Clock, type Io } from '../src/cli.js';
import { readDaemonFile, writeDaemonFile } from '../src/daemon-file.js';
import { lockDataDir } from '../src/daemon-lock.js';
import { close, listen } from './helpers/http.js';

// No test here starts a process: the default way up starts the daemon is this mock, and the other tests stand in for it.
vi.mock('node:child_process', async (importOriginal) => ({ ...(await importOriginal<typeof import('node:child_process')>()), spawn: vi.fn() }));

const tmp = (prefix: string) => mkdtemp(join(tmpdir(), prefix));
const LINK = /^http:\/\/127\.0\.0\.1:\d+\/ui\/login\?code=[0-9a-f]{48}$/;

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (l) => out.push(l), err: (l) => err.push(l) };
  return { io, out, err };
}

/** A clock whose sleeps pass at once. */
function fakeClock(): Clock & { slept: () => number } {
  let now = 0;
  return { now: () => now, sleep: async (ms) => void (now += ms), slept: () => now };
}

/** Stands in for the background process: `start` with up's arguments, run in this process until stopped. */
function background() {
  const calls: { args: string[]; log: string }[] = [];
  const runs: { run: Promise<number>; stop: () => void }[] = [];
  const start = (args: string[], log: string) => {
    let stop!: () => void;
    let ready!: () => void;
    const stopped = new Promise<void>((r) => (stop = r));
    const listening = new Promise<void>((r) => (ready = r));
    const io: Io = { out: () => {}, err: (l) => void appendFile(log, l + '\n'), untilStopped: () => (ready(), stopped) };
    const run = main(['start', '--no-watch', ...args], io);
    runs.push({ run, stop });
    return { listening, background: { exited: run.then(() => {}, () => {}), stop } satisfies Background };
  };
  return {
    calls,
    start,
    spawnDaemon: async (args: string[], log: string): Promise<Background> => {
      calls.push({ args, log });
      return start(args, log).background;
    },
    stopAll: async () => {
      for (const r of runs) {
        r.stop();
        await r.run;
      }
    },
  };
}

describe('up', () => {
  it('starts the daemon in the background and signs the browser in, then finds it running the next time', async () => {
    const dataDir = await tmp('shq-up-');
    const claudeDir = await tmp('shq-claude-');
    const log = join(dataDir, 'daemon.log');
    const bg = background();
    const opened: string[] = [];
    const open = async (url: string) => void opened.push(url);
    try {
      const first = capture();
      expect(await main(['up', '--port', '0', '--data-dir', dataDir, '--claude-dir', claudeDir], { ...first.io, open, spawnDaemon: bg.spawnDaemon })).toBe(0);
      expect(bg.calls).toEqual([{ args: ['--data-dir', dataDir, '--port', '0', '--claude-dir', claudeDir], log }]);
      expect(first.err).toEqual([
        `Started scranton-hq in the background. Its log is ${log}`,
        `Stop it with: scranton-hq down --data-dir ${dataDir}`,
        'This link signs your browser in. It works once, within 1 minute:',
      ]);
      expect(first.out).toEqual([expect.stringMatching(LINK)]);
      expect(new URL(first.out[0]!).port).toBe(String((await readDaemonFile(dataDir))!.port));
      expect(opened).toEqual(first.out);

      const again = capture();
      expect(await main(['up', '--no-open', '--data-dir', dataDir], { ...again.io, open, spawnDaemon: bg.spawnDaemon })).toBe(0);
      expect(bg.calls).toHaveLength(1);
      expect(again.err[0]).toBe('scranton-hq is already running.');
      expect(again.out).toEqual([expect.stringMatching(LINK)]);
      expect(opened).toHaveLength(1);
    } finally {
      await bg.stopAll();
    }
  });

  it('says so when the daemon that answers is older than up, and starts nothing', async () => {
    const dataDir = await tmp('shq-up-');
    const server = createServer((req, res) => res.writeHead(req.url === '/api/health' ? 200 : 404, { 'content-type': 'application/json' }).end('{}'));
    const port = await listen(server);
    await writeDaemonFile(dataDir, { port, token: 't'.repeat(48), pid: 4242, startedAt: 0 });
    const bg = background();
    try {
      const c = capture();
      expect(await main(['up', '--no-open', '--data-dir', dataDir], { ...c.io, spawnDaemon: bg.spawnDaemon })).toBe(1);
      expect(c.err).toEqual([
        'scranton-hq is already running.',
        'This scranton-hq daemon (process 4242) is older than the up command. Stop it with Ctrl-C where it runs, then run scranton-hq up again.',
      ]);
      expect(c.out).toEqual([]);
      expect(bg.calls).toEqual([]);
    } finally {
      await close(server);
    }
  });

  it('says why when the daemon stops while starting, with only what it wrote this time', async () => {
    const dataDir = await tmp('shq-up-');
    const log = join(dataDir, 'daemon.log');
    await writeFile(log, 'an earlier run\n');
    const spawnDaemon = async (_args: string[], to: string): Promise<Background> => {
      await appendFile(to, 'Port 7337 is already in use. Is scranton-hq already running? Check with: scranton-hq status\n\u001b]0;title\u0007\n');
      return { exited: Promise.resolve(), stop: () => {} };
    };
    const c = capture();
    expect(await main(['up', '--data-dir', dataDir], { ...c.io, spawnDaemon })).toBe(1);
    expect(c.err).toEqual([
      'scranton-hq stopped while starting.',
      '  Port 7337 is already in use. Is scranton-hq already running? Check with: scranton-hq status',
      '  ]0;title',
      `Its log is ${log}`,
    ]);
    expect(c.out).toEqual([]);
  });

  it('gives up after 10 seconds, and stops the daemon it started', async () => {
    const dataDir = await tmp('shq-up-');
    let stopped = 0;
    const spawnDaemon = async (): Promise<Background> => ({ exited: new Promise(() => {}), stop: () => void stopped++ });
    const clock = fakeClock();
    const c = capture();
    expect(await main(['up', '--data-dir', dataDir], { ...c.io, spawnDaemon, clock })).toBe(1);
    expect(stopped).toBe(1);
    expect(clock.slept()).toBe(10_000);
    expect(c.err).toEqual(['scranton-hq did not answer within 10 seconds.', `Its log is ${join(dataDir, 'daemon.log')}`]);
  });

  it('waits for a daemon another up started first, while that one holds the data directory', async () => {
    const dataDir = await tmp('shq-up-');
    const claudeDir = await tmp('shq-claude-');
    const other = await lockDataDir(dataDir);
    const bg = background();
    let sleeps = 0;
    const clock: Clock = {
      now: Date.now,
      sleep: async (ms) => {
        // A few looks in, the other daemon is up.
        if (++sleeps === 3) {
          other.release();
          await bg.start(['--port', '0', '--data-dir', dataDir, '--claude-dir', claudeDir], join(dataDir, 'daemon.log')).listening;
        }
        await new Promise((r) => setTimeout(r, ms));
      },
    };
    // This up's own daemon finds the directory taken, and exits.
    const spawnDaemon = async (): Promise<Background> => ({ exited: Promise.resolve(), stop: () => {} });
    try {
      const c = capture();
      expect(await main(['up', '--no-open', '--data-dir', dataDir], { ...c.io, spawnDaemon, clock })).toBe(0);
      expect(c.out).toEqual([expect.stringMatching(LINK)]);
      expect(sleeps).toBe(3);
    } finally {
      other.release();
      await bg.stopAll();
    }
  });

  it('checks the port before it starts anything', async () => {
    const spawnDaemon = vi.fn();
    const c = capture();
    expect(await main(['up', '--port', '70000', '--data-dir', await tmp('shq-up-')], { ...c.io, spawnDaemon })).toBe(2);
    expect(c.err[0]).toBe('Invalid port: 70000');
    expect(spawnDaemon).not.toHaveBeenCalled();
  });

  it('is what the other commands point at when nothing runs, and is listed in the help', async () => {
    const empty = await tmp('shq-none-');
    for (const cmd of ['status', 'ls', 'ack', 'ui']) {
      const c = capture();
      expect(await main([cmd, '--data-dir', empty], c.io)).toBe(1);
      expect(c.err).toEqual(['scranton-hq is not running. Start it with: scranton-hq up']);
    }
    const h = capture();
    await main(['--help'], h.io);
    expect(h.out[0]).toContain('scranton-hq up [--port N] [--no-open] [--claude-dir DIR] [--data-dir DIR]');
  });
});

describe('up on its own', () => {
  type Child = EventEmitter & { unref: () => void; kill: () => boolean };
  const child = (): Child => Object.assign(new EventEmitter(), { unref: vi.fn(), kill: vi.fn(() => true) });

  it('starts this CLI detached, with no pipe to this process, its output appended to a private log', async () => {
    const dataDir = await tmp('shq-up-');
    const log = join(dataDir, 'daemon.log');
    const c = child();
    vi.mocked(spawn).mockImplementationOnce(((_file: string, _args: string[], options: SpawnOptions) => {
      writeSync((options.stdio as number[])[2]!, 'listening\n');
      return c;
    }) as never);
    const out = capture();
    expect(await main(['up', '--port', '0', '--data-dir', dataDir], { ...out.io, clock: fakeClock() })).toBe(1);
    const [file, argv, options] = vi.mocked(spawn).mock.lastCall as unknown as [string, string[], SpawnOptions];
    expect(file).toBe(process.execPath);
    expect(argv).toEqual([fileURLToPath(new URL('../src/bin.js', import.meta.url)), 'start', '--data-dir', dataDir, '--port', '0']);
    expect(options).toEqual({ cwd: dataDir, detached: true, stdio: ['ignore', expect.any(Number), expect.any(Number)] });
    expect((options.stdio as number[])[1]).toBe((options.stdio as number[])[2]);
    expect(c.unref).toHaveBeenCalledTimes(1);
    expect(c.kill).toHaveBeenCalledTimes(1);
    expect((await stat(log)).mode & 0o077).toBe(0);
    expect(out.err).toEqual(['scranton-hq did not answer within 10 seconds.', '  listening', `Its log is ${log}`]);
  });

  it('notices a daemon that exits, or never starts', async () => {
    for (const end of [(c: Child) => c.emit('exit', 1, null), (c: Child) => c.emit('error', new Error('spawn EACCES'))]) {
      const c = child();
      vi.mocked(spawn).mockImplementationOnce((() => (setImmediate(() => end(c)), c)) as never);
      const out = capture();
      expect(await main(['up', '--data-dir', await tmp('shq-up-')], out.io)).toBe(1);
      expect(out.err[0]).toBe('scranton-hq stopped while starting.');
      expect(c.kill).not.toHaveBeenCalled();
    }
  });
});

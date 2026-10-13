import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { createServer, type RequestListener } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, type Clock, type Io } from '../src/cli.js';
import { readDaemonFile, writeDaemonFile } from '../src/daemon-file.js';
import { dataDirInUse, lockDataDir } from '../src/daemon-lock.js';
import { close, listen } from './helpers/http.js';

const tmp = (prefix: string) => mkdtemp(join(tmpdir(), prefix));

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

/** `scranton-hq start` in this process, on a fresh data directory. `stop` ends it the way a signal would. */
async function started() {
  const dataDir = await tmp('shq-down-');
  let stop!: () => void;
  let ready!: () => void;
  const stopped = new Promise<void>((r) => (stop = r));
  const up = new Promise<void>((r) => (ready = r));
  const args = ['start', '--port', '0', '--no-watch', '--data-dir', dataDir, '--claude-dir', await tmp('shq-claude-')];
  const run = main(args, { out: () => {}, err: () => {}, untilStopped: () => (ready(), stopped) });
  await up;
  return { dataDir, run, stop };
}

/** A data directory whose daemon file points at a server of the test's, or at a port nothing listens on. */
async function pointedAt(answer: RequestListener | null) {
  const dataDir = await tmp('shq-down-');
  const server = createServer(answer ?? (() => {}));
  const port = await listen(server);
  if (!answer) await close(server);
  await writeDaemonFile(dataDir, { port, token: 't'.repeat(48), pid: 4242, startedAt: 0 });
  return { dataDir, done: () => (answer ? close(server) : Promise.resolve()) };
}

describe('down', () => {
  it('asks the daemon to stop, waits until it has, and leaves the data directory free', async () => {
    const d = await started();
    try {
      const c = capture();
      expect(await main(['down', '--data-dir', d.dataDir], c.io)).toBe(0);
      expect(c.err).toEqual(['scranton-hq has stopped.']);
      expect(await readDaemonFile(d.dataDir)).toBeNull();
      expect(await dataDirInUse(d.dataDir)).toBe(false);
      expect(await d.run).toBe(0);
    } finally {
      d.stop();
      await d.run;
    }
  });

  it('says so when nothing runs', async () => {
    const c = capture();
    expect(await main(['down', '--data-dir', await tmp('shq-none-')], c.io)).toBe(0);
    expect(c.err).toEqual(['scranton-hq is not running.']);
  });

  it('takes a daemon file that nothing answers for, and no daemon holds, as left over', async () => {
    const d = await pointedAt(null);
    const c = capture();
    expect(await main(['down', '--data-dir', d.dataDir], c.io)).toBe(0);
    expect(c.err).toEqual(['scranton-hq is not running.']);
  });

  it('names the process, and leaves it alone, when a daemon holds the directory but does not answer', async () => {
    const d = await pointedAt(null);
    const lock = await lockDataDir(d.dataDir);
    try {
      const c = capture();
      expect(await main(['down', '--data-dir', d.dataDir], c.io)).toBe(1);
      expect(c.err).toEqual([`scranton-hq does not answer, but it still holds ${d.dataDir}. Its daemon file names process 4242.`]);
      expect(await readDaemonFile(d.dataDir)).not.toBeNull();
    } finally {
      lock.release();
    }
  });

  it('names the lock file it cannot open, rather than treating the directory as free', async () => {
    const d = await pointedAt(null);
    await mkdir(join(d.dataDir, 'daemon.lock'));
    const c = capture();
    expect(await main(['down', '--data-dir', d.dataDir], c.io)).toBe(1);
    expect(c.err).toEqual([`Cannot read ${join(d.dataDir, 'daemon.lock')}: unable to open database file. Check its owner and permissions.`]);
  });

  it('leaves a daemon older than down alone, and says how to stop it', async () => {
    const d = await pointedAt((_req, res) => res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"Not found"}'));
    try {
      const c = capture();
      expect(await main(['down', '--data-dir', d.dataDir], c.io)).toBe(1);
      expect(c.err).toEqual(['This scranton-hq daemon (process 4242) is older than the down command. Stop it with Ctrl-C where it runs.']);
    } finally {
      await d.done();
    }
  });

  it('gives up after 10 seconds when the daemon does not stop', async () => {
    const d = await pointedAt((_req, res) => res.writeHead(202).end());
    try {
      const c = capture();
      const clock = fakeClock();
      expect(await main(['down', '--data-dir', d.dataDir], { ...c.io, clock })).toBe(1);
      expect(c.err).toEqual([`scranton-hq is still stopping. Check again with: scranton-hq status --data-dir ${d.dataDir}`]);
      expect(clock.slept()).toBe(10_000);
    } finally {
      await d.done();
    }
  });

  it('is listed in the help', async () => {
    const h = capture();
    await main(['--help'], h.io);
    expect(h.out[0]).toContain('scranton-hq down [--data-dir DIR]');
  });
});

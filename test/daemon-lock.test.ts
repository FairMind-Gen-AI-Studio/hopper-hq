import { describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { daemonFilePath, readDaemonFile, removeDaemonFile, writeDaemonFile } from '../src/daemon-file.js';
import { dataDirInUse, DataDirInUseError, lockDataDir } from '../src/daemon-lock.js';
import { startDaemon } from '../src/daemon.js';
import { close, listen } from './helpers/http.js';

// The daemon's own removeDaemonFile, which a test can watch.
vi.mock('../src/daemon-file.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/daemon-file.js')>();
  return { ...real, removeDaemonFile: vi.fn(real.removeDaemonFile) };
});

const tmp = () => mkdtemp(join(tmpdir(), 'shq-lock-'));
const quiet = () => {};

/** Takes the lock in another process and holds it until killed. */
const HOLDER = `
const { DatabaseSync } = require('node:sqlite');
new DatabaseSync(process.argv[1]).exec('BEGIN EXCLUSIVE');
process.stdout.write('held\\n');
setInterval(() => {}, 60000);
`;

/** Calls lockDataDir itself in another process, at the given moment, and says how it went. A winner holds on until killed. */
const RACER = `
import { DataDirInUseError, lockDataDir } from ${JSON.stringify(pathToFileURL(fileURLToPath(new URL('../src/daemon-lock.ts', import.meta.url))).href)};
const [, dataDir, at] = process.argv;
while (Date.now() < Number(at));
try {
  await lockDataDir(dataDir);
  process.stdout.write('won\\n');
  setInterval(() => {}, 60000);
} catch (err) {
  process.stdout.write(err instanceof DataDirInUseError ? 'lost\\n' : 'failed\\n');
}
`;

describe('lockDataDir', () => {
  it('lets one holder at a time take the data directory, and keeps the lock file private', async () => {
    const dataDir = await tmp();
    const lock = await lockDataDir(dataDir);
    expect(await readdir(dataDir)).toEqual(['daemon.lock']);
    expect((await stat(join(dataDir, 'daemon.lock'))).mode & 0o077).toBe(0);
    await expect(lockDataDir(dataDir)).rejects.toThrow(new DataDirInUseError(dataDir));
    expect(await dataDirInUse(dataDir)).toBe(true);
    lock.release();
    lock.release();
    expect(await dataDirInUse(dataDir)).toBe(false);
    // Asking leaves the directory free.
    expect(await dataDirInUse(dataDir)).toBe(false);
    (await lockDataDir(dataDir)).release();
  });

  it('is held across processes until the holder ends, however it ends', async () => {
    const dataDir = await tmp();
    const holder = spawn(process.execPath, ['--no-warnings', '-e', HOLDER, join(dataDir, 'daemon.lock')], { stdio: ['ignore', 'pipe', 'ignore'] });
    const exited = new Promise<void>((resolve) => holder.once('exit', () => resolve()));
    try {
      await new Promise<void>((resolve, reject) => {
        holder.stdout.once('data', () => resolve());
        void exited.then(() => reject(new Error('the holder exited')));
      });
      await expect(lockDataDir(dataDir)).rejects.toThrow(DataDirInUseError);
      expect(await dataDirInUse(dataDir)).toBe(true);
      holder.kill('SIGKILL');
      await exited;
      expect(await dataDirInUse(dataDir)).toBe(false);
    } finally {
      holder.kill('SIGKILL');
    }
  });

  it('lets exactly one of several processes that try at the same moment take it', async () => {
    const dataDir = await tmp();
    const at = String(Date.now() + 1000);
    const racers = Array.from({ length: 4 }, () =>
      spawn(process.execPath, ['--no-warnings', '--experimental-strip-types', '--input-type=module', '-e', RACER, dataDir, at], { stdio: ['ignore', 'pipe', 'ignore'] }),
    );
    try {
      const said = await Promise.all(
        racers.map((r) => new Promise<string>((resolve) => {
          let out = '';
          r.stdout.on('data', (chunk: Buffer) => {
            out += chunk.toString();
            if (out.endsWith('\n')) resolve(out.trim());
          });
          r.once('exit', () => resolve(out.trim()));
        })),
      );
      expect(said.sort()).toEqual(['lost', 'lost', 'lost', 'won']);
    } finally {
      for (const r of racers) r.kill('SIGKILL');
    }
  });
});

describe('startDaemon and its data directory', () => {
  it('names no process when daemon.json names one that is gone while the lock is held', async () => {
    const dataDir = await tmp();
    const child = spawn(process.execPath, ['-e', '']);
    await new Promise((resolve) => child.once('exit', resolve));
    await writeDaemonFile(dataDir, { port: 1, token: 'ab'.repeat(24), pid: child.pid!, startedAt: Date.now() });
    const lock = await lockDataDir(dataDir);
    try {
      const err = await startDaemon({ port: 0, dataDir, claudeDir: await tmp(), watchFiles: false, log: quiet }).catch((e) => e);
      expect(err).toBeInstanceOf(DataDirInUseError);
      expect(err.pid).toBeNull();
      expect(err.withoutLock).toBe(false);
    } finally {
      lock.release();
    }
  });

  it('refuses a second daemon on the same data directory, and lets the next one in once the first stops', async () => {
    const dataDir = await tmp();
    const claudeDir = await tmp();
    const first = await startDaemon({ port: 0, dataDir, claudeDir, watchFiles: false, log: quiet });
    try {
      await expect(startDaemon({ port: 0, dataDir, claudeDir, watchFiles: false, log: quiet })).rejects.toMatchObject({ pid: process.pid, withoutLock: false });
      expect((await readDaemonFile(dataDir))?.port).toBe(first.port);
    } finally {
      await first.stop();
    }
    const next = await startDaemon({ port: 0, dataDir, claudeDir, watchFiles: false, log: quiet });
    await next.stop();
  });

  it('frees the data directory when it cannot listen', async () => {
    const dataDir = await tmp();
    const blocker = createServer();
    const port = await listen(blocker);
    try {
      await expect(startDaemon({ port, dataDir, claudeDir: await tmp(), watchFiles: false, log: quiet })).rejects.toMatchObject({ code: 'EADDRINUSE' });
    } finally {
      await close(blocker);
    }
    expect(await dataDirInUse(dataDir)).toBe(false);
  });

  it('stops listening and frees the data directory when it cannot write the daemon file', async () => {
    const dataDir = await tmp();
    await mkdir(daemonFilePath(dataDir));
    const probe = createServer();
    const port = await listen(probe);
    await close(probe);
    await expect(startDaemon({ port, dataDir, claudeDir: await tmp(), watchFiles: false, log: quiet })).rejects.toMatchObject({ code: 'EISDIR' });
    const refused = await new Promise<boolean>((resolve) => {
      const socket = connect(port, '127.0.0.1');
      socket.on('connect', () => (socket.destroy(), resolve(false)));
      socket.on('error', () => resolve(true));
    });
    expect(refused).toBe(true);
    expect(await dataDirInUse(dataDir)).toBe(false);
  });

  it('frees the data directory before it removes the daemon file', async () => {
    // `down` returns once the file is gone: an `up` right after must find the directory free.
    const dataDir = await tmp();
    const d = await startDaemon({ port: 0, dataDir, claudeDir: await tmp(), watchFiles: false, log: quiet });
    const remove = vi.mocked(removeDaemonFile);
    const real = remove.getMockImplementation()!;
    let heldAtRemoval: boolean | undefined;
    remove.mockImplementationOnce(async (dir, pid) => {
      heldAtRemoval = await dataDirInUse(dir);
      return real(dir, pid);
    });
    await d.stop();
    expect(heldAtRemoval).toBe(false);
    expect(await readDaemonFile(dataDir)).toBeNull();
  });

  describe('beside a daemon that never takes the lock', () => {
    const TOKEN = 'ab'.repeat(24);
    const answering = (status: number) =>
      createServer((req, res) => {
        res.statusCode = req.headers.authorization === `Bearer ${TOKEN}` ? status : 401;
        res.end('{}');
      });
    const claim = (dataDir: string, port: number) => writeFile(daemonFilePath(dataDir), JSON.stringify({ port, token: TOKEN, pid: 4242, startedAt: 1 }));

    it('refuses to start when the daemon file names one that answers for this directory, without touching the store', async () => {
      const dataDir = await tmp();
      const other = answering(200);
      const port = await listen(other);
      try {
        await claim(dataDir, port);
        await expect(startDaemon({ port: 0, dataDir, claudeDir: await tmp(), watchFiles: false, log: quiet })).rejects.toMatchObject({ pid: 4242, withoutLock: true });
        expect(await readdir(dataDir)).not.toContain('hopper.db');
        expect(await dataDirInUse(dataDir)).toBe(false);
        expect((await readDaemonFile(dataDir))?.pid).toBe(4242);
      } finally {
        await close(other);
      }
    });

    it('starts when the daemon file names one that does not answer, or does not accept its token', async () => {
      const dataDir = await tmp();
      const dead = createServer();
      const deadPort = await listen(dead);
      await close(dead);
      await claim(dataDir, deadPort);
      const first = await startDaemon({ port: 0, dataDir, claudeDir: await tmp(), watchFiles: false, log: quiet });
      await first.stop();

      const strict = answering(401);
      const port = await listen(strict);
      try {
        await claim(dataDir, port);
        const second = await startDaemon({ port: 0, dataDir, claudeDir: await tmp(), watchFiles: false, log: quiet });
        await second.stop();
      } finally {
        await close(strict);
      }
    });
  });
});

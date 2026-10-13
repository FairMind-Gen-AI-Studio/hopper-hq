import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FsAdapter } from './adapters/claude-code/fs-adapter.js';
import { startDemo } from './adapters/demo.js';
import { createGitResolver } from './adapters/git.js';
import { callDaemon } from './client.js';
import { Collector } from './collector.js';
import { DEFAULT_PORT, resolvePaths, type Paths } from './config.js';
import { readDaemonFile, removeDaemonFile, writeDaemonFile } from './daemon-file.js';
import { DataDirInUseError, lockDataDir, type DataDirLock } from './daemon-lock.js';
import { loginUrl, UiAuth } from './server/auth.js';
import { SceneHub } from './server/events.js';
import { simulatedFocusDriver, tmuxFocusDriver } from './server/focus.js';
import { createApiServer } from './server/http.js';
import { loadUiBundle, UI_LIMITS } from './server/static.js';
import { Store } from './store/store.js';

export interface DaemonOptions {
  port?: number;
  claudeDir?: string;
  dataDir?: string;
  /** Watch ~/.claude on disk (default true). The mod works either way. */
  watchFiles?: boolean;
  log?: (line: string) => void;
  /** Serve scripted demo sessions from memory; ignore hooks and files. */
  demo?: boolean;
  /** The built browser UI (default: dist/ui, next to this module once built). */
  uiDir?: string;
}

export interface RunningDaemon {
  port: number;
  dataDir: string;
  collector: Collector;
  /** A one-time sign-in link for the browser (default lifetime: one minute, ten in the demo). */
  loginUrl(ttlMs?: number): string;
  /** Resolves when the CLI asks the daemon to stop (`scranton-hq down`). Whoever started the daemon stops it. */
  stopRequested: Promise<void>;
  stop(): Promise<void>;
}

/** Sign-in links of the demo last longer: its URL is printed once, at start. */
export const DEMO_CODE_TTL_MS = 10 * 60 * 1000;

/** node:sqlite prints an ExperimentalWarning on Node 22. Hide that one, keep the others. Call before opening the store. */
export function silenceExperimentalWarnings(): void {
  process.removeAllListeners('warning');
  process.on('warning', (w) => {
    if (w.name !== 'ExperimentalWarning') process.stderr.write(`${w.name}: ${w.message}\n`);
  });
}

export async function loadOrCreateToken(dataDir: string): Promise<string> {
  const file = join(dataDir, 'token');
  try {
    const existing = (await readFile(file, 'utf8')).trim();
    if (/^[0-9a-f]{48}$/.test(existing)) return existing;
  } catch {
    // create below
  }
  const token = randomBytes(24).toString('hex');
  await writeFile(file, token + '\n', { mode: 0o600 });
  await chmod(file, 0o600);
  return token;
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

/** Starts the daemon, or throws DataDirInUseError when another one runs on the same data directory. */
export async function startDaemon(opts: DaemonOptions = {}): Promise<RunningDaemon> {
  silenceExperimentalWarnings();
  const paths = resolvePaths(opts);
  await mkdir(paths.dataDir, { recursive: true, mode: 0o700 });
  const lock = await lockDataDir(paths.dataDir).catch(async (err) => {
    throw err instanceof DataDirInUseError ? new DataDirInUseError(paths.dataDir, { pid: (await readDaemonFile(paths.dataDir))?.pid ?? null }) : err;
  });
  try {
    // A daemon from before the lock never takes it: one that answers with this directory's token still owns the store.
    if ((await callDaemon<unknown>(paths.dataDir, 'GET', '/api/health', 500))?.ok) throw new DataDirInUseError(paths.dataDir, { pid: (await readDaemonFile(paths.dataDir))?.pid, withoutLock: true });
    return await serve(opts, paths, lock);
  } catch (err) {
    lock.release();
    throw err;
  }
}

/** Runs the daemon on a data directory this process holds. */
async function serve(opts: DaemonOptions, paths: Paths, lock: DataDirLock): Promise<RunningDaemon> {
  const log = opts.log ?? ((line: string) => process.stderr.write(line + '\n'));
  const token = await loadOrCreateToken(paths.dataDir);
  const ui = await loadUiBundle(opts.uiDir ?? fileURLToPath(new URL('./ui/', import.meta.url)), UI_LIMITS, log);

  const store = await Store.open(opts.demo ? ':memory:' : join(paths.dataDir, 'scranton.db'));
  store.prune(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const resolveWorkspace = createGitResolver();
  const collector = new Collector({ resolveWorkspace, store, acceptSources: opts.demo ? ['demo'] : ['hook', 'fs'], log });
  const auth = new UiAuth({ token, codeTtlMs: opts.demo ? DEMO_CODE_TTL_MS : undefined });
  const hub = new SceneHub({ source: collector, log });
  // Demo panes (%4…%11) must never reach the user's real tmux.
  const focus = opts.demo ? simulatedFocusDriver : tmuxFocusDriver();
  let requestStop!: () => void;
  const stopRequested = new Promise<void>((resolve) => (requestStop = resolve));
  const server = createApiServer({ collector, token, auth, ui, hub, focus, onShutdown: () => requestStop() });

  let port: number;
  try {
    port = await listen(server, opts.port ?? DEFAULT_PORT);
  } catch (err) {
    store.close();
    throw err;
  }
  try {
    await writeDaemonFile(paths.dataDir, { port, token, pid: process.pid, startedAt: Date.now() });
  } catch (err) {
    // Without its file nobody can find or stop this daemon: it must not keep listening.
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
    throw err;
  }

  const fsAdapter = opts.demo || opts.watchFiles === false
    ? null
    : new FsAdapter({
        claudeDir: paths.claudeDir,
        emit: (e) => void collector.ingest(e),
        resolveWorkspace,
        // A session a session file showed that exited while the daemon was down left no live process: once the first scan that read has found the live ones, it ends.
        onFirstScan: (live) => collector.endGone(live),
      });
  fsAdapter?.start();
  const demo = opts.demo ? startDemo((e) => void collector.ingest(e)) : null;
  log(`scranton-hq is listening on http://127.0.0.1:${port}`);

  return {
    port,
    dataDir: paths.dataDir,
    collector,
    loginUrl: (ttlMs) => loginUrl(port, auth.issueCode(ttlMs).code),
    stopRequested,
    stop: async () => {
      fsAdapter?.stop();
      demo?.stop();
      hub.close();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      try {
        await collector.close();
      } finally {
        store.close();
        // The directory first: `down` returns once the file is gone, and an `up` right after must find the directory free.
        lock.release();
        await removeDaemonFile(paths.dataDir, process.pid);
      }
    },
  };
}

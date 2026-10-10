import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { FsAdapter } from './adapters/claude-code/fs-adapter.js';
import { createGitResolver } from './adapters/git.js';
import { Collector } from './collector.js';
import { DEFAULT_PORT, resolvePaths } from './config.js';
import { removeDaemonFile, writeDaemonFile } from './daemon-file.js';
import { createApiServer } from './server/http.js';
import { Store } from './store/store.js';

export interface DaemonOptions {
  port?: number;
  claudeDir?: string;
  dataDir?: string;
  /** Watch ~/.claude on disk (default true). The mod works either way. */
  watchFiles?: boolean;
  log?: (line: string) => void;
}

export interface RunningDaemon {
  port: number;
  dataDir: string;
  collector: Collector;
  stop(): Promise<void>;
}

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

export async function startDaemon(opts: DaemonOptions = {}): Promise<RunningDaemon> {
  silenceExperimentalWarnings();
  const log = opts.log ?? ((line: string) => process.stderr.write(line + '\n'));
  const paths = resolvePaths(opts);
  await mkdir(paths.dataDir, { recursive: true, mode: 0o700 });
  const token = await loadOrCreateToken(paths.dataDir);

  const store = await Store.open(join(paths.dataDir, 'scranton.db'));
  store.prune(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const resolveWorkspace = createGitResolver();
  const collector = new Collector({ resolveWorkspace, store, acceptSources: ['hook', 'fs'] });
  const server = createApiServer({ collector, token });

  let port: number;
  try {
    port = await listen(server, opts.port ?? DEFAULT_PORT);
  } catch (err) {
    store.close();
    throw err;
  }
  await writeDaemonFile(paths.dataDir, { port, token, pid: process.pid, startedAt: Date.now() });

  const fsAdapter = opts.watchFiles === false
    ? null
    : new FsAdapter({ claudeDir: paths.claudeDir, emit: (e) => void collector.ingest(e), resolveWorkspace });
  fsAdapter?.start();
  log(`scranton-hq is listening on http://127.0.0.1:${port}`);

  return {
    port,
    dataDir: paths.dataDir,
    collector,
    stop: async () => {
      fsAdapter?.stop();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await collector.close();
      store.close();
      await removeDaemonFile(paths.dataDir, process.pid);
    },
  };
}

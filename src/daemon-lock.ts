import { chmod } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Thrown when another process holds the data directory: one daemon runs per directory. That is a daemon holding the lock,
 * or an older one that never takes it but answers for the directory (withoutLock). pid is the one in daemon.json when known.
 */
export class DataDirInUseError extends Error {
  readonly dataDir: string;
  readonly pid: number | null;
  readonly withoutLock: boolean;

  constructor(dataDir: string, opts: { pid?: number | null; withoutLock?: boolean } = {}) {
    super(`Another hopper-hq daemon is running on ${dataDir}.`);
    this.dataDir = dataDir;
    this.pid = opts.pid ?? null;
    this.withoutLock = opts.withoutLock ?? false;
  }
}

export interface DataDirLock {
  /** Lets another process take the directory. Calling it again does nothing. */
  release(): void;
}

const SQLITE_BUSY = 5;
/**
 * How long to wait for another connection's lock. Two that try at once can each hold a shared lock that the other's
 * exclusive one waits for: without a wait both give up, and no daemon starts. A lock held for good is held past it.
 */
const BUSY_TIMEOUT_MS = 250;

/**
 * Takes the data directory for this process, or throws DataDirInUseError. The lock is SQLite's exclusive lock on
 * `daemon.lock`, which the operating system drops when the process ends, however it ends: a crash leaves nothing to clean.
 * The holding process must never open that file any other way, since closing any descriptor of it would drop the lock.
 * On Node 22, call silenceExperimentalWarnings first.
 */
export async function lockDataDir(dataDir: string): Promise<DataDirLock> {
  const { DatabaseSync } = await import('node:sqlite');
  const path = join(dataDir, 'daemon.lock');
  const db = new DatabaseSync(path);
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    // Nothing is ever written: with no journal file, a crash leaves nothing beside the lock file.
    db.exec('PRAGMA journal_mode = MEMORY');
    db.exec('BEGIN EXCLUSIVE');
    await chmod(path, 0o600);
  } catch (err) {
    db.close();
    throw (err as { errcode?: unknown }).errcode === SQLITE_BUSY ? new DataDirInUseError(dataDir) : err;
  }
  let held = true;
  return {
    release: () => {
      if (held) db.close();
      held = false;
    },
  };
}

/** Whether a daemon holds the data directory now. When none does, the lock is taken and given back at once. */
export async function dataDirInUse(dataDir: string): Promise<boolean> {
  try {
    (await lockDataDir(dataDir)).release();
    return false;
  } catch (err) {
    if (err instanceof DataDirInUseError) return true;
    throw err;
  }
}

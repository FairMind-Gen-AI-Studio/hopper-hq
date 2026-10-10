import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Paths {
  /** Claude Code's config directory (sessions/, projects/, settings.json). */
  claudeDir: string;
  /** scranton-hq's own data directory (token, daemon.json, database). */
  dataDir: string;
}

export function resolvePaths(
  opts: { claudeDir?: string; dataDir?: string } = {},
  env: NodeJS.ProcessEnv = process.env,
): Paths {
  return {
    claudeDir: opts.claudeDir ?? env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'),
    dataDir: opts.dataDir ?? env.SCRANTON_HQ_HOME ?? join(homedir(), '.scranton-hq'),
  };
}

export interface Thresholds {
  /** An unseen 'done' becomes 'idle' after this long. */
  doneToIdleMs: number;
  /** 'idle' becomes 'dormant' after this long. */
  idleToDormantMs: number;
  /** 'working' with no activity becomes 'no_signal' after this long. */
  noSignalMs: number;
  /** A subagent transcript written within this window counts as running (filesystem fallback). */
  childFreshMs: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  doneToIdleMs: 4 * 60 * 60 * 1000,
  idleToDormantMs: 3 * 24 * 60 * 60 * 1000,
  noSignalMs: 10 * 60 * 1000,
  childFreshMs: 90 * 1000,
};

export const DEFAULT_PORT = 7337;

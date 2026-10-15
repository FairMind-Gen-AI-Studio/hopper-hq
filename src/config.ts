import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Paths {
  /** Claude Code's config directory (sessions/, projects/, settings.json). */
  claudeDir: string;
  /** hopper-hq's own data directory (token, daemon.json, database). */
  dataDir: string;
}

export function resolvePaths(
  opts: { claudeDir?: string; dataDir?: string } = {},
  env: NodeJS.ProcessEnv = process.env,
): Paths {
  return {
    claudeDir: opts.claudeDir ?? env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'),
    dataDir: opts.dataDir ?? env.HOPPER_HQ_HOME ?? join(homedir(), '.hopper-hq'),
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

export interface LeisureWindow {
  /** Local hour leisure starts (0-23), inclusive. */
  fromHour: number;
  /** Local hour leisure ends (0-23), exclusive. A window where `toHour <= fromHour` wraps past midnight. */
  toHour: number;
  /** Reserved for a future per-day-of-week restriction; not yet consulted — the window applies every day. */
  days?: number[];
}

/** Office aperitivo hours: 17:00 through 01:59, every day. */
export const DEFAULT_LEISURE_WINDOW: LeisureWindow = { fromHour: 17, toHour: 2 };

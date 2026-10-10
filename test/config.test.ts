import { describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PORT, DEFAULT_THRESHOLDS, resolvePaths } from '../src/config.js';

describe('resolvePaths', () => {
  it('prefers explicit options, then environment, then home defaults', () => {
    expect(resolvePaths({ claudeDir: '/a', dataDir: '/b' }, { CLAUDE_CONFIG_DIR: '/x', SCRANTON_HQ_HOME: '/y' })).toEqual({ claudeDir: '/a', dataDir: '/b' });
    expect(resolvePaths({}, { CLAUDE_CONFIG_DIR: '/x', SCRANTON_HQ_HOME: '/y' })).toEqual({ claudeDir: '/x', dataDir: '/y' });
    expect(resolvePaths({}, {})).toEqual({ claudeDir: join(homedir(), '.claude'), dataDir: join(homedir(), '.scranton-hq') });
  });
});

describe('defaults', () => {
  it('uses the thresholds from the design', () => {
    expect(DEFAULT_THRESHOLDS).toEqual({
      doneToIdleMs: 4 * 60 * 60 * 1000,
      idleToDormantMs: 3 * 24 * 60 * 60 * 1000,
      noSignalMs: 10 * 60 * 1000,
      childFreshMs: 90 * 1000,
    });
    expect(DEFAULT_PORT).toBe(7337);
  });
});

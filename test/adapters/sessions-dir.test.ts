import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isSameProcess, parseEtime, parseSessionFile, psProbe, readSessionsDir } from '../../src/adapters/claude-code/sessions-dir.js';

const SAMPLE = {
  pid: 15227,
  sessionId: '7ef904e4-9872-4cca-924f-e7ddde08fc55',
  cwd: '/w/shop/orders-api',
  startedAt: 1791569018989,
  procStart: 'Fri Oct  9 18:03:38 2026',
  version: '2.1.294',
  kind: 'interactive',
  entrypoint: 'cli',
  tmux: 'xirp-7ef904e4:@12.%12',
  name: 'orders-api-7c',
  status: 'waiting',
  statusUpdatedAt: 1791569019161,
  waitingFor: 'input needed',
  somethingNew: { ignored: true },
};

describe('parseSessionFile', () => {
  it('reads the fields we use and ignores the rest', () => {
    expect(parseSessionFile('/s/15227.json', JSON.stringify(SAMPLE))).toEqual({
      file: '/s/15227.json',
      pid: 15227,
      sessionId: SAMPLE.sessionId,
      cwd: '/w/shop/orders-api',
      startedAt: 1791569018989,
      status: 'waiting',
      statusUpdatedAt: 1791569019161,
      waitingFor: 'input needed',
      name: 'orders-api-7c',
      tmuxPane: '%12',
      kind: 'interactive',
    });
  });

  it('degrades missing or unknown optional fields', () => {
    const r = parseSessionFile('/s/1.json', JSON.stringify({ pid: 1, sessionId: 'S', cwd: '/w', status: 'thinking' }));
    expect(r).toMatchObject({ startedAt: 0, status: null, statusUpdatedAt: null, waitingFor: null, name: null, tmuxPane: null, kind: null });
  });

  it('rejects files without pid, sessionId or cwd, and bad JSON', () => {
    expect(parseSessionFile('/s/x.json', '{oops')).toBeNull();
    expect(parseSessionFile('/s/x.json', JSON.stringify({ sessionId: 'S', cwd: '/w' }))).toBeNull();
    expect(parseSessionFile('/s/x.json', JSON.stringify({ pid: 1, cwd: '/w' }))).toBeNull();
    expect(parseSessionFile('/s/x.json', JSON.stringify({ pid: 1, sessionId: 'S' }))).toBeNull();
  });
});

describe('readSessionsDir', () => {
  it('reads valid json files and skips the rest', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'shq-sessions-'));
    await writeFile(join(dir, '1.json'), JSON.stringify({ pid: 1, sessionId: 'A', cwd: '/w' }));
    await writeFile(join(dir, '2.json'), '{broken');
    await writeFile(join(dir, '1.abc.key'), 'secret');
    const files = await readSessionsDir(dir);
    expect(files.map((f) => f.sessionId)).toEqual(['A']);
    expect(await readSessionsDir(join(dir, 'missing'))).toEqual([]);
  });
});

describe('parseEtime', () => {
  it('parses [[dd-]hh:]mm:ss', () => {
    expect(parseEtime('00:08')).toBe(8);
    expect(parseEtime('12:34')).toBe(754);
    expect(parseEtime('1:02:03')).toBe(3723);
    expect(parseEtime('02-08:52:46')).toBe((2 * 24 + 8) * 3600 + 52 * 60 + 46);
    expect(parseEtime(' 05:00 ')).toBe(300);
    expect(parseEtime('nonsense')).toBeNull();
  });
});

describe('psProbe', () => {
  it('finds the start time of a running process and ignores unknown pids', async () => {
    const now = Date.now();
    const starts = await psProbe([process.pid, 999_999_999], now);
    const mine = starts.get(process.pid);
    expect(mine).toBeDefined();
    expect(mine!).toBeLessThanOrEqual(now);
    expect(mine!).toBeGreaterThan(now - 24 * 60 * 60 * 1000);
    expect(starts.has(999_999_999)).toBe(false);
    expect((await psProbe([], now)).size).toBe(0);
  });
});

describe('isSameProcess', () => {
  const file = parseSessionFile('/s/1.json', JSON.stringify({ pid: 1, sessionId: 'S', cwd: '/w', startedAt: 100_000 }))!;
  it('accepts a process that started before (or just after) the file', () => {
    expect(isSameProcess(file, 90_000)).toBe(true);
    expect(isSameProcess(file, 160_000)).toBe(true);
  });
  it('rejects a recycled pid and a missing process', () => {
    expect(isSameProcess(file, 160_001)).toBe(false);
    expect(isSameProcess(file, undefined)).toBe(false);
  });
  it('accepts any running process when the file has no startedAt', () => {
    const bare = parseSessionFile('/s/2.json', JSON.stringify({ pid: 2, sessionId: 'T', cwd: '/w' }))!;
    expect(isSameProcess(bare, 5)).toBe(true);
  });
});

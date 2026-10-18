import { describe, expect, it } from 'vitest';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isSameProcess, parseEtime, parseSessionFile, psProbe, processProbe, parseWindowsProcesses, readSessionsDir } from '../../src/adapters/claude-code/sessions-dir.js';

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
      tmuxSession: 'xirp-7ef904e4',
      kind: 'interactive',
    });
  });

  it("keeps the tmux session a pane is in, when Claude Code's field names it", () => {
    const tmuxOf = (tmux: unknown) => {
      const r = parseSessionFile('/s/1.json', JSON.stringify({ pid: 1, sessionId: 'S', cwd: '/w', tmux }))!;
      return [r.tmuxPane, r.tmuxSession];
    };
    expect(tmuxOf('work:@3.%41')).toEqual(['%41', 'work']);
    expect(tmuxOf('my session:@3.%41')).toEqual(['%41', 'my session']);
    expect(tmuxOf('%41')).toEqual(['%41', null]);
    expect(tmuxOf(':@3.%41')).toEqual(['%41', null]);
    expect(tmuxOf('work')).toEqual([null, null]);
    expect(tmuxOf(7)).toEqual([null, null]);
  });

  it('degrades missing or unknown optional fields', () => {
    const r = parseSessionFile('/s/1.json', JSON.stringify({ pid: 1, sessionId: 'S', cwd: '/w', status: 'thinking' }));
    expect(r).toMatchObject({ startedAt: 0, status: null, statusUpdatedAt: null, waitingFor: null, name: null, tmuxPane: null, tmuxSession: null, kind: null });
  });

  it('rejects a file whose session id could reach outside a directory or a URL path', () => {
    for (const sessionId of ['..', '../../../tmp/x', 'a/b', 'a\\b', 'a\u0000b']) {
      expect([sessionId, parseSessionFile('/s/1.json', JSON.stringify({ pid: 1, sessionId, cwd: '/w' }))]).toEqual([sessionId, null]);
    }
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
    const files = (await readSessionsDir(dir))!;
    expect(files.map((f) => f.sessionId)).toEqual(['A']);
    expect(await readSessionsDir(dir)).toHaveLength(1);
  });

  it('tells a directory it could not read from an empty one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'shq-sessions-'));
    expect(await readSessionsDir(dir)).toEqual([]);
    expect(await readSessionsDir(join(dir, 'missing'))).toBeNull();
    await writeFile(join(dir, 'file'), 'x');
    expect(await readSessionsDir(join(dir, 'file'))).toBeNull();
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

describe.skipIf(process.platform === 'win32')('psProbe', () => {
  it('finds the start time of a running process and ignores unknown pids', async () => {
    const now = Date.now();
    const starts = (await psProbe([process.pid, 999_999_999], now))!;
    const mine = starts.get(process.pid);
    expect(mine).toBeDefined();
    expect(mine!).toBeLessThanOrEqual(now);
    expect(mine!).toBeGreaterThan(now - 24 * 60 * 60 * 1000);
    expect(starts.has(999_999_999)).toBe(false);
    expect((await psProbe([], now))!.size).toBe(0);
  });

  it('tells a ps that could not run from no running process', async () => {
    const path = process.env.PATH;
    process.env.PATH = await mkdtemp(join(tmpdir(), 'shq-nops-'));
    try {
      expect(await psProbe([process.pid], Date.now())).toBeNull();
      expect((await psProbe([], Date.now()))!.size).toBe(0);
    } finally {
      process.env.PATH = path;
    }
  });
});

describe.skipIf(process.platform === 'win32')('psProbe with a ps that printed something unusable', () => {
  async function withFakePs(script: string, run: () => Promise<void>) {
    const dir = await mkdtemp(join(tmpdir(), 'shq-fakeps-'));
    await writeFile(join(dir, 'ps'), `#!/bin/sh\n${script}\n`);
    await chmod(join(dir, 'ps'), 0o755);
    const path = process.env.PATH;
    process.env.PATH = dir;
    try {
      await run();
    } finally {
      process.env.PATH = path;
    }
  }

  it('reads a ps that fails and prints no line it can parse as a failed read', async () => {
    await withFakePs('echo "ps: illegal option"\nexit 1', async () => {
      expect(await psProbe([process.pid], Date.now())).toBeNull();
    });
  });

  it('reads a ps that succeeds and prints nothing as a failed read', async () => {
    await withFakePs('exit 0', async () => {
      expect(await psProbe([process.pid], Date.now())).toBeNull();
    });
  });

  it('reads a ps whose lines parse but do not list the wanted pid as no running process', async () => {
    await withFakePs('echo "    1 10:00"\necho "  200 01:02:03"', async () => {
      const starts = await psProbe([process.pid], Date.now());
      expect(starts).not.toBeNull();
      expect(starts!.size).toBe(0);
    });
  });
});

describe('processProbe', () => {
  it('reads the current process creation time on the host platform', async () => {
    const now = Date.now();
    const starts = await processProbe([process.pid, 999_999_999], now);
    expect(starts?.get(process.pid)).toBeGreaterThan(now - 86400_000);
    expect(starts?.get(process.pid)).toBeLessThanOrEqual(now);
    expect(starts?.has(999_999_999)).toBe(false);
    expect(await processProbe([], now)).toEqual(new Map());
  });
  it('distinguishes missing processes from unreadable Windows process data', () => {
    expect(parseWindowsProcesses('[]', [42])).toEqual(new Map());
    expect(parseWindowsProcesses('\uFEFF[{"ProcessId":42,"startedAt":"2026-10-18T10:00:00.000Z"}]', [42, 43])).toEqual(new Map([[42, 1792317600000]]));
    expect(parseWindowsProcesses('[{"ProcessId":42,"startedAt":null}]', [42])).toBeNull();
    expect(parseWindowsProcesses('Access denied', [42])).toBeNull();
    expect(parseWindowsProcesses('{}', [42])).toBeNull();
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

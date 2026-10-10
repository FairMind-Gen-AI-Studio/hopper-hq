import { beforeAll, describe, expect, it } from 'vitest';
import { appendFile, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readHeadLines, readNewLines, readTailLines, type TailState } from '../../src/adapters/claude-code/jsonl.js';

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'shq-jsonl-'));
});
const start = (path: string): TailState => ({ path, offset: 0, skipping: false });

describe('readNewLines', () => {
  it('returns complete lines and resumes a partial one later', async () => {
    const p = join(dir, 'partial.jsonl');
    await writeFile(p, '{"a":1}\n{"b":');
    let r = await readNewLines(start(p));
    expect(r.lines).toEqual(['{"a":1}']);
    expect(r.state.offset).toBe(8);
    r = await readNewLines(r.state);
    expect(r.lines).toEqual([]);
    await appendFile(p, '2}\n');
    r = await readNewLines(r.state);
    expect(r.lines).toEqual(['{"b":2}']);
  });

  it('never splits a multi-byte character', async () => {
    const p = join(dir, 'utf8.jsonl');
    const bytes = Buffer.from('{"t":"caffè ☕"}\n');
    await writeFile(p, bytes.subarray(0, 14));
    let r = await readNewLines(start(p));
    expect(r.lines).toEqual([]);
    await appendFile(p, bytes.subarray(14));
    r = await readNewLines(r.state);
    expect(JSON.parse(r.lines[0]!).t).toBe('caffè ☕');
  });

  it('starts over when the file shrinks', async () => {
    const p = join(dir, 'shrink.jsonl');
    await writeFile(p, '{"x":1}\n{"y":2}\n');
    const r1 = await readNewLines(start(p));
    await writeFile(p, '{"z":3}\n');
    const r2 = await readNewLines(r1.state);
    expect(r2.lines).toEqual(['{"z":3}']);
  });

  it('skips a line longer than maxBytes and continues after it', async () => {
    const p = join(dir, 'giant.jsonl');
    await writeFile(p, 'A'.repeat(40) + '\n{"ok":1}\n');
    let state = start(p);
    let lines: string[] = [];
    for (let i = 0; i < 10 && lines.length === 0; i++) {
      const r = await readNewLines(state, 16);
      state = r.state;
      lines = r.lines;
    }
    expect(lines).toEqual(['{"ok":1}']);
  });

  it('returns nothing for a missing file', async () => {
    const r = await readNewLines(start(join(dir, 'missing.jsonl')));
    expect(r.lines).toEqual([]);
    expect(r.state.offset).toBe(0);
  });
});

describe('readHeadLines and readTailLines', () => {
  it('reads only complete lines at either end', async () => {
    const p = join(dir, 'ends.jsonl');
    await writeFile(p, '{"n":1}\n{"n":2}\n{"n":3}\n');
    expect(await readHeadLines(p, 12)).toEqual(['{"n":1}']);
    expect(await readTailLines(p, 12)).toEqual({ lines: ['{"n":3}'], offset: 24 });
    expect(await readTailLines(p, 1000)).toEqual({ lines: ['{"n":1}', '{"n":2}', '{"n":3}'], offset: 24 });
  });

  it('stops the tail offset before a trailing partial line', async () => {
    const p = join(dir, 'tail-partial.jsonl');
    await writeFile(p, '{"n":1}\n{"n":2');
    expect(await readTailLines(p, 1000)).toEqual({ lines: ['{"n":1}'], offset: 8 });
  });
});

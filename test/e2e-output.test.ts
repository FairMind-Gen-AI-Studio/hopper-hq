import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanOutputAfterPass, runPassed } from '../e2e/output.js';

describe('smoke test output', () => {
  it('reads a pass only from a last-run file that says passed', () => {
    expect(runPassed('{"status":"passed","failedTests":[]}')).toBe(true);
    expect(runPassed('{"status":"failed","failedTests":["a"]}')).toBe(false);
    expect(runPassed('{"status":"interrupted"}')).toBe(false);
    expect(runPassed('not json')).toBe(false);
    expect(runPassed('null')).toBe(false);
    expect(runPassed(undefined)).toBe(false);
  });

  async function outputWith(lastRun: string | null): Promise<string> {
    const dir = join(await mkdtemp(join(tmpdir(), 'shq-output-test-')), 'out');
    await mkdir(dir);
    await writeFile(join(dir, 'screenshot.png'), 'x');
    if (lastRun !== null) await writeFile(join(dir, '.last-run.json'), lastRun);
    return dir;
  }

  it('removes the directory after a passing run', async () => {
    const dir = await outputWith('{"status":"passed","failedTests":[]}');
    await cleanOutputAfterPass(dir);
    expect(existsSync(dir)).toBe(false);
  });

  it('keeps the directory after a failing run', async () => {
    const dir = await outputWith('{"status":"failed","failedTests":["a"]}');
    await cleanOutputAfterPass(dir);
    expect(existsSync(join(dir, 'screenshot.png'))).toBe(true);
  });

  it('keeps the directory when the last-run file is missing or unreadable', async () => {
    const missing = await outputWith(null);
    await cleanOutputAfterPass(missing);
    expect(existsSync(missing)).toBe(true);
    const garbled = await outputWith('{');
    await cleanOutputAfterPass(garbled);
    expect(existsSync(garbled)).toBe(true);
  });

  it('does nothing when there is no directory', async () => {
    await expect(cleanOutputAfterPass(join(tmpdir(), 'shq-output-test-absent'))).resolves.toBeUndefined();
  });
});

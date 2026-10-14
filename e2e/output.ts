import { createHash } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Where Playwright writes, and empties at every run: a directory of this checkout's own, named by a hash of the
 * checkout's path, so a run in another checkout never empties or reads it. Nothing is written into the repository.
 */
export function outputDirFor(checkout: string): string {
  return join(tmpdir(), `hopper-hq-e2e-${createHash('sha256').update(checkout).digest('hex').slice(0, 12)}`);
}

/** Whether the content of Playwright's `.last-run.json` says the run passed. Anything else counts as not passed. */
export function runPassed(lastRun: string | undefined): boolean {
  if (lastRun === undefined) return false;
  try {
    return (JSON.parse(lastRun) as { status?: unknown } | null)?.status === 'passed';
  } catch {
    return false;
  }
}

/** Removes the output directory after a passing run. A failing run, or one whose result cannot be read, keeps it for debugging. */
export async function cleanOutputAfterPass(dir: string): Promise<void> {
  const lastRun = await readFile(join(dir, '.last-run.json'), 'utf8').catch(() => undefined);
  if (runPassed(lastRun)) await rm(dir, { recursive: true, force: true });
}

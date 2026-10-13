import { afterEach, describe, expect, it } from 'vitest';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openInBrowser } from '../src/cli.js';

const OPENER = process.platform === 'darwin' ? 'open' : process.platform === 'linux' ? 'xdg-open' : null;
const URL_ = 'http://127.0.0.1:7337/ui/login?code=' + 'a'.repeat(48);

const realPath = process.env.PATH;
afterEach(() => {
  process.env.PATH = realPath;
});

/** A directory that holds the only opener the command can find: a script with this body. Nothing real is ever launched. */
async function fakeOpener(body: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'shq-open-'));
  const file = join(dir, OPENER!);
  await writeFile(file, `#!/bin/sh\n${body}\n`);
  await chmod(file, 0o755);
  process.env.PATH = `${dir}:/bin:/usr/bin`;
  return dir;
}

describe.skipIf(!OPENER)('openInBrowser', () => {
  it('hands the opener the link and resolves when it exits', async () => {
    const dir = await fakeOpener('echo "$1" > "$(dirname "$0")/arg"');
    await openInBrowser(URL_);
    expect((await readFile(join(dir, 'arg'), 'utf8')).trim()).toBe(URL_);
  });

  it('does not wait for a browser that keeps the opener\'s output open after the opener exits', async () => {
    // xdg-open can leave the browser it started holding its stdout and stderr: with pipes, nothing ends.
    await fakeOpener('sleep 3 &\nexit 0');
    const started = Date.now();
    await openInBrowser(URL_);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('resolves when there is no opener to run', async () => {
    process.env.PATH = await mkdtemp(join(tmpdir(), 'shq-noopen-'));
    await expect(openInBrowser(URL_)).resolves.toBeUndefined();
  });
});

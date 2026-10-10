import { beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { createGitResolver, resolveWorkspace, type GitRunner } from '../../src/adapters/git.js';

const execFileP = promisify(execFile);
const git = (cwd: string, ...args: string[]) =>
  execFileP('git', ['-C', cwd, '-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'core.hooksPath=/dev/null', ...args]);

let base: string;
let repo: string;
beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'shq-git-')));
  repo = join(base, 'orders-api');
  await mkdir(join(repo, 'src'), { recursive: true });
  await git(repo, 'init', '-q', '-b', 'main');
  await git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
  await git(repo, 'checkout', '-q', '-b', 'feat/checkout-v2');
  await git(repo, 'worktree', 'add', '-q', '-b', 'feat/other', join(base, 'wt-other'));
  await git(repo, 'worktree', 'add', '-q', '--detach', join(base, 'wt-detached'));
});

describe('resolveWorkspace', () => {
  it('describes a directory outside git', async () => {
    const plain = join(base, 'plain');
    await mkdir(plain);
    expect(await resolveWorkspace(plain)).toEqual({ cwd: plain, repoRoot: null, repoName: 'plain', worktree: false, branch: null });
  });

  it('describes the main checkout and its subdirectories', async () => {
    expect(await resolveWorkspace(repo)).toEqual({ cwd: repo, repoRoot: repo, repoName: 'orders-api', worktree: false, branch: 'feat/checkout-v2' });
    expect(await resolveWorkspace(join(repo, 'src'))).toMatchObject({ repoRoot: repo, repoName: 'orders-api', worktree: false });
  });

  it('maps a linked worktree to its main repository', async () => {
    const wt = join(base, 'wt-other');
    expect(await resolveWorkspace(wt)).toEqual({ cwd: wt, repoRoot: repo, repoName: 'orders-api', worktree: true, branch: 'feat/other' });
  });

  it('reports a detached HEAD', async () => {
    expect((await resolveWorkspace(join(base, 'wt-detached'))).branch).toBe('HEAD');
  });

  it('falls back to the directory name when git is unavailable', async () => {
    const failing: GitRunner = async () => null;
    expect(await resolveWorkspace('/x/y/storefront', failing)).toEqual({ cwd: '/x/y/storefront', repoRoot: null, repoName: 'storefront', worktree: false, branch: null });
  });
});

describe('createGitResolver', () => {
  it('caches per cwd within the ttl', async () => {
    let calls = 0;
    let now = 0;
    const counting: GitRunner = async () => { calls++; return null; };
    const resolve = createGitResolver(1000, counting, () => now);
    await resolve('/a');
    await resolve('/a');
    expect(calls).toBe(1);
    now = 1000;
    await resolve('/a');
    expect(calls).toBe(2);
    expect(basename((await resolve('/b')).cwd)).toBe('b');
  });
});

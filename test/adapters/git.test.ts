import { beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { createGitResolver, resolveWorkspace, type GitRunner } from '../../src/adapters/git.js';

const execFileP = promisify(execFile);
const git = (cwd: string, ...args: string[]) =>
  execFileP('git', ['-C', cwd, '-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'core.hooksPath=/dev/null', '-c', 'protocol.file.allow=always', ...args]);

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
  // A bare clone with a worktree, and the '.bare' layout: a bare repository in .bare, its worktrees beside it.
  await git(base, 'clone', '-q', '--bare', repo, join(base, 'svc.git'));
  await git(join(base, 'svc.git'), 'worktree', 'add', '-q', join(base, 'svc-main'), 'main');
  await mkdir(join(base, 'proj'));
  await git(base, 'clone', '-q', '--bare', repo, join(base, 'proj', '.bare'));
  await writeFile(join(base, 'proj', '.git'), 'gitdir: ./.bare\n');
  await git(join(base, 'proj'), 'worktree', 'add', '-q', join(base, 'proj', 'main'), 'main');
  // A submodule, whose git dir sits in the superproject's, and a checkout whose git dir lives elsewhere.
  await mkdir(join(base, 'super'));
  await git(join(base, 'super'), 'init', '-q', '-b', 'main');
  await git(join(base, 'super'), 'commit', '-q', '--allow-empty', '-m', 'init');
  await git(join(base, 'super'), 'submodule', 'add', '-q', repo, 'libs/orders-api');
  await mkdir(join(base, 'billing'));
  await mkdir(join(base, 'store'));
  await git(join(base, 'billing'), 'init', '-q', '-b', 'main', '--separate-git-dir', join(base, 'store', 'billing.git'));
});

describe('resolveWorkspace', () => {
  it('describes a directory outside git', async () => {
    const plain = join(base, 'plain');
    await mkdir(plain);
    expect(await resolveWorkspace(plain)).toEqual({ cwd: plain, repoRoot: null, repoName: 'plain', worktree: false, branch: null, root: null });
  });

  it('describes the main checkout and its subdirectories', async () => {
    expect(await resolveWorkspace(repo)).toEqual({ cwd: repo, repoRoot: repo, repoName: 'orders-api', worktree: false, branch: 'feat/checkout-v2', root: repo });
    expect(await resolveWorkspace(join(repo, 'src'))).toMatchObject({ repoRoot: repo, repoName: 'orders-api', worktree: false, root: repo });
  });

  it('maps a linked worktree to its main repository', async () => {
    const wt = join(base, 'wt-other');
    expect(await resolveWorkspace(wt)).toEqual({ cwd: wt, repoRoot: repo, repoName: 'orders-api', worktree: true, branch: 'feat/other', root: wt });
  });

  it('reports a detached HEAD', async () => {
    expect(await resolveWorkspace(join(base, 'wt-detached'))).toMatchObject({ branch: 'HEAD', worktree: true, root: join(base, 'wt-detached') });
  });

  it('maps a worktree of a bare repository to it, named without .git', async () => {
    const wt = join(base, 'svc-main');
    expect(await resolveWorkspace(wt)).toEqual({ cwd: wt, repoRoot: join(base, 'svc.git'), repoName: 'svc', worktree: true, branch: 'main', root: wt });
  });

  it("maps a worktree of a '.bare' repository to the directory that holds both", async () => {
    const wt = join(base, 'proj', 'main');
    expect(await resolveWorkspace(wt)).toEqual({ cwd: wt, repoRoot: join(base, 'proj'), repoName: 'proj', worktree: true, branch: 'main', root: wt });
  });

  it('describes a submodule as a main checkout of its own', async () => {
    const sub = join(base, 'super', 'libs', 'orders-api');
    expect(await resolveWorkspace(sub)).toMatchObject({ cwd: sub, repoRoot: sub, repoName: 'orders-api', worktree: false, root: sub });
  });

  it('describes a checkout whose git dir lives elsewhere as a main checkout', async () => {
    const dir = join(base, 'billing');
    expect(await resolveWorkspace(dir)).toEqual({ cwd: dir, repoRoot: dir, repoName: 'billing', worktree: false, branch: 'main', root: dir });
  });

  it('falls back to the directory name when git is unavailable', async () => {
    const failing: GitRunner = async () => null;
    expect(await resolveWorkspace('/x/y/storefront', failing)).toEqual({ cwd: '/x/y/storefront', repoRoot: null, repoName: 'storefront', worktree: false, branch: null, root: null });
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

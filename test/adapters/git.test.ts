import { beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { createBranchResolver, createGitResolver, resolveWorkspace, runGit, type GitRunner } from '../../src/adapters/git.js';
import { floorKeyOf } from '../../src/core/view.js';

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

  it('resolves the symlinks of a directory outside git, so a link and its target give one floor', async () => {
    const real = join(base, 'scratch', 'notes');
    await mkdir(real, { recursive: true });
    await symlink(join(base, 'scratch'), join(base, 'scratch-link'));
    const viaLink = await resolveWorkspace(join(base, 'scratch-link', 'notes'));
    expect(viaLink).toEqual({ cwd: real, repoRoot: null, repoName: 'notes', worktree: false, branch: null, root: null });
    expect(await resolveWorkspace(real)).toEqual(viaLink);
    expect(floorKeyOf({ feature: null, workspace: viaLink })).toBe(`repo:${real}`);
  });

  it('keeps a directory outside git as it is when it cannot be resolved', async () => {
    const gone = join(base, 'gone', 'away');
    expect(await resolveWorkspace(gone)).toEqual({ cwd: gone, repoRoot: null, repoName: 'away', worktree: false, branch: null, root: null });
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

describe('createBranchResolver', () => {
  it("says the branch of the checkout asked about, not of a worktree beside it, and where its HEAD is", async () => {
    const branchOf = createBranchResolver();
    expect(await branchOf(repo)).toEqual({ branch: 'feat/checkout-v2', watch: join(repo, '.git', 'HEAD') });
    expect(await branchOf(join(base, 'wt-other'))).toEqual({ branch: 'feat/other', watch: join(repo, '.git', 'worktrees', 'wt-other', 'HEAD') });
    expect(await branchOf(join(base, 'wt-detached'))).toEqual({ branch: 'HEAD', watch: join(repo, '.git', 'worktrees', 'wt-detached', 'HEAD') });
    const plain = join(base, 'plain-branch');
    await mkdir(plain);
    expect(await branchOf(plain)).toBeNull();
  });

  it('says the branch of a repository with no commit yet', async () => {
    const fresh = join(base, 'fresh');
    await mkdir(fresh);
    await git(fresh, 'init', '-q', '-b', 'main');
    expect((await createBranchResolver()(fresh))?.branch).toBe('main');
  });

  it('asks git afresh each time', async () => {
    await git(repo, 'checkout', '-q', '-b', 'feat/refunds');
    try {
      expect((await createBranchResolver()(repo))?.branch).toBe('feat/refunds');
    } finally {
      await git(repo, 'checkout', '-q', 'feat/checkout-v2');
    }
  });

  it("watches a reftable repository's list of tables, which a switch rewrites while HEAD stays as it is", async (ctx) => {
    const reftable = join(base, 'reftable');
    // Git 2.45 and later: an older one cannot make a reftable repository.
    if (!(await git(base, 'init', '-q', '-b', 'main', '--ref-format=reftable', reftable).then(() => true, () => false))) return ctx.skip();
    await git(reftable, 'commit', '-q', '--allow-empty', '-m', 'init');
    const wt = join(base, 'reftable-wt');
    await git(reftable, 'worktree', 'add', '-q', '-b', 'worktree-agent-a1b2', wt);
    const branchOf = createBranchResolver();
    const main = await branchOf(reftable);
    expect(main).toEqual({ branch: 'main', watch: join(reftable, '.git', 'reftable', 'tables.list') });
    expect(await branchOf(wt)).toEqual({ branch: 'worktree-agent-a1b2', watch: join(reftable, '.git', 'worktrees', 'reftable-wt', 'reftable', 'tables.list') });
    // Whole seconds: a fraction of a millisecond would not survive the round trip through the file system.
    const old = Math.floor(Date.now() / 1000) - 60;
    await utimes(main!.watch, old, old);
    await utimes(join(reftable, '.git', 'HEAD'), old, old);
    await git(reftable, 'switch', '-q', '-c', 'feat/refunds');
    expect((await stat(main!.watch)).mtimeMs).toBeGreaterThan(old * 1000);
    expect((await stat(join(reftable, '.git', 'HEAD'))).mtimeMs).toBe(old * 1000);
    expect((await branchOf(reftable))?.branch).toBe('feat/refunds');
    // A reftable HEAD file always names a ref, detached or not.
    await git(wt, 'switch', '-q', '--detach');
    expect((await branchOf(wt))?.branch).toBe('HEAD');
  });

  it('cannot tell when git fails to name the branch of a HEAD that holds one', async () => {
    const failing: GitRunner = async (cwd, args) => (args[0] === 'symbolic-ref' ? null : runGit(cwd, args));
    expect(await createBranchResolver(failing)(repo)).toBeNull();
    expect(await createBranchResolver(failing)(join(base, 'wt-detached'))).toMatchObject({ branch: 'HEAD' });
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

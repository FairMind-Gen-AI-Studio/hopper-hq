import { execFile } from 'node:child_process';
import { access, realpath } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { Workspace } from '../core/types.js';

const execFileP = promisify(execFile);

/** Runs git in cwd; resolves trimmed stdout, or null on any failure. */
export type GitRunner = (cwd: string, args: string[]) => Promise<string | null>;

export const runGit: GitRunner = async (cwd, args) => {
  try {
    const { stdout } = await execFileP('git', ['-C', cwd, ...args], { timeout: 3000 });
    return stdout.trim();
  } catch {
    return null;
  }
};

async function real(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return resolve(p);
  }
}

/** Names of a git dir that sits in the directory it belongs to: a checkout's .git, or the '.bare' its worktrees sit beside. */
const GIT_DIR_NAMES = new Set(['.git', '.bare']);

export async function resolveWorkspace(cwd: string, run: GitRunner = runGit): Promise<Workspace> {
  const out = await run(cwd, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir']);
  if (!out) {
    // Outside git, the directory itself names the floor: with its symlinks resolved, a link and its target are one floor.
    const dir = await realpath(cwd).catch(() => cwd);
    return { cwd: dir, repoRoot: null, repoName: basename(dir) || dir, worktree: false, branch: null, root: null };
  }
  const [toplevel = cwd, gitDir = '', common = ''] = out.split('\n');
  const root = await real(toplevel);
  const ownDir = await real(gitDir || resolve(toplevel, '.git'));
  const commonDir = await real(common || ownDir);
  // A linked worktree has a git dir of its own inside the common one. Any other checkout is a main one, wherever its git
  // dir lives: a submodule's sits in the superproject's, --separate-git-dir puts it anywhere.
  const worktree = ownDir !== commonDir;
  // The main repository: the main checkout, else the directory that holds the common git dir, else a bare repository.
  // Known limit: a linked worktree of a repository whose git dir sits apart from its main checkout (--separate-git-dir,
  // a submodule) takes that git dir as its repository, while the main checkout takes itself. On a trunk branch the two
  // show as two department floors of the same name. The layout is rare, and the worktree's git dir does not reliably
  // say where the main checkout is.
  const mainRoot = !worktree ? root : GIT_DIR_NAMES.has(basename(commonDir)) ? dirname(commonDir) : commonDir;
  const branch = await run(cwd, ['symbolic-ref', '--short', '-q', 'HEAD']);
  return {
    cwd,
    repoRoot: mainRoot,
    repoName: mainRoot === commonDir ? basename(mainRoot).replace(/(.)\.git$/, '$1') : basename(mainRoot),
    worktree,
    branch: branch || 'HEAD',
    root,
  };
}

export type WorkspaceResolver = (cwd: string) => Promise<Workspace>;

/** A checkout's branch ('HEAD' when detached), and the file git rewrites when its HEAD moves. */
export interface CheckoutBranch {
  branch: string;
  /** HEAD itself, or in a reftable repository, which keeps HEAD in its tables, the list of those tables. */
  watch: string;
}

/** Asks git afresh each time; null outside git, or when git cannot tell. */
export type BranchResolver = (cwd: string) => Promise<CheckoutBranch | null>;

export function createBranchResolver(run: GitRunner = runGit): BranchResolver {
  return async (cwd) => {
    const paths = await run(cwd, ['rev-parse', '--path-format=absolute', '--git-path', 'HEAD', '--git-path', 'reftable/tables.list']);
    if (!paths) return null;
    const [headFile = '', tables = ''] = paths.split('\n');
    // A reftable repository never rewrites its HEAD file, and rewrites its list of tables on every ref update.
    const watch = tables && (await access(tables).then(() => true, () => false)) ? tables : headFile;
    const branch = await run(cwd, ['symbolic-ref', '--short', '-q', 'HEAD']);
    if (branch) return { branch, watch };
    // symbolic-ref fails alike on a detached HEAD and on any error: rev-parse names a detached HEAD 'HEAD'.
    return (await run(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])) === 'HEAD' ? { branch: 'HEAD', watch } : null;
  };
}

export function createGitResolver(ttlMs = 30_000, run: GitRunner = runGit, now: () => number = Date.now): WorkspaceResolver {
  const cache = new Map<string, { at: number; ws: Promise<Workspace> }>();
  return (cwd) => {
    const hit = cache.get(cwd);
    if (hit && now() - hit.at < ttlMs) return hit.ws;
    const ws = resolveWorkspace(cwd, run);
    cache.set(cwd, { at: now(), ws });
    return ws;
  };
}

import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
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

export async function resolveWorkspace(cwd: string, run: GitRunner = runGit): Promise<Workspace> {
  const out = await run(cwd, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir']);
  if (!out) return { cwd, repoRoot: null, repoName: basename(cwd) || cwd, worktree: false, branch: null, root: null };
  const [toplevel = cwd, common = ''] = out.split('\n');
  const commonDir = await real(common || resolve(toplevel, '.git'));
  const mainRoot = basename(commonDir) === '.git' ? dirname(commonDir) : commonDir;
  const root = await real(toplevel);
  const branch = await run(cwd, ['symbolic-ref', '--short', '-q', 'HEAD']);
  return {
    cwd,
    repoRoot: mainRoot,
    repoName: basename(mainRoot),
    worktree: root !== mainRoot,
    branch: branch || 'HEAD',
    root,
  };
}

export type WorkspaceResolver = (cwd: string) => Promise<Workspace>;

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

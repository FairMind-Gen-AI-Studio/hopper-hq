import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { encodeProjectDir } from '../src/adapters/claude-code/fs-adapter.js';
import { main, type Io } from '../src/cli.js';
import type { Snapshot } from '../src/collector.js';
import { readDaemonFile } from '../src/daemon-file.js';
import { startDaemon } from '../src/daemon.js';

const execFileP = promisify(execFile);
const git = (cwd: string, ...args: string[]) =>
  execFileP('git', ['-C', cwd, '-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'core.hooksPath=/dev/null', ...args]);

function capture() {
  const out: string[] = [];
  const io: Io = { out: (l) => out.push(l), err: () => {} };
  return { io, out };
}

async function post(port: number, token: string, body: object): Promise<number> {
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    request({ host: '127.0.0.1', port, path: '/api/hooks', method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    }).on('error', reject).end(data);
  });
}

async function waitFor<T>(fn: () => T | undefined, ms = 6000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('end to end', () => {
  it('sees a live session from disk, takes hooks, and drives the tmux counter', async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), 'shq-e2e-')));
    const repo = join(base, 'orders-api');
    await mkdir(repo);
    await git(repo, 'init', '-q', '-b', 'main');
    await git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
    await git(repo, 'checkout', '-q', '-b', 'feat/e2e-flow');

    const claudeDir = join(base, 'claude');
    await mkdir(join(claudeDir, 'sessions'), { recursive: true });
    await writeFile(join(claudeDir, 'sessions', `${process.pid}.json`), JSON.stringify({
      pid: process.pid, sessionId: 'E2E', cwd: repo, startedAt: Date.now(), status: 'busy', statusUpdatedAt: Date.now(), name: 'orders-api-e2e', tmux: 'x:@1.%9',
    }));
    const projectDir = join(claudeDir, 'projects', encodeProjectDir(repo));
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, 'E2E.jsonl'), [
      { type: 'user', timestamp: new Date().toISOString(), cwd: repo, gitBranch: 'feat/e2e-flow', message: { content: 'Ship the e2e flow' } },
      { type: 'ai-title', aiTitle: 'End-to-end flow' },
    ].map((l) => JSON.stringify(l)).join('\n') + '\n');

    const dataDir = join(base, 'data');
    const d = await startDaemon({ port: 0, claudeDir, dataDir, log: () => {} });
    try {
      // The session is announced before its transcript is read: wait until the title from the transcript is in too.
      const floor = await waitFor(() => d.collector.snapshot().floors.find((f) => f.name === 'e2e-flow' && f.sessions[0]?.title));
      expect(floor.kind).toBe('feature');
      expect(floor.sessions[0]).toMatchObject({ id: 'E2E', title: 'End-to-end flow', effectiveState: 'working', tmuxPane: '%9' });

      const { token, port } = (await readDaemonFile(dataDir))!;
      expect(await post(port, token, { hook_event_name: 'PermissionRequest', session_id: 'E2E', cwd: repo, tool_name: 'Bash', tool_input: { command: 'npm publish' }, _scranton_ts: Date.now() + 1000 })).toBe(204);
      await d.collector.idle();
      const tmux = capture();
      await main(['status', '--format', 'tmux', '--data-dir', dataDir], tmux.io);
      expect(tmux.out).toEqual(['#[fg=colour203,bold]◉1#[default]']);

      expect(await post(port, token, { hook_event_name: 'Stop', session_id: 'E2E', cwd: repo, _scranton_ts: Date.now() + 2000 })).toBe(204);
      await d.collector.idle();
      const ls = capture();
      await main(['ls', '--data-dir', dataDir], ls.io);
      expect(ls.out[0]).toContain('e2e-flow  (feature · orders-api)');
      expect(ls.out[0]).toContain('done');
      await main(['ack', '--data-dir', dataDir], capture().io);
      const after = capture();
      await main(['status', '--format', 'tmux', '--data-dir', dataDir], after.io);
      expect(after.out).toEqual(['']);
    } finally {
      await d.stop();
    }
  });
});

export type { Snapshot };

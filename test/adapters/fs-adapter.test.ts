import { beforeEach, describe, expect, it } from 'vitest';
import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeProjectDir, FsAdapter, type FsAdapterOptions } from '../../src/adapters/claude-code/fs-adapter.js';
import type { RawEvent } from '../../src/core/types.js';

const T0 = Date.parse('2026-10-10T10:00:00.000Z');
const CWD = '/w/shop/orders-api';
const SESSION = { pid: 4242, sessionId: 'S1', cwd: CWD, startedAt: T0, status: 'busy', statusUpdatedAt: T0 + 5000, tmux: 'x:@1.%7', name: 'orders-api-a1', kind: 'interactive' };
const LINES = [
  { type: 'user', timestamp: '2026-10-10T10:00:10.000Z', cwd: CWD, gitBranch: 'feat/checkout-v2', sessionId: 'S1', message: { role: 'user', content: 'Add idempotency keys' } },
  { type: 'ai-title', aiTitle: 'Idempotency keys for orders', sessionId: 'S1' },
  { type: 'assistant', timestamp: '2026-10-10T10:00:20.000Z', cwd: CWD, gitBranch: 'feat/checkout-v2', sessionId: 'S1', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }] } },
];

let root: string;
let events: RawEvent[];
let now: number;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'shq-fs-'));
  await mkdir(join(root, 'sessions'), { recursive: true });
  events = [];
  now = T0 + 60_000;
});

function adapter(overrides: Partial<FsAdapterOptions> = {}) {
  return new FsAdapter({
    claudeDir: root,
    emit: (e) => events.push(e),
    resolveWorkspace: async (cwd) => ({ cwd, repoRoot: cwd, repoName: 'orders-api', worktree: false, branch: 'feat/checkout-v2' }),
    probe: async (pids) => new Map(pids.map((p) => [p, T0 - 1000])),
    now: () => now,
    subagentScanMs: 0,
    transcriptRetryMs: 0,
    ...overrides,
  });
}
const writeSession = (data: object) => writeFile(join(root, 'sessions', '4242.json'), JSON.stringify(data));
async function writeTranscript(dirName: string, entries: object[]) {
  const dir = join(root, 'projects', dirName);
  await mkdir(dir, { recursive: true });
  const path = join(dir, 'S1.jsonl');
  await writeFile(path, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return path;
}

describe('FsAdapter', () => {
  it('encodes project directories like Claude Code', () => {
    expect(encodeProjectDir('/Users/me/Projects/fairmind.ai')).toBe('-Users-me-Projects-fairmind-ai');
  });

  it('discovers a live session and backfills its transcript', async () => {
    await writeSession(SESSION);
    const path = await writeTranscript(encodeProjectDir(CWD), LINES);
    await adapter().poll();
    expect(events.map((e) => e.type)).toEqual(['session.seen', 'prompt', 'branch', 'title', 'tool.started', 'session.status']);
    expect(events[0]).toMatchObject({ sessionId: 'S1', source: 'fs', pid: 4242, name: 'orders-api-a1', tmuxPane: '%7', transcriptPath: path, startedAt: T0, workspace: { cwd: CWD } });
    expect(events[4]).toMatchObject({ label: 'Bash: npm test', cwd: CWD });
    expect(events[5]).toMatchObject({ status: 'busy', ts: T0 + 5000 });
  });

  it('follows new lines and status changes without repeating old events', async () => {
    await writeSession(SESSION);
    const path = await writeTranscript(encodeProjectDir(CWD), LINES);
    const a = adapter();
    await a.poll();
    events.length = 0;
    await appendFile(path, JSON.stringify({ type: 'user', timestamp: '2026-10-10T10:00:30.000Z', cwd: CWD, gitBranch: 'feat/checkout-v2', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }) + '\n');
    await writeSession({ ...SESSION, status: 'idle', statusUpdatedAt: T0 + 40_000 });
    await a.poll();
    expect(events.map((e) => e.type)).toEqual(['session.status', 'tool.finished']);
    expect(events[0]).toMatchObject({ status: 'idle', ts: T0 + 40_000 });
  });

  it('ends a session once when its file goes away', async () => {
    await writeSession(SESSION);
    const a = adapter();
    await a.poll();
    events.length = 0;
    await rm(join(root, 'sessions', '4242.json'));
    await a.poll();
    await a.poll();
    expect(events).toEqual([{ type: 'session.ended', sessionId: 'S1', ts: now, source: 'fs', cwd: CWD, reason: 'process-gone' }]);
  });

  it('ignores a file whose pid now belongs to a newer process', async () => {
    await writeSession(SESSION);
    await adapter({ probe: async (pids) => new Map(pids.map((p) => [p, T0 + 10 * 60_000])) }).poll();
    expect(events).toEqual([]);
  });

  it('finds a transcript stored under a differently encoded directory', async () => {
    await writeSession(SESSION);
    const path = await writeTranscript('-w-shop-orders api (legacy)', LINES);
    await adapter().poll();
    expect(events[0]).toMatchObject({ type: 'session.seen', transcriptPath: path });
  });

  it('picks up a transcript that appears after the session', async () => {
    await writeSession(SESSION);
    const a = adapter();
    await a.poll();
    expect(events[0]).toMatchObject({ type: 'session.seen', transcriptPath: null });
    events.length = 0;
    const path = await writeTranscript(encodeProjectDir(CWD), LINES);
    await a.poll();
    expect(events.map((e) => e.type)).toEqual(['session.seen', 'prompt', 'branch', 'title', 'tool.started']);
    expect(events[0]).toMatchObject({ transcriptPath: path });
  });

  it('reports subagents that start and go quiet', async () => {
    await writeSession(SESSION);
    await writeTranscript(encodeProjectDir(CWD), LINES);
    const subDir = join(root, 'projects', encodeProjectDir(CWD), 'S1', 'subagents');
    await mkdir(subDir, { recursive: true });
    const agentFile = join(subDir, 'agent-a1.jsonl');
    await writeFile(agentFile, '{}\n');
    await writeFile(join(subDir, 'agent-a1.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'Find callers' }));
    await utimes(agentFile, now / 1000, now / 1000);
    const a = adapter();
    await a.poll();
    expect(events.find((e) => e.type === 'agent.started')).toMatchObject({ agentId: 'a1', agentType: 'Explore', description: 'Find callers' });
    events.length = 0;
    now += 120_000;
    await a.poll();
    expect(events.filter((e) => e.type.startsWith('agent.'))).toEqual([
      expect.objectContaining({ type: 'agent.finished', agentId: 'a1' }),
    ]);
  });
});

import { beforeEach, describe, expect, it } from 'vitest';
import { appendFile, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
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
  it('drains workflow usage after the host process exits', async () => {
    await writeSession(SESSION);
    await writeTranscript(encodeProjectDir(CWD), []);
    const dir = join(root, 'projects', encodeProjectDir(CWD), 'S1', 'subagents', 'workflows', 'wf_pending');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'journal.jsonl'), JSON.stringify({ type: 'started', agentId: 'a1', label: 'impl:1' }) + '\n');
    const entries = [1, 2, 3].map((i) => JSON.stringify({ type: 'assistant', pad: 'x'.repeat(190000), message: {
      id: `m${i}`, model: 'sonnet', usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    } }));
    await writeFile(join(dir, 'agent-a1.jsonl'), entries.join('\n') + '\n');
    const a = adapter();
    await a.poll();
    await rm(join(root, 'sessions', '4242.json'));
    now += 1000;
    await a.poll();
    events = [];
    now += 1000;
    await a.poll();
    expect(events).toContainEqual(expect.objectContaining({ type: 'agent.metrics', telemetry: expect.objectContaining({
      usage: { inputTokens: 30, outputTokens: 60, cacheReadTokens: 0, cacheWriteTokens: 0 }, complete: true,
    }) }));
    expect(events.some((e) => e.type === 'session.ended')).toBe(false);
  });

  it('encodes project directories like Claude Code', () => {
    expect(encodeProjectDir('/Users/me/Projects/fairmind.ai')).toBe('-Users-me-Projects-fairmind-ai');
  });

  it('ages its heartbeat while scans do not finish', async () => {
    await writeSession(SESSION);
    let hang = false;
    const a = adapter({ scanTimeoutMs: 20, probe: async (pids) => (hang ? new Promise(() => {}) : new Map(pids.map((p) => [p, T0 - 1000]))) });
    expect(a.health().lastScanAt).toBe(now);
    now += 5000;
    await a.poll();
    expect(a.health().lastScanAt).toBe(now);
    hang = true;
    const before = now;
    now += 5000;
    await a.poll();
    expect(a.health().lastScanAt).toBe(before);
  });

  it('recovers when a scan hangs', async () => {
    await writeSession(SESSION);
    let calls = 0;
    const a = adapter({
      scanTimeoutMs: 20,
      probe: async (pids) => {
        if (calls++ === 0) return new Promise(() => {});
        return new Map(pids.map((p) => [p, T0 - 1000]));
      },
    });
    await a.poll();
    expect(events).toEqual([]);
    await a.poll();
    expect(events.map((e) => e.type)).toContain('session.seen');
  });

  it('discovers a live session and backfills its transcript', async () => {
    await writeSession(SESSION);
    const path = await writeTranscript(encodeProjectDir(CWD), LINES);
    await adapter().poll();
    expect(events.map((e) => e.type)).toEqual(['session.seen', 'prompt', 'branch', 'title', 'tool.started', 'session.status']);
    expect(events[0]).toMatchObject({ sessionId: 'S1', source: 'fs', pid: 4242, name: 'orders-api-a1', tmuxPane: '%7', tmuxSession: 'x', transcriptPath: path, startedAt: T0, workspace: { cwd: CWD } });
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

  it('reports the sessions whose process is alive once, after its first scan that completes', async () => {
    await writeSession(SESSION);
    const reports: string[][] = [];
    let failing = true;
    const a = adapter({
      probe: async (pids) => {
        if (failing) {
          failing = false;
          throw new Error('ps failed');
        }
        return new Map(pids.map((p) => [p, T0 - 1000]));
      },
      onFirstScan: (live) => reports.push([...live]),
    });
    await a.poll();
    expect(reports).toEqual([]);
    await a.poll();
    await a.poll();
    expect(reports).toEqual([['S1']]);
  });

  describe('a scan that could not read', () => {
    let probeDown = false;
    const failures: Array<[string, (dir: string) => Promise<void>, (dir: string) => Promise<void>]> = [
      ['a missing sessions directory', async (dir) => rm(dir, { recursive: true, force: true }), async (dir) => { await mkdir(dir, { recursive: true }); }],
      ['a sessions path that is not a directory', async (dir) => { await rm(dir, { recursive: true, force: true }); await writeFile(dir, 'x'); }, async (dir) => { await rm(dir, { force: true }); await mkdir(dir, { recursive: true }); }],
      ['a probe that could not run ps', async () => { probeDown = true; }, async () => { probeDown = false; }],
    ];

    for (const [name, breakIt, restore] of failures) {
      it(`ends nothing and reports nothing on the first scan after ${name}, and the next scan that reads reports once`, async () => {
        await writeSession(SESSION);
        const dir = join(root, 'sessions');
        const reports: string[][] = [];
        probeDown = false;
        const a = adapter({
          probe: async (pids) => (probeDown ? null : new Map(pids.map((p) => [p, T0 - 1000]))),
          onFirstScan: (live) => reports.push([...live]),
        });
        const saved = await readFile(join(dir, '4242.json'), 'utf8');
        await breakIt(dir);
        await a.poll();
        expect(events).toEqual([]);
        expect(reports).toEqual([]);
        await a.poll();
        expect(reports).toEqual([]);
        await restore(dir);
        await writeFile(join(dir, '4242.json'), saved);
        await a.poll();
        expect(reports).toEqual([['S1']]);
        await a.poll();
        expect(reports).toEqual([['S1']]);
      });
    }

    it('ends no tracked session when a later scan could not read', async () => {
      await writeSession(SESSION);
      let probing = true;
      const dir = join(root, 'sessions');
      const a = adapter({ probe: async (pids) => (probing ? new Map(pids.map((p) => [p, T0 - 1000])) : null) });
      await a.poll();
      events.length = 0;
      probing = false;
      await a.poll();
      expect(events).toEqual([]);
      probing = true;
      const saved = await readFile(join(dir, '4242.json'), 'utf8');
      await rm(dir, { recursive: true });
      await a.poll();
      expect(events).toEqual([]);
      await mkdir(dir);
      await writeFile(join(dir, '4242.json'), saved);
      await a.poll();
      expect(events.filter((e) => e.type === 'session.ended')).toEqual([]);
    });

    it('still ends a tracked session once a scan that read finds it gone', async () => {
      await writeSession(SESSION);
      const a = adapter();
      await a.poll();
      events.length = 0;
      await rm(join(root, 'sessions', '4242.json'));
      await a.poll();
      expect(events.map((e) => e.type)).toEqual(['session.ended']);
    });

    it('reports an empty live set when the sessions directory exists and is empty', async () => {
      const reports: string[][] = [];
      await adapter({ onFirstScan: (live) => reports.push([...live]) }).poll();
      expect(reports).toEqual([[]]);
    });
  });

  it('ignores a file whose pid now belongs to a newer process', async () => {
    await writeSession(SESSION);
    await adapter({ probe: async (pids) => new Map(pids.map((p) => [p, T0 + 10 * 60_000])) }).poll();
    expect(events).toEqual([]);
  });

  it('never tracks or announces a session whose working directory is ignored', async () => {
    await writeSession({ ...SESSION, cwd: '/home/dev/.hopper-hq/summarizer' });
    await writeFile(join(root, 'sessions', '4343.json'), JSON.stringify({ ...SESSION, pid: 4343, sessionId: 'S2' }));
    const reports: string[][] = [];
    const a = adapter({ ignoreCwd: (cwd) => cwd.startsWith('/home/dev/.hopper-hq/summarizer'), onFirstScan: (live) => reports.push([...live]) });
    await a.poll();
    await a.poll();
    expect(events.map((e) => [e.type, e.sessionId])).toEqual([['session.seen', 'S2'], ['session.status', 'S2']]);
    expect(reports).toEqual([['S2']]);
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

  it("reads a subagent's meta file only when it is at most 64 KiB", async () => {
    await writeSession(SESSION);
    await writeTranscript(encodeProjectDir(CWD), LINES);
    const subDir = join(root, 'projects', encodeProjectDir(CWD), 'S1', 'subagents');
    await mkdir(subDir, { recursive: true });
    // Exactly 64 KiB, then one byte more.
    const meta = (description: string) => JSON.stringify({ agentType: 'Explore', description });
    for (const [id, size] of [['a1', 64 * 1024], ['a2', 64 * 1024 + 1]] as const) {
      await writeFile(join(subDir, `agent-${id}.jsonl`), '{}\n');
      await utimes(join(subDir, `agent-${id}.jsonl`), now / 1000, now / 1000);
      await writeFile(join(subDir, `agent-${id}.meta.json`), meta('x'.repeat(size - meta('').length)));
    }
    await adapter().poll();
    expect(Object.fromEntries(events.flatMap((e) => (e.type === 'agent.started' ? [[e.agentId, e.agentType]] : [])))).toEqual({ a1: 'Explore', a2: 'agent' });
  });
});

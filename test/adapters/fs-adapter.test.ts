import { beforeEach, describe, expect, it } from 'vitest';
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, utimes, writeFile } from 'node:fs/promises';
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
    branchRetryMs: 0,
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
    expect(events.map((e) => e.type)).toEqual(['session.seen', 'prompt', 'title', 'tool.started', 'session.status', 'branch']);
    expect(events[0]).toMatchObject({ sessionId: 'S1', source: 'fs', pid: 4242, name: 'orders-api-a1', tmuxPane: '%7', tmuxSession: 'x', transcriptPath: path, startedAt: T0, workspace: { cwd: CWD } });
    expect(events[3]).toMatchObject({ label: 'Bash: npm test', cwd: CWD });
    expect(events[4]).toMatchObject({ status: 'busy', ts: T0 + 5000 });
    expect(events[5]).toMatchObject({ branch: 'feat/checkout-v2', ts: Date.parse('2026-10-10T10:00:10.000Z') });
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
    expect(events.map((e) => e.type)).toEqual(['session.seen', 'prompt', 'title', 'tool.started', 'branch']);
    expect(events[0]).toMatchObject({ transcriptPath: path });
  });

  /** A checkout on `branch` whose HEAD file is `head` (by default one that does not exist, so it never changes). */
  const on = (branch: string, head = join(root, 'no-HEAD')) => ({ branch, watch: head });
  const branches = () => events.filter((e) => e.type === 'branch').map((e) => (e as { branch: string }).branch);
  const stamped = (branch: string, at: string) => JSON.stringify({ ...LINES[0], timestamp: at, gitBranch: branch }) + '\n';

  it("checks a transcript's branch against the checkout: a subagent's worktree branch is not the session's", async () => {
    await writeSession(SESSION);
    const path = await writeTranscript(encodeProjectDir(CWD), LINES);
    let onDisk = 'feat/checkout-v2';
    const asked: string[] = [];
    const a = adapter({ resolveBranch: async (cwd) => (asked.push(cwd), on(onDisk)) });
    await a.poll();
    expect(branches()).toEqual(['feat/checkout-v2']);
    events.length = 0;
    // Claude Code stamps the main session's line with the branch of the worktree a subagent works in.
    await appendFile(path, stamped('worktree-agent-a1b2', '2026-10-10T10:00:30.000Z'));
    await a.poll();
    expect(branches()).toEqual([]);
    expect(asked).toEqual([CWD, CWD]);
    // A real switch in the session's own checkout is reported.
    onDisk = 'feat/refunds';
    await appendFile(path, stamped('feat/refunds', '2026-10-10T10:00:40.000Z'));
    await a.poll();
    expect(events.filter((e) => e.type === 'branch')).toEqual([expect.objectContaining({ branch: 'feat/refunds', cwd: CWD })]);
  });

  it("reports the checkout's branch when the first stamp is a subagent's worktree branch", async () => {
    await writeSession(SESSION);
    await writeTranscript(encodeProjectDir(CWD), [{ ...LINES[0], gitBranch: 'worktree-agent-a1b2' }]);
    await adapter({ resolveBranch: async () => on('main') }).poll();
    expect(branches()).toEqual(['main']);
  });

  it("asks about the session's own checkout, whatever directory a line names", async () => {
    await writeSession(SESSION);
    await writeTranscript(encodeProjectDir(CWD), [{ ...LINES[0], cwd: `${CWD}/.claude/worktrees/agent-a1b2`, gitBranch: 'worktree-agent-a1b2' }]);
    const asked: string[] = [];
    await adapter({ resolveBranch: async (cwd) => (asked.push(cwd), on(cwd === CWD ? 'main' : 'worktree-agent-a1b2')) }).poll();
    expect(asked).toEqual([CWD]);
    expect(branches()).toEqual(['main']);
  });

  it('asks the checkout once a scan, however often the stamp changed', async () => {
    await writeSession(SESSION);
    const flips = ['main', 'worktree-agent-a1', 'main', 'worktree-agent-b2', 'ux-alignment'].map((b, i) => ({ ...LINES[0], timestamp: `2026-10-10T10:00:1${i}.000Z`, gitBranch: b }));
    await writeTranscript(encodeProjectDir(CWD), flips);
    let asked = 0;
    await adapter({ resolveBranch: async () => (asked++, on('main')) }).poll();
    expect(asked).toBe(1);
    expect(branches()).toEqual(['main']);
  });

  it('asks again, after a while, when the checkout could not tell, and keeps what it reported meanwhile', async () => {
    await writeSession(SESSION);
    const path = await writeTranscript(encodeProjectDir(CWD), LINES);
    let onDisk: string | null = 'main';
    let asked = 0;
    const a = adapter({ resolveBranch: async () => (asked++, onDisk === null ? null : on(onDisk)), branchRetryMs: 5000 });
    await a.poll();
    // A git that times out on the stamp of a real switch: the stamp is not repeated, the check is.
    onDisk = null;
    await appendFile(path, stamped('feat/refunds', '2026-10-10T10:00:30.000Z'));
    await a.poll();
    expect(branches()).toEqual(['main']);
    now += 4999;
    await a.poll();
    expect(asked).toBe(2);
    onDisk = 'feat/refunds';
    now += 1;
    await a.poll();
    expect(asked).toBe(3);
    expect(branches()).toEqual(['main', 'feat/refunds']);
  });

  it('reads on when the check fails, and asks again', async () => {
    await writeSession(SESSION);
    let fail = true;
    await writeTranscript(encodeProjectDir(CWD), LINES);
    const subDir = join(root, 'projects', encodeProjectDir(CWD), 'S1', 'subagents');
    await mkdir(subDir, { recursive: true });
    await writeFile(join(subDir, 'agent-a1.jsonl'), '{}\n');
    await utimes(join(subDir, 'agent-a1.jsonl'), now / 1000, now / 1000);
    const a = adapter({ resolveBranch: async () => { if (fail) throw new Error('git broke'); return on('main'); } });
    await a.poll();
    expect(events.map((e) => e.type)).toEqual(['session.seen', 'prompt', 'title', 'tool.started', 'session.status', 'agent.started']);
    fail = false;
    await a.poll();
    expect(branches()).toEqual(['main']);
  });

  it("notices a switch the transcript does not show, through the checkout's HEAD file", async () => {
    await writeSession(SESSION);
    await writeTranscript(encodeProjectDir(CWD), LINES);
    const head = join(root, 'HEAD');
    await writeFile(head, 'ref: refs/heads/main\n');
    await utimes(head, T0 / 1000, T0 / 1000);
    let onDisk = 'main';
    let asked = 0;
    const a = adapter({ resolveBranch: async () => (asked++, on(onDisk, head)) });
    await a.poll();
    await a.poll();
    expect(asked).toBe(1);
    // `git switch` in a terminal: no new line, but HEAD is written.
    onDisk = 'feat/refunds';
    await writeFile(head, 'ref: refs/heads/feat/refunds\n');
    await utimes(head, (T0 + 1000) / 1000, (T0 + 1000) / 1000);
    await a.poll();
    expect(asked).toBe(2);
    expect(events.filter((e) => e.type === 'branch')).toEqual([
      expect.objectContaining({ branch: 'main', ts: now }),
      expect.objectContaining({ branch: 'feat/refunds', ts: now }),
    ]);
  });

  it('waits longer after each check in a row that got no answer, and no stamp hurries it', async () => {
    await writeSession(SESSION);
    const path = await writeTranscript(encodeProjectDir(CWD), LINES);
    let asked = 0;
    const a = adapter({ resolveBranch: async () => (asked++, null), branchRetryMs: 100_000 });
    const pollAt = async (ms: number) => ((now = T0 + 60_000 + ms), a.poll());
    await pollAt(0);
    await pollAt(99_999);
    await appendFile(path, stamped('feat/refunds', '2026-10-10T10:00:30.000Z'));
    await pollAt(99_999);
    expect(asked).toBe(1);
    await pollAt(100_000);
    expect(asked).toBe(2);
    await pollAt(299_999);
    expect(asked).toBe(2);
    await pollAt(300_000);
    expect(asked).toBe(3);
    // Five minutes at most.
    await pollAt(599_999);
    expect(asked).toBe(3);
    await pollAt(600_000);
    expect(asked).toBe(4);
  });

  it("notices HEAD replaced within one mtime tick, by the file's identity", async () => {
    await writeSession(SESSION);
    await writeTranscript(encodeProjectDir(CWD), LINES);
    const head = join(root, 'HEAD');
    await writeFile(head, 'ref: refs/heads/main\n');
    await utimes(head, T0 / 1000, T0 / 1000);
    let onDisk = 'main';
    const a = adapter({ resolveBranch: async () => on(onDisk, head) });
    await a.poll();
    // Git writes HEAD.lock and renames it over HEAD: a new inode, on a file system whose clock did not tick.
    onDisk = 'feat/refunds';
    await writeFile(join(root, 'HEAD.lock'), 'ref: refs/heads/feat/refunds\n');
    await utimes(join(root, 'HEAD.lock'), T0 / 1000, T0 / 1000);
    await rename(join(root, 'HEAD.lock'), head);
    await a.poll();
    expect(branches()).toEqual(['main', 'feat/refunds']);
  });

  it('reports the branch again when a transcript found late announces the session with an older workspace', async () => {
    await writeSession(SESSION);
    const head = join(root, 'HEAD');
    await writeFile(head, 'ref: refs/heads/main\n');
    await utimes(head, T0 / 1000, T0 / 1000);
    let onDisk = 'main';
    // The daemon's workspace resolver caches: it still says main after the switch.
    const a = adapter({
      resolveWorkspace: async (cwd) => ({ cwd, repoRoot: cwd, repoName: 'orders-api', worktree: false, branch: 'main' }),
      resolveBranch: async () => on(onDisk, head),
    });
    await a.poll();
    onDisk = 'feat/refunds';
    await utimes(head, (T0 + 1000) / 1000, (T0 + 1000) / 1000);
    await a.poll();
    events.length = 0;
    // The first prompt writes the transcript, stamped with the branch as it was.
    await writeTranscript(encodeProjectDir(CWD), [{ ...LINES[0], gitBranch: 'main' }]);
    await a.poll();
    expect(events.map((e) => e.type)).toEqual(['session.seen', 'prompt', 'branch']);
    expect(events[0]).toMatchObject({ workspace: { branch: 'main' } });
    expect(events[2]).toMatchObject({ branch: 'feat/refunds' });
  });

  it("stamps a branch the transcript confirms with the line's time, and any other with the time it was found", async () => {
    await writeSession(SESSION);
    const path = await writeTranscript(encodeProjectDir(CWD), LINES);
    let onDisk = 'feat/checkout-v2';
    const a = adapter({ resolveBranch: async () => on(onDisk) });
    await a.poll();
    onDisk = 'main';
    await appendFile(path, stamped('worktree-agent-a1b2', '2026-10-10T10:00:30.000Z'));
    await a.poll();
    expect(events.filter((e) => e.type === 'branch')).toEqual([
      expect.objectContaining({ branch: 'feat/checkout-v2', ts: Date.parse('2026-10-10T10:00:10.000Z') }),
      expect.objectContaining({ branch: 'main', ts: now }),
    ]);
  });

  it('reports no branch when the checkout cannot tell', async () => {
    await writeSession(SESSION);
    await writeTranscript(encodeProjectDir(CWD), LINES);
    await adapter({ resolveBranch: async () => null }).poll();
    expect(events.map((e) => e.type)).toEqual(['session.seen', 'prompt', 'title', 'tool.started', 'session.status']);
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

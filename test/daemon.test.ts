import { describe, expect, it, vi } from 'vitest';
import { chmod, mkdir, mkdtemp, realpath, stat, utimes, writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeProjectDir } from '../src/adapters/claude-code/fs-adapter.js';
import { demoSummaryLine } from '../src/adapters/demo.js';
import { newSession } from '../src/core/reducer.js';
import type { RawEvent, Session, WorkflowRun } from '../src/core/types.js';
import { readDaemonFile } from '../src/daemon-file.js';
import { RETENTION_MS, startDaemon as startRawDaemon, type DaemonOptions } from '../src/daemon.js';
const startDaemon = async (opts: DaemonOptions) => startRawDaemon({ codexDir: await mkdtemp(join(tmpdir(), 'shq-codex-')), ...opts });
import { CSP } from '../src/server/headers.js';
import type { Seating } from '../src/scene/seating.js';
import { cleanText } from '../src/scene/text.js';
import { Store } from '../src/store/store.js';
import { writeSummaryConfig, type SummaryConfig } from '../src/summary/config.js';
import { SUMMARY_MAX, summaryInput } from '../src/summary/input.js';
import type { SummaryProvider } from '../src/summary/providers.js';
import { WS } from './helpers/events.js';
import { bearer, call } from './helpers/http.js';
import { isEvent, openSse } from './helpers/sse.js';

const tmp = (p: string) => mkdtemp(join(tmpdir(), p));
const quiet = () => {};

function health(port: number, token: string): Promise<number> {
  return new Promise((resolve, reject) => {
    request({ host: '127.0.0.1', port, path: '/api/health', headers: { authorization: `Bearer ${token}` } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    }).on('error', reject).end();
  });
}

describe('startDaemon', () => {
  it('writes a private daemon file, serves the API and cleans up on stop', async () => {
    const dataDir = await tmp('shq-data-');
    const d = await startDaemon({ port: 0, dataDir, claudeDir: await tmp('shq-claude-'), watchFiles: false, log: quiet });
    const info = await readDaemonFile(dataDir);
    expect(info).toMatchObject({ port: d.port, pid: process.pid });
    expect(info!.token).toMatch(/^[0-9a-f]{48}$/);
    expect((await stat(join(dataDir, 'daemon.json'))).mode & 0o077).toBe(0);
    expect((await stat(join(dataDir, 'token'))).mode & 0o077).toBe(0);
    expect(await health(d.port, info!.token)).toBe(200);
    await d.stop();
    expect(await readDaemonFile(dataDir)).toBeNull();
  });

  it('removes the daemon file even when the last save fails', async () => {
    const dataDir = await tmp('shq-data-');
    const d = await startDaemon({ port: 0, dataDir, claudeDir: await tmp('shq-claude-'), watchFiles: false, log: quiet });
    expect(await readDaemonFile(dataDir)).not.toBeNull();
    vi.spyOn(d.collector, 'close').mockRejectedValue(new Error('database is locked'));
    await expect(d.stop()).rejects.toThrow('database is locked');
    expect(await readDaemonFile(dataDir)).toBeNull();
  });

  it('keeps the same token across restarts', async () => {
    const dataDir = await tmp('shq-data-');
    const claudeDir = await tmp('shq-claude-');
    const a = await startDaemon({ port: 0, dataDir, claudeDir, watchFiles: false, log: quiet });
    const first = (await readDaemonFile(dataDir))!.token;
    await a.stop();
    const b = await startDaemon({ port: 0, dataDir, claudeDir, watchFiles: false, log: quiet });
    expect((await readDaemonFile(dataDir))!.token).toBe(first);
    await b.stop();
  });

  it('tells whoever runs it that the CLI asked it to stop', async () => {
    const dataDir = await tmp('shq-data-');
    const d = await startDaemon({ port: 0, dataDir, claudeDir: await tmp('shq-claude-'), watchFiles: false, log: quiet });
    try {
      const r = await call(d.port, { method: 'POST', path: '/api/shutdown', headers: bearer((await readDaemonFile(dataDir))!.token) });
      expect(r.status).toBe(202);
      await d.stopRequested;
    } finally {
      await d.stop();
    }
  });

  it('fails clearly when the port is taken', async () => {
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r));
    const port = (blocker.address() as AddressInfo).port;
    await expect(startDaemon({ port, dataDir: await tmp('shq-data-'), claudeDir: await tmp('shq-claude-'), watchFiles: false, log: quiet }))
      .rejects.toMatchObject({ code: 'EADDRINUSE' });
    await new Promise<void>((r) => blocker.close(() => r()));
  });
});

describe('startDaemon and the sessions it saved', () => {
  /** A data directory that holds one session, saved while it was working an hour ago, from a session file, and a Claude directory with no session file. */
  async function leftBehind(): Promise<{ dataDir: string; claudeDir: string }> {
    const dataDir = await tmp('shq-data-');
    const claudeDir = await tmp('shq-claude-');
    await mkdir(join(claudeDir, 'sessions'));
    const store = await Store.open(join(dataDir, 'hopper.db'));
    const cwd = '/w/alpha';
    store.saveSessions([{ ...newSession('S1', Date.now() - 60 * 60_000, { cwd, repoRoot: cwd, repoName: 'alpha', worktree: false, branch: 'main' }), state: 'working', pid: 4242 }], Date.now());
    store.close();
    return { dataDir, claudeDir };
  }

  it('ends a saved session whose process exited while it was down, once it has looked for the live ones', async () => {
    const d = await startDaemon({ port: 0, ...(await leftBehind()), log: quiet });
    try {
      for (let i = 0; i < 300 && d.collector.liveViews().length > 0; i++) await new Promise((r) => setTimeout(r, 10));
      expect(d.collector.liveViews()).toEqual([]);
      expect(d.collector.view('S1')?.state).toBe('ended');
    } finally {
      await d.stop();
    }
  });

  it('kills a run a saved session held open whose journal is older than the session file, once that file shows the session again', async () => {
    const dataDir = await tmp('shq-data-');
    const claudeDir = await tmp('shq-claude-');
    const cwd = '/home/dev/payments-svc';
    // The session's process is this test's own: it runs, and the file gives no start time to compare.
    await mkdir(join(claudeDir, 'sessions'));
    await writeFile(join(claudeDir, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: 'S1', cwd }));
    const project = join(claudeDir, 'projects', encodeProjectDir(cwd));
    await mkdir(project, { recursive: true });
    await writeFile(join(project, 'S1.jsonl'), '');
    // The run's journal was last written an hour ago, by an earlier process, and the run has no end file.
    const runDir = join(project, 'S1', 'subagents', 'workflows', 'wf_0000aaaa-001');
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, 'journal.jsonl'), JSON.stringify({ type: 'started', agentId: 'a1', label: 'plan', phase: 'Plan' }) + '\n');
    const hourAgo = (Date.now() - 60 * 60_000) / 1000;
    await utimes(join(runDir, 'journal.jsonl'), hourAgo, hourAgo);
    const run = { id: 'wf_0000aaaa-001', name: 'checkout-verify', summary: null, phases: [], currentPhase: null, status: 'running' as const, onDisk: true, startedAt: Date.now() - 120_000, endedAt: null, agents: [], agentsFinished: 0 };
    const store = await Store.open(join(dataDir, 'hopper.db'));
    store.saveSessions([{ ...newSession('S1', Date.now() - 60 * 60_000, { cwd, repoRoot: cwd, repoName: 'payments-svc', worktree: false, branch: 'main' }), state: 'in_meeting', pid: process.pid, runs: [run] }], Date.now());
    store.close();
    const d = await startDaemon({ port: 0, dataDir, claudeDir, log: quiet });
    try {
      // Nothing writes its journal any more and nothing will end it: the scan kills it.
      await vi.waitFor(() => expect(d.collector.session('S1')?.runs.map((r) => [r.id, r.status])).toEqual([['wf_0000aaaa-001', 'killed']]), { timeout: 5000 });
    } finally {
      await d.stop();
    }
  });

  it('forgets, as it starts, a session that ended more than the retention ago, and loads one that ended since', async () => {
    const dataDir = await tmp('shq-data-');
    const store = await Store.open(join(dataDir, 'hopper.db'));
    const ended = (id: string, ago: number): Session => ({ ...newSession(id, 1000, WS), state: 'ended', stateSince: Date.now() - ago });
    store.saveSessions([ended('LONG-AGO', RETENTION_MS + 60_000), ended('RECENT', 60_000)], Date.now());
    store.close();
    const d = await startDaemon({ port: 0, dataDir, claudeDir: await tmp('shq-claude-'), watchFiles: false, log: quiet });
    try {
      expect(d.collector.session('LONG-AGO')).toBeNull();
      expect(d.collector.session('RECENT')?.state).toBe('ended');
    } finally {
      await d.stop();
    }
  });

  it('leaves saved sessions as they are when it does not watch files', async () => {
    const d = await startDaemon({ port: 0, ...(await leftBehind()), watchFiles: false, log: quiet });
    try {
      await d.collector.idle();
      expect(d.collector.view('S1')?.state).toBe('working');
    } finally {
      await d.stop();
    }
  });
});

describe('startDaemon and the browser', () => {
  it('serves the UI bundle from uiDir', async () => {
    const uiDir = await tmp('shq-ui-');
    await mkdir(join(uiDir, 'assets'));
    await writeFile(join(uiDir, 'index.html'), '<!doctype html><title>hopper-hq</title>');
    await writeFile(join(uiDir, 'assets', 'index-abc.js'), 'export {};\n');
    const d = await startDaemon({ port: 0, dataDir: await tmp('shq-data-'), claudeDir: await tmp('shq-claude-'), watchFiles: false, log: quiet, uiDir });
    const index = await call(d.port, { path: '/ui/' });
    expect(index.status).toBe(200);
    expect(index.headers['content-security-policy']).toBe(CSP);
    expect((await call(d.port, { path: '/ui/assets/index-abc.js' })).status).toBe(200);
    await d.stop();
  });

  it('mints sign-in links itself', async () => {
    const d = await startDaemon({ port: 0, dataDir: await tmp('shq-data-'), claudeDir: await tmp('shq-claude-'), watchFiles: false, log: quiet });
    const link = new URL(d.loginUrl());
    expect(link.origin).toBe(`http://127.0.0.1:${d.port}`);
    expect((await call(d.port, { path: link.pathname + link.search })).status).toBe(303);
    await d.stop();
  });

  it('ends live views on stop', async () => {
    const dataDir = await tmp('shq-data-');
    const d = await startDaemon({ port: 0, dataDir, claudeDir: await tmp('shq-claude-'), watchFiles: false, log: quiet });
    const stream = await openSse(d.port, '/api/events', bearer((await readDaemonFile(dataDir))!.token));
    await stream.take(isEvent('scene'));
    await d.stop();
    await stream.ended;
  });
});

describe('startDaemon and summaries', () => {
  const hook = (sessionId: string, cwd: string, body: object): RawEvent => ({ sessionId, ts: Date.now(), source: 'hook', cwd, ...body }) as RawEvent;
  /** A provider that answers as `answer` says, and keeps the configs it was built for and the signals of its calls. */
  function standIn(answer: (input: string, signal: AbortSignal) => Promise<string>) {
    const configs: SummaryConfig[] = [];
    const signals: AbortSignal[] = [];
    const provider = (c: SummaryConfig): SummaryProvider => {
      configs.push(c);
      return { name: c.provider, model: c.model ?? 'haiku', summarize: (input, signal) => (signals.push(signal), answer(input, signal)) };
    };
    return { provider, configs, signals };
  }

  it("keeps the summarizer's directory private, and the sessions that run there out of the building", async () => {
    const dataDir = await tmp('shq-data-');
    // Made before, open to all: it is made private again.
    await mkdir(join(dataDir, 'summarizer'));
    await chmod(join(dataDir, 'summarizer'), 0o755);
    const d = await startDaemon({ port: 0, dataDir, claudeDir: await tmp('shq-claude-'), watchFiles: false, log: quiet });
    try {
      const dir = join(dataDir, 'summarizer');
      expect((await stat(dir)).mode & 0o777).toBe(0o700);
      const real = await realpath(dir);
      for (const [i, cwd] of [dir, join(real, 'sub'), real].entries()) await d.collector.ingest(hook(`X${i}`, cwd, { type: 'prompt', text: 'Summarize' }));
      await d.collector.ingest(hook('S1', `${real}-other`, { type: 'prompt', text: 'go' }));
      expect(d.collector.ignored).toBe(3);
      expect(d.collector.liveViews().map((v) => v.id)).toEqual(['S1']);
    } finally {
      await d.stop();
    }
  });

  it('never shows a session whose session file says it runs in the summarizer\'s directory', async () => {
    const dataDir = await tmp('shq-data-');
    const claudeDir = await tmp('shq-claude-');
    const dir = join(dataDir, 'summarizer');
    await mkdir(dir);
    await mkdir(join(claudeDir, 'sessions'));
    const file = (name: string, sessionId: string, cwd: string) => writeFile(join(claudeDir, 'sessions', name), JSON.stringify({ pid: process.pid, sessionId, cwd }));
    await file('a.json', 'X1', dir);
    await file('b.json', 'X2', await realpath(dir));
    await file('c.json', 'S1', '/home/dev/payments-svc');
    const d = await startDaemon({ port: 0, dataDir, claudeDir, log: quiet });
    try {
      await vi.waitFor(() => expect(d.collector.session('S1')).not.toBeNull(), { timeout: 5000 });
      await d.collector.idle();
      expect([d.collector.session('X1'), d.collector.session('X2'), d.collector.liveViews().map((v) => v.id)]).toEqual([null, null, ['S1']]);
      // The filesystem adapter leaves them out itself: the collector had nothing of theirs to drop.
      expect(d.collector.ignored).toBe(0);
    } finally {
      await d.stop();
    }
  });

  it('sends nothing to any provider while there is no config file', async () => {
    const dataDir = await tmp('shq-data-');
    const s = standIn(async () => 'Done: the login form works.');
    const d = await startDaemon({ port: 0, dataDir, claudeDir: await tmp('shq-claude-'), watchFiles: false, log: quiet, summarizer: { provider: s.provider, settleMs: 0 } });
    try {
      await d.collector.ingest(hook('S1', '/home/dev/shop', { type: 'prompt', text: 'Fix the login form' }));
      await d.collector.ingest(hook('S1', '/home/dev/shop', { type: 'turn.finished', backgroundTasks: 0 }));
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect([d.collector.session('S1')?.state, s.configs, s.signals]).toEqual(['done', [], []]);
    } finally {
      await d.stop();
    }
  });

  it('reports on summaries to the token only, from the config file as it changes', async () => {
    const dataDir = await tmp('shq-data-');
    const d = await startDaemon({ port: 0, dataDir, claudeDir: await tmp('shq-claude-'), watchFiles: false, log: quiet });
    try {
      const auth = bearer((await readDaemonFile(dataDir))!.token);
      const r = await call(d.port, { path: '/api/summaries', headers: auth });
      expect([r.status, r.json]).toEqual([200, { enabled: false, provider: 'claude-cli', model: 'haiku', lastOkAt: null, lastError: null, pausedUntil: null, queued: 0 }]);
      await writeSummaryConfig(dataDir, { enabled: true, model: 'sonnet' });
      expect((await call(d.port, { path: '/api/summaries', headers: auth })).json).toMatchObject({ enabled: true, provider: 'claude-cli', model: 'sonnet' });
      const link = new URL(d.loginUrl());
      const cookie = (await call(d.port, { path: link.pathname + link.search })).headers['set-cookie']![0]!.split(';')[0]!;
      expect((await call(d.port, { path: '/api/summaries', headers: { cookie } })).status).toBe(401);
      expect((await call(d.port, { path: '/api/summaries' })).status).toBe(401);
    } finally {
      await d.stop();
    }
  });

  it('summarizes a finished turn with the provider for its config', async () => {
    const dataDir = await tmp('shq-data-');
    await writeSummaryConfig(dataDir, { enabled: true });
    const s = standIn(async () => 'Done: the login form works.');
    const d = await startDaemon({ port: 0, dataDir, claudeDir: await tmp('shq-claude-'), watchFiles: false, log: quiet, summarizer: { provider: s.provider, settleMs: 0 } });
    try {
      await d.collector.ingest(hook('S1', '/home/dev/shop', { type: 'prompt', text: 'Fix the login form' }));
      await d.collector.ingest(hook('S1', '/home/dev/shop', { type: 'turn.finished', backgroundTasks: 0 }));
      await vi.waitFor(() => expect(d.collector.session('S1')?.summary?.text).toBe('Done: the login form works.'), { timeout: 5000 });
      expect(s.configs.at(-1)).toEqual({ enabled: true, provider: 'claude-cli', model: null });
    } finally {
      await d.stop();
    }
  });

  it('stops the summarizer when it stops, aborting the summary under way', async () => {
    const dataDir = await tmp('shq-data-');
    await writeSummaryConfig(dataDir, { enabled: true });
    const lines: string[] = [];
    const s = standIn((_input, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))));
    const d = await startDaemon({ port: 0, dataDir, claudeDir: await tmp('shq-claude-'), watchFiles: false, log: (l) => lines.push(l), summarizer: { provider: s.provider, settleMs: 0 } });
    try {
      await d.collector.ingest(hook('S1', '/home/dev/shop', { type: 'prompt', text: 'Fix the login form' }));
      await d.collector.ingest(hook('S1', '/home/dev/shop', { type: 'turn.finished', backgroundTasks: 0 }));
      await vi.waitFor(() => expect(s.signals).toHaveLength(1), { timeout: 5000 });
    } finally {
      await d.stop();
    }
    expect(s.signals[0]!.aborted).toBe(true);
    expect(lines.filter((l) => l.includes('summary failed'))).toEqual([]);
  });

  /**
   * A data directory holding session S1, done and seen, with summaries on, and a Claude directory where its process still
   * runs, with the end file of a run that ended since that process started. `held` says whether the saved row has the run.
   */
  async function restarted(held: boolean) {
    const dataDir = await tmp('shq-data-');
    const claudeDir = await tmp('shq-claude-');
    const cwd = '/home/dev/payments-svc';
    const R = 'wf_0000aaaa-001';
    // Whole seconds: file times keep them exactly.
    const now = Math.floor(Date.now() / 1000) * 1000;
    const [startedAt, runStart, runEnd, doneAt, seenAt] = [now - 50_000, now - 40_000, now - 30_000, now - 20_000, now - 10_000];
    await mkdir(join(claudeDir, 'sessions'));
    await writeFile(join(claudeDir, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: 'S1', cwd, startedAt }));
    const project = join(claudeDir, 'projects', encodeProjectDir(cwd));
    const runDir = join(project, 'S1', 'subagents', 'workflows', R);
    await mkdir(runDir, { recursive: true });
    await mkdir(join(project, 'S1', 'workflows'));
    await writeFile(join(project, 'S1.jsonl'), '');
    await writeFile(join(runDir, 'journal.jsonl'), [{ type: 'started', agentId: 'a1', label: 'plan', phase: 'Plan' }, { type: 'result', agentId: 'a1' }].map((l) => JSON.stringify(l) + '\n').join(''));
    await utimes(join(runDir, 'journal.jsonl'), (runEnd - 1000) / 1000, (runEnd - 1000) / 1000);
    const end = join(project, 'S1', 'workflows', `${R}.json`);
    await writeFile(end, JSON.stringify({ runId: R, workflowName: 'checkout-verify', status: 'completed', startTime: runStart, durationMs: runEnd - runStart, timestamp: new Date(runEnd).toISOString() }));
    await utimes(end, runEnd / 1000, runEnd / 1000);
    const run: WorkflowRun = {
      id: R, name: null, summary: null, phases: [], currentPhase: 'Plan', status: 'completed', onDisk: true, startedAt: runStart, endedAt: runEnd,
      agents: [{ id: 'a1', label: 'plan', phase: 'Plan', type: 'agent', running: false, startedAt: runStart, updatedAt: runEnd }], agentsFinished: 1,
    };
    const row: Session = {
      ...newSession('S1', startedAt, { cwd, repoRoot: cwd, repoName: 'payments-svc', worktree: false, branch: 'main' }),
      pid: process.pid, title: 'Verify the checkout', lastPrompt: 'Verify the checkout', lastAnswer: 'The checkout is verified.',
      state: 'done', stateSince: doneAt, seenAt, runs: held ? [run] : [],
    };
    const store = await Store.open(join(dataDir, 'hopper.db'));
    store.saveSessions([row], Date.now());
    store.close();
    await writeSummaryConfig(dataDir, { enabled: true });
    return { dataDir, claudeDir, row, run };
  }

  it('reads a run that ended before a restart again, leaving its seen session as it was, and summarizes nothing', async () => {
    for (const held of [true, false]) {
      const r = await restarted(held);
      const s = standIn(async () => 'Done: the checkout is verified.');
      const d = await startDaemon({ port: 0, dataDir: r.dataDir, claudeDir: r.claudeDir, log: quiet, summarizer: { provider: s.provider, settleMs: 0 } });
      try {
        // The end file names the run: once the name is in, the scan has read it.
        await vi.waitFor(() => expect(d.collector.session('S1')?.runs[0]?.name).toBe('checkout-verify'), { timeout: 5000 });
        await d.collector.idle();
        await new Promise((resolve) => setTimeout(resolve, 200));
        const after = d.collector.session('S1')!;
        expect([held, after.state, after.stateSince, after.seenAt, d.collector.view('S1')!.effectiveState]).toEqual([held, 'done', r.row.stateSince, r.row.seenAt, 'idle']);
        const expected = held ? { ...r.run, name: 'checkout-verify' } : { ...r.run, name: 'checkout-verify', currentPhase: null, agents: [], agentsFinished: 0 };
        expect(after.runs).toEqual([expected]);
        expect([s.configs, s.signals]).toEqual([[], []]);
      } finally {
        await d.stop();
      }
    }
  });

  it('keeps a session in the meeting its background subagent still holds across a restart, and stops the restored subagents the first scan finds no sign of', async () => {
    const dataDir = await tmp('shq-data-');
    const claudeDir = await tmp('shq-claude-');
    // Whole seconds: file times keep them exactly.
    const now = Math.floor(Date.now() / 1000) * 1000;
    const [meetingAt, heard, written, longAgo] = [now - 30_000, now - 25_000, now - 20_000, now - 5 * 60 * 60 * 1000];
    await mkdir(join(claudeDir, 'sessions'));
    const rows: Session[] = [];
    // S1 and S2 wait in a meeting on a background subagent that wrote its transcript 20 s ago. The store last heard of it
    // before that write (S1) or at it (S2). S3's meeting began 5 h ago, and its subagent has written nothing since. Each
    // session file says the main turn ended when the meeting began: read again, that must not end the meeting.
    for (const [id, since, lastHeard, wrote] of [['S1', meetingAt, heard, written], ['S2', meetingAt, written, written], ['S3', longAgo, longAgo, longAgo]] as const) {
      const cwd = `/home/dev/billing-${id.toLowerCase()}`;
      const project = join(claudeDir, 'projects', encodeProjectDir(cwd));
      const subagents = join(project, id, 'subagents');
      await mkdir(subagents, { recursive: true });
      await writeFile(join(project, `${id}.jsonl`), '');
      await writeFile(join(subagents, 'agent-bg1.meta.json'), JSON.stringify({ agentType: 'general-purpose', description: 'Audit the invoices' }));
      await writeFile(join(subagents, 'agent-bg1.jsonl'), '{}\n');
      await utimes(join(subagents, 'agent-bg1.jsonl'), wrote / 1000, wrote / 1000);
      await writeFile(join(claudeDir, 'sessions', `${id}.json`), JSON.stringify({ pid: process.pid, sessionId: id, cwd, status: 'idle', statusUpdatedAt: since }));
      rows.push({
        ...newSession(id, since - 60_000, { cwd, repoRoot: cwd, repoName: `billing-${id.toLowerCase()}`, worktree: false, branch: 'main' }),
        pid: process.pid, title: 'Audit the invoices', state: 'in_meeting', stateSince: since, backgroundTasks: 1, lastEventAt: since, lastSeq: 5,
        children: [{ id: 'bg1', type: 'general-purpose', description: 'Audit the invoices', running: true, lastAction: null, updatedAt: lastHeard }],
      });
    }
    // S4's process is gone, and so is its session file: it ends once the first scan is over.
    const shop = '/home/dev/shop';
    rows.push({ ...newSession('S4', meetingAt, { cwd: shop, repoRoot: shop, repoName: 'shop', worktree: false, branch: 'main' }), pid: process.pid, state: 'done', stateSince: meetingAt, seenAt: meetingAt });
    const store = await Store.open(join(dataDir, 'hopper.db'));
    store.saveSessions(rows, Date.now());
    store.close();
    await writeSummaryConfig(dataDir, { enabled: true });
    const s = standIn(async () => 'Waits for the invoice audit.');
    const d = await startDaemon({ port: 0, dataDir, claudeDir, log: quiet, summarizer: { provider: s.provider, settleMs: 0 } });
    try {
      await vi.waitFor(() => expect(d.collector.session('S4')?.state).toBe('ended'), { timeout: 5000 });
      await d.collector.idle();
      const shown = (id: string) => {
        const v = d.collector.view(id)!;
        return [id, v.state, v.stateSince, v.seenAt, v.effectiveState, v.children.map((c) => [c.id, c.type, c.running, c.updatedAt, c.restored ?? false])];
      };
      expect(['S1', 'S2', 'S3'].map(shown)).toEqual([
        ['S1', 'in_meeting', meetingAt, null, 'in_meeting', [['bg1', 'general-purpose', true, written, false]]],
        ['S2', 'in_meeting', meetingAt, null, 'in_meeting', [['bg1', 'general-purpose', true, written, false]]],
        // Its meeting ended while the daemon was away, as of when it began: no news.
        ['S3', 'done', longAgo, null, 'idle', [['bg1', 'general-purpose', false, longAgo, true]]],
      ]);
      expect(d.collector.attentionSummary().items).toEqual([]);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect([s.configs, s.signals]).toEqual([[], []]);
    } finally {
      await d.stop();
    }
  });

  it('stops the subagents a session was saved with as it starts when it does not watch the files', async () => {
    const dataDir = await tmp('shq-data-');
    const cwd = '/home/dev/billing-svc';
    const now = Date.now();
    const store = await Store.open(join(dataDir, 'hopper.db'));
    store.saveSessions([{
      ...newSession('S1', now - 60_000, { cwd, repoRoot: cwd, repoName: 'billing-svc', worktree: false, branch: 'main' }),
      pid: process.pid, state: 'in_meeting', stateSince: now - 30_000, lastEventAt: now - 30_000,
      children: [{ id: 'bg1', type: 'general-purpose', description: 'Audit the invoices', running: true, lastAction: null, updatedAt: now - 20_000 }],
    }], now);
    store.close();
    const d = await startDaemon({ port: 0, dataDir, claudeDir: await tmp('shq-claude-'), watchFiles: false, log: quiet });
    try {
      const s = d.collector.session('S1')!;
      expect([s.state, s.stateSince, s.children.map((c) => c.running)]).toEqual(['done', now - 30_000, [false]]);
    } finally {
      await d.stop();
    }
  });

  it('summarizes the demo with its own lines', async () => {
    const dataDir = await tmp('shq-demo-');
    const d = await startDaemon({ demo: true, port: 0, dataDir, log: quiet, summarizer: { settleMs: 0 } });
    try {
      await vi.waitFor(() => expect(d.collector.session('demo-sw-b2')?.summary?.text).toEqual(expect.any(String)), { timeout: 5000 });
      const session: Session = d.collector.session('demo-sw-b2')!;
      expect(session.summary!.text).toBe(cleanText(demoSummaryLine(summaryInput(session)!.text), SUMMARY_MAX));
      const r = await call(d.port, { path: '/api/summaries', headers: bearer((await readDaemonFile(dataDir))!.token) });
      expect(r.json).toMatchObject({ enabled: true, provider: 'demo', model: null, lastError: null });
    } finally {
      await d.stop();
    }
  });
});

describe('startDaemon and seating', () => {
  it('keeps every seat across a restart: desks, a lounge sitter, rooms and the plan size', async () => {
    const dataDir = await tmp('shq-data-');
    const claudeDir = await tmp('shq-claude-');
    const cwd = '/home/dev/payments-svc';
    const key = `repo:${cwd}`;
    const now = Date.now();
    const ws = { cwd, repoRoot: cwd, repoName: 'payments-svc', worktree: false, branch: 'main' };
    const run: WorkflowRun = { id: 'wf_0000aaaa-001', name: null, summary: null, phases: [], currentPhase: null, status: 'running', onDisk: true, startedAt: now - 60_000, endedAt: null, agents: [], agentsFinished: 0 };
    // Nine working sessions grow the floor a block; S1 runs a workflow, which holds a room. S10 is done and seen: it rests in the lounge.
    const rows: Session[] = Array.from({ length: 9 }, (_, i) => ({ ...newSession(`S${i + 1}`, now - 60_000 + i, ws), state: 'working' as const, stateSince: now - 1000, lastEventAt: now - 1000 }));
    rows[0] = { ...rows[0]!, runs: [run] };
    rows.push({ ...newSession('S10', now - 50_000, ws), state: 'done', stateSince: now - 30_000, seenAt: now - 20_000 });
    const store = await Store.open(join(dataDir, 'hopper.db'));
    store.saveSessions(rows, now);
    store.close();

    const a = await startDaemon({ port: 0, dataDir, claudeDir, watchFiles: false, log: quiet });
    let seated: Seating | null = null;
    try {
      a.collector.scene();
      seated = a.collector.seatingOf(key);
      expect(seated).toEqual({
        blocks: 2,
        roomCols: 1,
        desks: [...['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'S10'], ...Array(6).fill(null)],
        lounge: ['S10', ...Array(7).fill(null)],
        rooms: ['wf_0000aaaa-001', null],
      });
    } finally {
      await a.stop();
    }
    const b = await startDaemon({ port: 0, dataDir, claudeDir, watchFiles: false, log: quiet });
    try {
      const restored = b.collector.seatingOf(key);
      expect(restored).toEqual(seated);
      b.collector.scene();
      expect(b.collector.seatingOf(key)).toBe(restored);
    } finally {
      await b.stop();
    }
  });
});

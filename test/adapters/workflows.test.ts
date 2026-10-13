import { beforeEach, describe, expect, it } from 'vitest';
import { appendFile, mkdir, mkdtemp, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeProjectDir, FsAdapter } from '../../src/adapters/claude-code/fs-adapter.js';
import { MAX_FOLLOWED_RUNS, WorkflowScanner } from '../../src/adapters/claude-code/workflows.js';
import type { RawEvent } from '../../src/core/types.js';
import { launchText, resultEntry } from '../helpers/workflows.js';

const T0 = Date.parse('2026-10-10T10:00:00.000Z');
const NOW = T0 + 60_000;
const SID = '11111111-1111-4111-8111-111111111111';
const CWD = '/home/dev/shop/payments-svc';
const R1 = 'wf_0000aaaa-001';
const R2 = 'wf_0000aaaa-002';
const OLD = T0 - 3_600_000;
const NEW = T0 + 10_000;
const META = `export const meta = {
  name: 'checkout-verify',
  description: 'Verify split payments end to end',
  phases: [{ title: 'Plan' }, { title: 'Build' }, { title: 'Review' }],
}
export default async function run() {}
`;

let root: string;
let session: string;
let events: RawEvent[];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'shq-wf-'));
  session = join(root, 'projects', encodeProjectDir(CWD), SID);
  await mkdir(join(session, 'workflows', 'scripts'), { recursive: true });
  events = [];
});

const at = (path: string, ms: number) => utimes(path, ms / 1000, ms / 1000);
const runDir = (id: string) => join(session, 'subagents', 'workflows', id);
const line = (o: object) => JSON.stringify(o) + '\n';

/** A run's directory with its journal (written at `written`) and the meta files of its agents. */
async function writeRun(id: string, journal: object[], written: number, types: Record<string, string> = {}) {
  await mkdir(runDir(id), { recursive: true });
  for (const [agentId, agentType] of Object.entries(types)) {
    await writeFile(join(runDir(id), `agent-${agentId}.meta.json`), JSON.stringify({ agentType, description: 'ignored', workflowPhase: 'Plan' }));
  }
  const path = join(runDir(id), 'journal.jsonl');
  await writeFile(path, journal.map((o) => line(o)).join(''));
  await at(path, written);
}

/** A run's end file, written at `written`. */
async function writeEnd(id: string, data: object | string, written: number) {
  const path = join(session, 'workflows', `${id}.json`);
  await writeFile(path, typeof data === 'string' ? data : JSON.stringify(data));
  await at(path, written);
}

async function writeScript(name: string, source = META) {
  const path = join(session, 'workflows', 'scripts', name);
  await writeFile(path, source);
  return path;
}

function scanner(since = T0, open: string[] = []) {
  return new WorkflowScanner({ sessionId: SID, cwd: CWD, since, open, emit: (e) => events.push(e) });
}

/** The events of one scan, without the fields every one carries. */
async function scan(s: WorkflowScanner, now = NOW) {
  events = [];
  await s.scan(session, now);
  for (const e of events) expect(e).toMatchObject({ sessionId: SID, ts: now, source: 'fs', cwd: CWD });
  return events.map(({ sessionId: _s, ts: _t, source: _o, cwd: _c, ...rest }) => rest);
}

const started = (agentId: string, label: string, phase: string) => ({ type: 'started', key: `v2:${agentId}`, agentId, label, phase });
const result = (agentId: string) => ({ type: 'result', key: `v2:${agentId}`, agentId, result: { ok: true } });

describe('WorkflowScanner', () => {
  it('follows a run launched since the session began: its summary, its script, its journal across scans, and its end', async () => {
    // The journal's `failed` line ends an agent as its `result` line does.
    const s = scanner();
    s.noteLaunch({ runId: R1, summary: 'Verify split payments end to end', scriptPath: await writeScript(`checkout-verify-${R1}.js`) });
    await writeRun(R1, [
      { type: 'launched' },
      started('a1', 'plan:orders', 'Plan'),
      started('a2', `impl:${'x'.repeat(300)}`, ''),
      result('a1'),
      { type: 'failed', key: 'v2:a2', agentId: 'a2' },
      { type: 'started', label: 'no id', phase: 'Plan' },
      started('../a3', 'escape', 'Plan'),
    ], NEW, { a1: 'workflow-subagent' });
    await appendFile(join(runDir(R1), 'journal.jsonl'), 'not json\n');
    expect(await scan(s)).toEqual([
      { type: 'workflow.started', runId: R1, summary: 'Verify split payments end to end' },
      { type: 'workflow.started', runId: R1, name: 'checkout-verify', summary: 'Verify split payments end to end', phases: ['Plan', 'Build', 'Review'] },
      { type: 'agent.started', agentId: 'a1', agentType: 'workflow-subagent', description: 'plan:orders', runId: R1, phase: 'Plan' },
      { type: 'agent.started', agentId: 'a2', agentType: 'agent', description: `impl:${'x'.repeat(194)}\u2026`, runId: R1, phase: null },
      { type: 'agent.finished', agentId: 'a1' },
      { type: 'agent.finished', agentId: 'a2' },
    ]);
    await appendFile(join(runDir(R1), 'journal.jsonl'), line(started('a4', 'review:orders', 'Review')));
    expect(await scan(s, NOW + 3000)).toEqual([{ type: 'agent.started', agentId: 'a4', agentType: 'agent', description: 'review:orders', runId: R1, phase: 'Review' }]);
    await writeEnd(R1, { runId: R1, workflowName: 'checkout-verify', summary: 'Verify split payments', status: 'failed', phases: [{ title: 'Plan' }, { title: 3 }, 'Build', { title: 'Ship' }], script: 'x', result: [] }, NOW);
    expect(await scan(s, NOW + 6000)).toEqual([
      { type: 'workflow.started', runId: R1, name: 'checkout-verify', summary: 'Verify split payments', phases: ['Plan', 'Ship'] },
      { type: 'workflow.finished', runId: R1, status: 'failed' },
    ]);
    await appendFile(join(runDir(R1), 'journal.jsonl'), line(started('a5', 'late', 'Ship')));
    expect(await scan(s, NOW + 9000)).toEqual([]);
  });

  it('takes a run as history when it ended, or last wrote its journal, before the session began, and never looks at it again', async () => {
    const s = scanner();
    s.noteLaunch({ runId: 'wf_0000aaaa-h01', summary: 'An old run', scriptPath: await writeScript('old.js') });
    await writeRun('wf_0000aaaa-h01', [started('h1', 'old', 'Plan')], OLD);
    await writeEnd('wf_0000aaaa-h01', { status: 'completed' }, OLD);
    await writeRun('wf_0000aaaa-h02', [started('h2', 'old', 'Plan')], OLD);
    await writeRun('wf_0000aaaa-l01', [started('l1', 'ended since', 'Plan')], OLD);
    await writeEnd('wf_0000aaaa-l01', { status: 'killed' }, NEW);
    await writeRun('wf_0000aaaa-l02', [started('l2', 'live', 'Plan')], NEW);
    await mkdir(join(session, 'subagents', 'workflows', 'notes'));
    await mkdir(join(session, 'subagents', 'workflows', 'wf_0000aaaa.003'));
    expect(await scan(s)).toEqual([
      { type: 'workflow.started', runId: 'wf_0000aaaa-l01' },
      { type: 'workflow.started', runId: 'wf_0000aaaa-l02' },
      { type: 'agent.started', agentId: 'l1', agentType: 'agent', description: 'ended since', runId: 'wf_0000aaaa-l01', phase: 'Plan' },
      { type: 'workflow.finished', runId: 'wf_0000aaaa-l01', status: 'killed' },
      { type: 'agent.started', agentId: 'l2', agentType: 'agent', description: 'live', runId: 'wf_0000aaaa-l02', phase: 'Plan' },
    ]);
    await writeEnd('wf_0000aaaa-h01', { status: 'completed' }, NOW);
    await appendFile(join(runDir('wf_0000aaaa-h02'), 'journal.jsonl'), line(started('h3', 'resumed', 'Plan')));
    await at(join(runDir('wf_0000aaaa-h02'), 'journal.jsonl'), NOW);
    expect(await scan(s, NOW + 3000)).toEqual([]);
  });

  it('waits for the journal of a run directory that has none yet, and takes a run its transcript launched later', async () => {
    const s = scanner();
    await mkdir(runDir(R1), { recursive: true });
    expect(await scan(s)).toEqual([]);
    await writeRun(R1, [{ type: 'launched' }], NEW);
    expect(await scan(s, NOW + 3000)).toEqual([{ type: 'workflow.started', runId: R1 }]);
    s.noteLaunch({ runId: R1, summary: 'Verify split payments end to end', scriptPath: await writeScript(`checkout-verify-${R1}.js`) });
    expect(await scan(s, NOW + 6000)).toEqual([
      { type: 'workflow.started', runId: R1, summary: 'Verify split payments end to end' },
      { type: 'workflow.started', runId: R1, name: 'checkout-verify', summary: 'Verify split payments end to end', phases: ['Plan', 'Build', 'Review'] },
    ]);
    expect(await scan(s, NOW + 9000)).toEqual([]);
  });

  it("reads a script only as a regular file of at most 256 KiB whose real path is in the session's scripts directory", async () => {
    const s = scanner();
    const outside = join(root, 'elsewhere.js');
    await writeFile(outside, META);
    await symlink(outside, join(session, 'workflows', 'scripts', 'linked.js'));
    await mkdir(join(session, 'workflows', 'scripts', 'folder.js'));
    const paths = [
      outside,
      join(session, 'workflows', 'scripts', '..', '..', '..', 'elsewhere.js'),
      join(session, 'workflows', 'scripts', 'linked.js'),
      join(session, 'workflows', 'scripts', 'folder.js'),
      await writeScript('big.js', META + ' '.repeat(256 * 1024)),
      `workflows/scripts/${R1}.js`,
      join(session, 'workflows', 'scripts', 'missing.js'),
    ];
    const ids = paths.map((_, i) => `wf_0000bbbb-00${i}`);
    for (const [i, id] of ids.entries()) {
      s.noteLaunch({ runId: id, summary: `Run ${i}`, scriptPath: paths[i]! });
      await writeRun(id, [], NEW);
    }
    expect(await scan(s)).toEqual(ids.map((id, i) => ({ type: 'workflow.started', runId: id, summary: `Run ${i}` })));
    const inside = scanner();
    await writeScript('ok.js');
    inside.noteLaunch({ runId: R2, summary: null, scriptPath: join(session, 'workflows', 'scripts', '..', 'scripts', 'ok.js') });
    await writeRun(R2, [], NEW);
    expect((await scan(inside)).filter((e) => 'runId' in e && e.runId === R2)).toEqual([
      { type: 'workflow.started', runId: R2 },
      { type: 'workflow.started', runId: R2, name: 'checkout-verify', summary: 'Verify split payments end to end', phases: ['Plan', 'Build', 'Review'] },
    ]);
  });

  it('ends a run whose end file is too big or unreadable as completed, without reading it', async () => {
    const s = scanner();
    await writeRun(R1, [], NEW);
    await writeRun(R2, [], NEW);
    await writeRun('wf_0000aaaa-003', [], NEW);
    await writeEnd(R1, `{"workflowName":"big","status":"failed","pad":"${'p'.repeat(8 * 1024 * 1024)}"}`, NEW);
    await writeEnd(R2, '{ not json', NEW);
    await writeEnd('wf_0000aaaa-003', { workflowName: 'odd', status: 'paused' }, NEW);
    expect(await scan(s)).toEqual([
      { type: 'workflow.started', runId: R1 },
      { type: 'workflow.started', runId: R2 },
      { type: 'workflow.started', runId: 'wf_0000aaaa-003' },
      { type: 'workflow.finished', runId: R1, status: 'completed' },
      { type: 'workflow.finished', runId: R2, status: 'completed' },
      { type: 'workflow.started', runId: 'wf_0000aaaa-003', name: 'odd' },
      { type: 'workflow.finished', runId: 'wf_0000aaaa-003', status: 'completed' },
    ]);
  });

  it('follows at most MAX_FOLLOWED_RUNS runs at once: a new run waits until one ends', async () => {
    const s = scanner();
    const id = (i: number) => `wf_0000cccc-${String(i).padStart(3, '0')}`;
    for (let i = 1; i <= 17; i++) await writeRun(id(i), [], NEW);
    expect(MAX_FOLLOWED_RUNS).toBe(16);
    expect(await scan(s)).toEqual(Array.from({ length: 16 }, (_, i) => ({ type: 'workflow.started', runId: id(i + 1) })));
    await writeEnd(id(1), { status: 'completed' }, NOW);
    expect(await scan(s, NOW + 3000)).toEqual([{ type: 'workflow.finished', runId: id(1), status: 'completed' }]);
    expect(await scan(s, NOW + 6000)).toEqual([{ type: 'workflow.started', runId: id(17) }]);
  });
});

describe('WorkflowScanner with the runs the collector holds open', () => {
  it('settles each open run whatever its age: by its end file, by following it, or as killed with an earlier process', async () => {
    const id = (i: number) => `wf_0000dddd-00${i}`;
    const s = scanner(T0, [id(1), id(2), id(3), id(4), 'not-a-run']);
    await writeRun(id(1), [started('o1', 'old', 'Plan')], OLD);
    await writeEnd(id(1), { workflowName: 'nightly', status: 'failed' }, OLD);
    await writeRun(id(2), [started('o2', 'still going', 'Build')], NEW);
    await writeRun(id(3), [started('o3', 'died', 'Plan')], OLD);
    await writeRun(id(5), [started('o5', 'old and not open', 'Plan')], OLD);
    expect(await scan(s)).toEqual([
      { type: 'workflow.started', runId: id(1) },
      { type: 'workflow.started', runId: id(2) },
      { type: 'workflow.finished', runId: id(3), status: 'killed' },
      { type: 'workflow.finished', runId: id(4), status: 'killed' },
      { type: 'agent.started', agentId: 'o1', agentType: 'agent', description: 'old', runId: id(1), phase: 'Plan' },
      { type: 'workflow.started', runId: id(1), name: 'nightly' },
      { type: 'workflow.finished', runId: id(1), status: 'failed' },
      { type: 'agent.started', agentId: 'o2', agentType: 'agent', description: 'still going', runId: id(2), phase: 'Build' },
    ]);
    expect(await scan(s, NOW + 3000)).toEqual([]);
  });
});

describe('FsAdapter with workflow runs', () => {
  it("takes up a live session's run with its launch, and nothing for its transcript's launches whose runs are history", async () => {
    await mkdir(join(root, 'sessions'), { recursive: true });
    await writeFile(join(root, 'sessions', '4242.json'), JSON.stringify({ pid: 4242, sessionId: SID, cwd: CWD, startedAt: T0, status: 'idle', statusUpdatedAt: T0 + 5000 }));
    const script = await writeScript(`checkout-verify-${R1}.js`);
    await writeFile(join(session + '.jsonl'), [
      resultEntry(launchText({ runId: R2, summary: 'Yesterday', scriptPath: script }), '2026-10-09T10:00:00.000Z'),
      resultEntry(launchText({ runId: R1, summary: 'Verify split payments end to end', scriptPath: script })),
    ].map((o) => line(o)).join(''));
    await writeRun(R2, [started('b1', 'old', 'Plan')], OLD);
    await writeEnd(R2, { status: 'completed' }, OLD);
    await writeRun(R1, [started('a1', 'plan:orders', 'Plan')], NEW, { a1: 'workflow-subagent' });
    const a = new FsAdapter({
      claudeDir: root,
      emit: (e) => events.push(e),
      resolveWorkspace: async (cwd) => ({ cwd, repoRoot: cwd, repoName: 'payments-svc', worktree: false, branch: 'feat/checkout-v2' }),
      probe: async (pids) => new Map(pids.map((p) => [p, T0 - 1000])),
      now: () => NOW,
      subagentScanMs: 0,
    });
    await a.poll();
    const workflow = events.filter((e) => e.type.startsWith('workflow.') || e.type.startsWith('agent.'));
    expect(workflow).toEqual([
      { sessionId: SID, ts: NOW, source: 'fs', cwd: CWD, type: 'workflow.started', runId: R1, summary: 'Verify split payments end to end' },
      { sessionId: SID, ts: NOW, source: 'fs', cwd: CWD, type: 'workflow.started', runId: R1, name: 'checkout-verify', summary: 'Verify split payments end to end', phases: ['Plan', 'Build', 'Review'] },
      { sessionId: SID, ts: NOW, source: 'fs', cwd: CWD, type: 'agent.started', agentId: 'a1', agentType: 'workflow-subagent', description: 'plan:orders', runId: R1, phase: 'Plan' },
    ]);
  });

  it('asks once, as it starts tracking a session, which runs the collector holds open, and kills the one that died', async () => {
    await mkdir(join(root, 'sessions'), { recursive: true });
    await writeFile(join(root, 'sessions', '4242.json'), JSON.stringify({ pid: 4242, sessionId: SID, cwd: CWD, startedAt: T0, status: 'idle', statusUpdatedAt: T0 + 5000 }));
    await writeFile(join(session + '.jsonl'), '');
    await writeRun(R2, [started('b1', 'before the restart', 'Plan')], OLD);
    const asked: string[] = [];
    const a = new FsAdapter({
      claudeDir: root,
      emit: (e) => events.push(e),
      resolveWorkspace: async (cwd) => ({ cwd, repoRoot: cwd, repoName: 'payments-svc', worktree: false, branch: 'feat/checkout-v2' }),
      probe: async (pids) => new Map(pids.map((p) => [p, T0 - 1000])),
      now: () => NOW,
      subagentScanMs: 0,
      openRuns: (sessionId) => {
        asked.push(sessionId);
        return [R2];
      },
    });
    await a.poll();
    await a.poll();
    expect(asked).toEqual([SID]);
    expect(events.filter((e) => e.type.startsWith('workflow.'))).toEqual([{ sessionId: SID, ts: NOW, source: 'fs', cwd: CWD, type: 'workflow.finished', runId: R2, status: 'killed' }]);
  });
});

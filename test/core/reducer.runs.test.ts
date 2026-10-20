import { describe, expect, it } from 'vitest';
import { applyEvent, liveRun, markSeen, MAX_DROPPED_AGENTS, MAX_RUN_AGENTS, MAX_RUNS, newSession, normalizeSession, RUN_ID } from '../../src/core/reducer.js';
import type { CollectorEvent, Session } from '../../src/core/types.js';
import { ev, seen, WS } from '../helpers/events.js';

function run(...events: CollectorEvent[]): Session {
  let s: Session | undefined;
  for (const e of events) s = applyEvent(s, e);
  if (!s) throw new Error('no session');
  return s;
}

const R = 'wf_0000aaaa-001';
const R2 = 'wf_0000aaaa-002';
/** An agent of run R, as the run's journal reports it. */
const fsAgent = (ts: number, agentId: string, phase: string | null = 'Build') =>
  ev('agent.started', ts, { agentId, agentType: 'workflow-subagent', description: `step ${agentId}`, runId: R, phase, source: 'fs' });
/** An agent of run R, as the mod reports its spawn. */
const hookAgent = (ts: number, agentId: string) => ev('agent.started', ts, { agentId, agentType: 'workflow-subagent', description: `step ${agentId}`, runId: R, phase: null });
const ids = (s: Session) => s.runs.map((r) => r.id);

describe('workflow runs', () => {
  it('exports the caps and the run id pattern', () => {
    expect([MAX_RUNS, MAX_RUN_AGENTS]).toEqual([10, 64]);
    expect(['wf_0000aaaa-001', 'wf_A_b-9', `wf_${'a'.repeat(64)}`].map((id) => RUN_ID.test(id))).toEqual([true, true, true]);
    expect(['wf_', 'wf_a/b', 'wf_a.b', `wf_${'a'.repeat(65)}`, 'xwf_a', 'WF_a', ''].map((id) => RUN_ID.test(id))).toEqual([false, false, false, false, false, false, false]);
  });

  it('starts a session with no runs, actions, answer or summary', () => {
    expect(newSession('S1', 1000, WS)).toMatchObject({ runs: [], recentActions: [], lastAnswer: null, lastAnswerAt: null, lastPromptAt: null, summary: null });
  });

  it('makes a placeholder run for an agent of a run it does not know', () => {
    const s = run(seen(), ev('agent.started', 1100, { agentId: 'a1', agentType: 'workflow-subagent', description: 'plan:orders', runId: R, phase: 'Plan' }));
    expect(s.children).toEqual([]);
    expect(s.runs).toEqual([{
      id: R, name: null, summary: null, phases: [], currentPhase: 'Plan', status: 'running', onDisk: false, startedAt: 1100, endedAt: null,
      agents: [{ id: 'a1', label: 'plan:orders', phase: 'Plan', type: 'workflow-subagent', running: true, startedAt: 1100, updatedAt: 1100 }],
      agentsFinished: 0,
    }]);
  });

  it('follows a run from its launch through its agents to its end', () => {
    let s = run(seen(), ev('prompt', 1100, { text: 'verify the checkout' }), ev('workflow.started', 1200, { runId: R, source: 'fs' }),
      ev('workflow.started', 1200, { runId: R, summary: 'Verify split payments end to end', source: 'fs' }),
      ev('turn.finished', 1300, { backgroundTasks: 0 }));
    expect(s).toMatchObject({ state: 'in_meeting', stateSince: 1300 });
    s = applyEvent(s, ev('workflow.started', 1400, { runId: R, name: 'checkout-verify', summary: 'Another summary', phases: ['Plan', 'Build', 'Review'], source: 'fs' }))!;
    s = applyEvent(s, fsAgent(1500, 'a1', 'Plan'))!;
    s = applyEvent(s, fsAgent(1600, 'a2', 'Build'))!;
    expect(s.runs[0]).toMatchObject({ name: 'checkout-verify', summary: 'Verify split payments end to end', phases: ['Plan', 'Build', 'Review'], currentPhase: 'Build', startedAt: 1200, onDisk: true });
    s = applyEvent(s, ev('agent.finished', 1700, { agentId: 'a1', source: 'fs' }))!;
    expect(s.state).toBe('in_meeting');
    expect(s.runs[0]!.agentsFinished).toBe(1);
    s = applyEvent(s, ev('workflow.finished', 1800, { runId: R, status: 'completed', source: 'fs' }))!;
    expect(s).toMatchObject({ state: 'done', stateSince: 1800 });
    expect(s.runs[0]).toMatchObject({ status: 'completed', endedAt: 1800, agentsFinished: 2 });
    expect(s.runs[0]!.agents.map((a) => [a.id, a.running])).toEqual([['a1', false], ['a2', false]]);
  });

  it('takes the same agent from the mod and from the journal as one', () => {
    let s = run(seen(), ev('agent.started', 1100, { agentId: 'a1', agentType: 'agent', description: 'Implement the ledger', runId: R, phase: null }), fsAgent(1300, 'a1', 'Build'));
    expect(s.runs).toHaveLength(1);
    expect(s.runs[0]).toMatchObject({ onDisk: true, currentPhase: 'Build' });
    expect(s.runs[0]!.agents).toEqual([{ id: 'a1', label: 'Implement the ledger', phase: 'Build', type: 'workflow-subagent', running: true, startedAt: 1100, updatedAt: 1300 }]);
    s = applyEvent(s, ev('agent.finished', 1400, { agentId: 'a1' }))!;
    s = applyEvent(s, ev('agent.finished', 1500, { agentId: 'a1', source: 'fs' }))!;
    expect(s.runs[0]).toMatchObject({ agentsFinished: 1, agents: [{ running: false, updatedAt: 1400 }] });
  });

  it('flags a run agent smoking on a smoke tool.started, and clears it on tool.finished or agent.finished', () => {
    let s = run(seen(), hookAgent(1100, 'a1'), ev('tool.started', 1200, { toolId: 'c1', tool: 'Bash', label: 'Bash: smoke', agentId: 'a1', smoke: true }));
    expect(s.runs[0]!.agents).toEqual([expect.objectContaining({ id: 'a1', smoking: true })]);
    s = applyEvent(s, ev('tool.finished', 1300, { toolId: 'c1', ok: true, agentId: 'a1' }))!;
    expect(s.runs[0]!.agents[0]!.smoking).toBeFalsy();

    let t = run(seen(), hookAgent(1100, 'a2'), ev('tool.started', 1200, { toolId: 'c2', tool: 'Bash', label: 'Bash: smoke', agentId: 'a2', smoke: true }));
    t = applyEvent(t, ev('agent.finished', 1300, { agentId: 'a2' }))!;
    expect(t.runs[0]!.agents[0]!.smoking).toBeFalsy();
  });

  it('retains ok on tool.finished as an error signal on a run agent, cleared by its next tool.started (hq-mcp-switchboard proposal.md §5 Phase 0)', () => {
    let s = run(seen(), hookAgent(1100, 'a1'), ev('tool.started', 1200, { toolId: 'c1', tool: 'mcp__Notion__search', label: 'Notion: search', agentId: 'a1' }));
    s = applyEvent(s, ev('tool.finished', 1300, { toolId: 'c1', ok: false, agentId: 'a1' }))!;
    expect(s.runs[0]!.agents[0]!.error).toBe(true);
    s = applyEvent(s, ev('tool.started', 1400, { toolId: 'c2', tool: 'Read', label: 'Read a.ts', agentId: 'a1' }))!;
    expect(s.runs[0]!.agents[0]!.error).toBe(false);
  });

  const NOTION = { server: 'Notion', family: null, write: false, fairmind: false, tool: 'search' };

  it("sets the call descriptor from tool.started's mcp field on a run agent, and persists call/callAt past the close that would otherwise wipe them, so build.ts's MIN_HOLD_MS window can still read the server identity a little while after the call that set it already closed (hq-mcp-switchboard contract.md Seam 1)", () => {
    let s = run(seen(), hookAgent(1100, 'a1'), ev('tool.started', 1200, { toolId: 'c1', tool: 'mcp__Notion__search', label: 'Notion: search', agentId: 'a1', mcp: NOTION }));
    expect(s.runs[0]!.agents[0]).toMatchObject({ call: NOTION, callAt: 1200 });
    s = applyEvent(s, ev('tool.finished', 1300, { toolId: 'c1', ok: true, agentId: 'a1' }))!;
    // Not wiped by tool.finished — only a newer MCP call overwrites call/callAt.
    expect(s.runs[0]!.agents[0]).toMatchObject({ call: NOTION, callAt: 1200 });
    s = applyEvent(s, ev('tool.started', 1400, { toolId: 'c2', tool: 'mcp__Notion__search', label: 'Notion: search', agentId: 'a1', mcp: NOTION }))!;
    expect(s.runs[0]!.agents[0]).toMatchObject({ call: NOTION, callAt: 1400 });
    s = applyEvent(s, ev('tool.started', 1500, { toolId: 'c3', tool: 'Read', label: 'Read a.ts', agentId: 'a1' }))!;
    expect(s.runs[0]!.agents[0]).toMatchObject({ call: NOTION, callAt: 1400 });
  });

  const SLACK = { server: 'Slack', family: null, write: false, fairmind: false, tool: 'post' };

  it('tracks a run agent\'s own concurrently-open calls by toolId, each finish removing only its own ("parallel MCP calls" follow-up)', () => {
    let s = run(seen(), hookAgent(1100, 'a1'), ev('tool.started', 1200, { toolId: 'c1', tool: 'mcp__Notion__search', label: 'Notion: search', agentId: 'a1', mcp: NOTION }));
    expect(s.runs[0]!.agents[0]!.calls).toEqual({ c1: { call: NOTION, callAt: 1200 } });
    // A second, parallel call (a different toolId, before c1 finishes) registers alongside the first instead of
    // overwriting it — the reducer bug one Claude Code turn calling several MCP servers in one message exposed.
    s = applyEvent(s, ev('tool.started', 1210, { toolId: 'c2', tool: 'mcp__Slack__post', label: 'Slack: post', agentId: 'a1', mcp: SLACK }))!;
    expect(s.runs[0]!.agents[0]!.calls).toEqual({ c1: { call: NOTION, callAt: 1200 }, c2: { call: SLACK, callAt: 1210 } });
    expect(s.runs[0]!.agents[0]).toMatchObject({ call: SLACK, callAt: 1210 });
    // c1's own finish removes only its own toolId — c2 is untouched, still open.
    s = applyEvent(s, ev('tool.finished', 1300, { toolId: 'c1', ok: true, agentId: 'a1' }))!;
    expect(s.runs[0]!.agents[0]!.calls).toEqual({ c2: { call: SLACK, callAt: 1210 } });
    s = applyEvent(s, ev('tool.finished', 1310, { toolId: 'c2', ok: true, agentId: 'a1' }))!;
    expect(s.runs[0]!.agents[0]!.calls).toEqual({});
  });

  it("moves an agent whose tool event came before its spawn from the children to its run, and makes no child for its later steps", () => {
    let s = run(seen(), ev('tool.started', 1100, { toolId: 'c1', tool: 'Grep', label: 'Grep useCart', agentId: 'a1' }));
    expect(s.children.map((c) => c.id)).toEqual(['a1']);
    s = applyEvent(s, hookAgent(1200, 'a1'))!;
    expect(s.children).toEqual([]);
    s = applyEvent(s, ev('tool.finished', 1300, { toolId: 'c1', ok: true, agentId: 'a1' }))!;
    s = applyEvent(s, ev('tool.started', 1350, { toolId: 'c2', tool: 'Read', label: 'Read a.ts', agentId: 'a1' }))!;
    expect(s.children).toEqual([]);
    expect(s.runs[0]!.agents).toMatchObject([{ id: 'a1', running: true, updatedAt: 1350 }]);
  });

  it('takes an agent reported once with its run id and once without as one agent of its run, in either order', () => {
    // A mod older than run ids reports a workflow agent's spawn without one; the run's journal names it.
    const plain = (ts: number) => ev('agent.started', ts, { agentId: 'a1', agentType: 'workflow-subagent', description: null });
    const journalFirst = run(seen(), fsAgent(1100, 'a1'), plain(1200));
    const hookFirst = run(seen(), plain(1100), fsAgent(1200, 'a1'));
    for (const s of [journalFirst, hookFirst]) {
      expect(s.children).toEqual([]);
      expect(s.runs.map((r) => r.agents.map((a) => a.id))).toEqual([['a1']]);
    }
    expect(journalFirst.runs[0]!.agents).toEqual([{ id: 'a1', label: 'step a1', phase: 'Build', type: 'workflow-subagent', running: true, startedAt: 1100, updatedAt: 1200 }]);
    expect(hookFirst.runs[0]!.agents).toEqual([{ id: 'a1', label: 'step a1', phase: 'Build', type: 'workflow-subagent', running: true, startedAt: 1200, updatedAt: 1200 }]);
  });

  it('brings a finished turn back to its meeting when a run agent starts, and a run seen only through the mod lives only while its agents run', () => {
    let s = run(seen(), ev('prompt', 1100, { text: 'x' }), ev('turn.finished', 1200, { backgroundTasks: 0 }));
    expect(s.state).toBe('done');
    s = applyEvent(s, hookAgent(1300, 'a1'))!;
    expect(s).toMatchObject({ state: 'in_meeting', stateSince: 1300 });
    s = applyEvent(s, ev('agent.finished', 1400, { agentId: 'a1' }))!;
    expect(s).toMatchObject({ state: 'done', stateSince: 1400 });
    expect(s.runs[0]).toMatchObject({ status: 'running', onDisk: false, agentsFinished: 1 });
    const again = applyEvent(s, ev('prompt', 1500, { text: 'y' }))!;
    expect(applyEvent(again, ev('turn.finished', 1600, { backgroundTasks: 0 }))).toMatchObject({ state: 'done' });
    expect(applyEvent(again, ev('session.status', 1600, { status: 'idle', waitingFor: null, source: 'fs' }))).toMatchObject({ state: 'done' });
  });

  it('holds the meeting while a run the filesystem confirmed goes on, with no agent running', () => {
    let s = run(seen(), ev('prompt', 1100, { text: 'x' }), ev('workflow.started', 1150, { runId: R, source: 'fs' }), fsAgent(1160, 'a1'),
      ev('turn.finished', 1200, { backgroundTasks: 0 }));
    expect(s.state).toBe('in_meeting');
    s = applyEvent(s, ev('agent.finished', 1300, { agentId: 'a1', source: 'fs' }))!;
    expect(s.state).toBe('in_meeting');
    expect(applyEvent(s, ev('session.status', 1350, { status: 'idle', waitingFor: null, source: 'fs' }))).toMatchObject({ state: 'in_meeting' });
    s = applyEvent(s, ev('workflow.finished', 1400, { runId: R, status: 'failed', source: 'fs' }))!;
    expect(s).toMatchObject({ state: 'done', stateSince: 1400 });
  });

  it('makes a run it did not know already finished, and starts no agent in a finished run', () => {
    let s = run(seen(), ev('prompt', 1050, { text: 'x' }), ev('turn.finished', 1060, { backgroundTasks: 0 }),
      ev('workflow.finished', 1100, { runId: R, status: 'killed', source: 'fs' }));
    expect(s.runs).toEqual([{ id: R, name: null, summary: null, phases: [], currentPhase: null, status: 'killed', onDisk: true, startedAt: 1100, endedAt: 1100, agents: [], agentsFinished: 0 }]);
    s = applyEvent(s, fsAgent(1200, 'a1'))!;
    expect(s.state).toBe('done');
    expect(s.runs[0]).toMatchObject({ agentsFinished: 0, agents: [{ id: 'a1', running: false }] });
    s = applyEvent(s, ev('workflow.started', 1300, { runId: R, name: 'late-name', source: 'fs' }))!;
    expect(s).toMatchObject({ state: 'done', runs: [{ name: 'late-name', status: 'killed' }] });
  });

  it('kills the running runs of a session that ends, and stops every agent and subagent', () => {
    let s = run(seen(), ev('agent.started', 1100, { agentId: 'c1', agentType: 'Explore', description: null }),
      ev('workflow.started', 1150, { runId: R2, source: 'fs' }), ev('workflow.finished', 1160, { runId: R2, status: 'completed', source: 'fs' }),
      fsAgent(1200, 'a1'), fsAgent(1210, 'a2'), ev('agent.finished', 1300, { agentId: 'a1', source: 'fs' }));
    s = applyEvent(s, ev('session.ended', 1500, { reason: 'other' }))!;
    expect(s.state).toBe('ended');
    expect(s.children.map((c) => c.running)).toEqual([false]);
    expect(s.runs.map((r) => [r.id, r.status, r.endedAt, r.agentsFinished])).toEqual([[R2, 'completed', 1160, 0], [R, 'killed', 1500, 2]]);
    expect(s.runs[1]!.agents.map((a) => a.running)).toEqual([false, false]);
  });

  it('takes the current phase from the agent that started last', () => {
    const s = run(seen(), fsAgent(1100, 'a1', 'Plan'), fsAgent(1300, 'a2', 'Build'), fsAgent(1200, 'a3', 'Plan'), fsAgent(1400, 'a4', null));
    expect(s.runs[0]!.currentPhase).toBe('Build');
    expect(run(seen(), fsAgent(1100, 'a1', 'Plan'), fsAgent(1100, 'a2', 'Review')).runs[0]!.currentPhase).toBe('Review');
  });

  it('keeps at most MAX_RUNS runs in start order, dropping the oldest finished one and never a running one', () => {
    const runId = (i: number) => `wf_0000aaaa-${String(i).padStart(3, '0')}`;
    const events: CollectorEvent[] = [seen(), ev('agent.started', 1001, { agentId: 'a1', agentType: 'workflow-subagent', description: null, runId: runId(1), phase: null })];
    for (let i = 2; i <= 11; i++) events.push(ev('workflow.started', 1000 + i * 10, { runId: runId(i), source: 'fs' }), ev('workflow.finished', 1005 + i * 10, { runId: runId(i), status: 'completed', source: 'fs' }));
    const s = run(...events);
    expect(ids(s)).toEqual([1, 3, 4, 5, 6, 7, 8, 9, 10, 11].map(runId));
    expect(ids(run(...events, ev('workflow.started', 999, { runId: runId(12), source: 'fs' })))).toEqual([12, 1, 4, 5, 6, 7, 8, 9, 10, 11].map(runId));
    const busy: CollectorEvent[] = [seen()];
    for (let i = 1; i <= 11; i++) busy.push(ev('workflow.started', 1000 + i, { runId: runId(i), source: 'fs' }));
    expect(run(...busy).runs).toHaveLength(11);
  });

  it('keeps at most MAX_RUN_AGENTS agents in a run, dropping the oldest finished one and never a running one', () => {
    const events: CollectorEvent[] = [seen()];
    for (let i = 1; i <= 64; i++) events.push(fsAgent(1000 + i, `a${i}`));
    events.push(ev('agent.finished', 2000, { agentId: 'a5', source: 'fs' }), ev('agent.finished', 2001, { agentId: 'a3', source: 'fs' }), fsAgent(2100, 'a65'));
    const s = run(...events);
    expect(s.runs[0]!.agents).toHaveLength(64);
    expect(s.runs[0]!.agents.map((a) => a.id)).not.toContain('a3');
    expect(s.runs[0]!.agents.map((a) => a.id)).toContain('a5');
    expect(s.runs[0]!.agentsFinished).toBe(2);
    const all: CollectorEvent[] = [seen()];
    for (let i = 1; i <= 65; i++) all.push(fsAgent(1000 + i, `a${i}`));
    expect(run(...all).runs[0]!.agents).toHaveLength(65);
  });

  it('drops the oldest run that no longer goes on: finished, or seen only through the mod with nothing left running', () => {
    const runId = (i: number) => `wf_0000aaaa-${String(i).padStart(3, '0')}`;
    const events: CollectorEvent[] = [seen(), ev('agent.started', 1001, { agentId: 'h1', agentType: 'workflow-subagent', description: null, runId: runId(1), phase: null })];
    events.push(ev('agent.finished', 1002, { agentId: 'h1' }));
    for (let i = 2; i <= 11; i++) events.push(ev('workflow.started', 1000 + i * 10, { runId: runId(i), source: 'fs' }));
    const s = run(...events);
    expect(ids(s)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map(runId));
    expect(s.runs.every(liveRun)).toBe(true);
    expect([liveRun({ ...s.runs[0]!, onDisk: false }), liveRun({ ...s.runs[0]!, status: 'completed' })]).toEqual([false, false]);
  });

  it("counts a run's finished agents once when its journal is read again, even those it let go of", () => {
    // 70 agents one after another, then 10 at once: the run keeps 64 and remembers the 16 finished ones it let go of.
    const journal: CollectorEvent[] = [];
    for (let i = 1; i <= 70; i++) journal.push(fsAgent(1000 + i * 10, `a${i}`), ev('agent.finished', 1005 + i * 10, { agentId: `a${i}`, source: 'fs' }));
    for (let i = 1; i <= 10; i++) journal.push(fsAgent(2000 + i, `b${i}`));
    const before = run(seen(), ...journal);
    const counts = (s: Session) => [s.runs[0]!.agents.length, s.runs[0]!.agents.filter((a) => a.running).length, s.runs[0]!.agentsFinished];
    expect(counts(before)).toEqual([64, 10, 70]);
    expect(before.runs[0]!.droppedAgents).toEqual(Array.from({ length: 16 }, (_, i) => `a${i + 1}`));
    // After a restart the journal is read from its start again, and the mod's late word of an end changes nothing either.
    const after = journal.reduce((s, e) => applyEvent(s, { ...e, ts: e.ts + 5000 })!, normalizeSession(before));
    const late = applyEvent(after, ev('agent.finished', 9000, { agentId: 'a1' }))!;
    expect([counts(after), late]).toEqual([[64, 10, 70], after]);
    expect(late.children).toEqual([]);
    // A run that let none go has no list; a long one remembers the latest MAX_DROPPED_AGENTS.
    expect('droppedAgents' in run(seen(), fsAgent(1100, 'a1')).runs[0]!).toBe(false);
    const long: CollectorEvent[] = [seen()];
    for (let i = 1; i <= 364; i++) long.push(fsAgent(1000 + i * 10, `a${i}`), ev('agent.finished', 1005 + i * 10, { agentId: `a${i}`, source: 'fs' }));
    const dropped = run(...long).runs[0]!.droppedAgents!;
    expect([MAX_DROPPED_AGENTS, dropped.length, dropped[0], dropped.at(-1)]).toEqual([256, 256, 'a45', 'a300']);
  });

  it('ignores workflow events whose run id is not one, and takes such an agent as a plain subagent', () => {
    const s = run(seen(), ev('workflow.started', 1100, { runId: 'wf_a/b', name: 'x', source: 'fs' }), ev('workflow.finished', 1200, { runId: 'run-1', status: 'completed', source: 'fs' }),
      ev('agent.started', 1300, { agentId: 'a1', agentType: 'Explore', description: 'Find callers', runId: '../wf_1', phase: 'Plan' }));
    expect(s.runs).toEqual([]);
    expect(s.children).toEqual([{ id: 'a1', type: 'Explore', description: 'Find callers', running: true, lastAction: null, updatedAt: 1300 }]);
  });

  it("ends a run agent's wait with that agent's next step, and with nobody else's", () => {
    let s = run(seen(), ev('prompt', 1100, { text: 'x' }), hookAgent(1150, 'a1'), ev('turn.finished', 1200, { backgroundTasks: 0 }),
      ev('waiting', 1300, { reason: { kind: 'permission', text: 'Bash', detail: 'Bash: npm test' }, agentId: 'a1' }));
    expect(s).toMatchObject({ state: 'needs_you', waitAgentId: 'a1' });
    s = applyEvent(s, ev('tool.finished', 1350, { toolId: 'c9', ok: true, agentId: 'a2' }))!;
    expect(s).toMatchObject({ state: 'needs_you', waitAgentId: 'a1' });
    s = applyEvent(s, ev('tool.started', 1400, { toolId: 'c1', tool: 'Bash', label: 'Bash: npm test', agentId: 'a1' }))!;
    expect(s).toMatchObject({ state: 'in_meeting', stateSince: 1400, waitReason: null, waitAgentId: null });
    expect(s.children.map((c) => c.id)).toEqual(['a2']);
  });
});

describe('workflow runs read again from disk', () => {
  const runId = (i: number) => `wf_0000aaaa-${String(i).padStart(3, '0')}`;
  /** A run that ran from `start` to `end`, as the filesystem reads its end file: its end, then what it says of itself. */
  const ended = (id: string, start: number, end: number): CollectorEvent[] => [
    ev('workflow.finished', end, { runId: id, status: 'completed', startedAt: start, source: 'fs' }),
    ev('workflow.started', start, { runId: id, name: `run ${id.slice(-3)}`, source: 'fs' }),
  ];
  const replay = (s: Session, events: CollectorEvent[]) => events.reduce((x, e) => applyEvent(x, e)!, s);

  it('keeps the end of a run that has finished: the same end read again changes nothing, and a later word on how it ended changes only that', () => {
    const s = markSeen(run(seen(), ev('prompt', 1050, { text: 'x' }), ...ended(R, 1100, 1200), ev('turn.finished', 1300, { backgroundTasks: 0 })), 1400);
    expect(s.runs).toMatchObject([{ status: 'completed', startedAt: 1100, endedAt: 1200, name: 'run 001' }]);
    expect(replay(s, ended(R, 1100, 1200))).toEqual(s);
    expect(applyEvent(s, ev('workflow.finished', 5000, { runId: R, status: 'completed', source: 'fs' }))).toBe(s);
    const killed = applyEvent(s, ev('workflow.finished', 5000, { runId: R, status: 'killed', source: 'fs' }))!;
    expect(killed.runs[0]).toMatchObject({ status: 'killed', startedAt: 1100, endedAt: 1200 });
    expect([killed.state, killed.stateSince, killed.seenAt]).toEqual(['done', 1300, 1400]);
    // A run its session's end killed, whose end file then says it completed, completed as of that end.
    const exited = run(seen(), ev('workflow.started', 1100, { runId: R, source: 'fs' }), ev('session.ended', 1500, { reason: 'other' }),
      ev('workflow.finished', 1450, { runId: R, status: 'completed', startedAt: 1100, source: 'fs' }));
    expect([exited.state, exited.runs[0]!.status, exited.runs[0]!.endedAt]).toEqual(['ended', 'completed', 1500]);
    // A meeting another run holds counts nothing off for an end it already had.
    const meeting = run(seen(), ev('prompt', 1050, { text: 'x' }), ...ended(R, 1100, 1200), ev('workflow.started', 1250, { runId: R2, source: 'fs' }),
      ev('turn.finished', 1300, { backgroundTasks: 1 }));
    expect(applyEvent(meeting, ev('workflow.finished', 5000, { runId: R, status: 'completed', source: 'fs' }))).toBe(meeting);
  });

  it('replays the ends of runs into a session whose runs are full, leaving the runs and the session as they were', () => {
    const events: CollectorEvent[] = [seen(), ev('prompt', 1050, { text: 'x' })];
    for (let i = 0; i < 10; i++) events.push(...ended(runId(i), 2000 + i * 100, 2050 + i * 100));
    events.push(ev('turn.finished', 3000, { backgroundTasks: 0 }));
    const s = markSeen(run(...events), 3100);
    expect(ids(s)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(runId));
    // One that started before them all, and one that ended after some of them started: neither is kept, nor runs.
    for (const [start, end] of [[1000, 1500], [1900, 2500]] as const) {
      const again = replay(s, [...ended(runId(20), start, end), ...ended(runId(3), 2300, 2350)]);
      expect([start, again.runs]).toEqual([start, s.runs]);
      expect([again.state, again.stateSince, again.seenAt]).toEqual(['done', 3000, 3100]);
    }
    // One that started after them all takes the place of the oldest.
    const newer = replay(s, ended(runId(20), 2950, 2990));
    expect(ids(newer)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 20].map(runId));
    expect(newer.runs.at(-1)).toMatchObject({ name: 'run 020', status: 'completed', onDisk: true, startedAt: 2950, endedAt: 2990 });
    expect([newer.state, newer.stateSince, newer.seenAt]).toEqual(['done', 3000, 3100]);
  });

  it('makes no run from what the filesystem reads of one it does not hold: only a bare start, or the demo, makes one', () => {
    const named = { runId: R, name: 'checkout-verify', summary: 'Verify split payments end to end', phases: ['Plan'] };
    expect(run(seen(), ev('workflow.started', 1100, { ...named, source: 'fs' })).runs).toEqual([]);
    expect(run(seen(), ev('workflow.started', 1100, { runId: R, source: 'fs' }), ev('workflow.started', 1200, { ...named, source: 'fs' })).runs)
      .toMatchObject([{ name: 'checkout-verify', status: 'running', startedAt: 1100 }]);
    expect(run(seen(), ev('workflow.started', 1100, { ...named, source: 'demo' })).runs).toMatchObject([{ name: 'checkout-verify', status: 'running' }]);
  });

  it("starts a finished run again only on the filesystem's bare word of a start after its end: resumed under its id", () => {
    let s = run(seen(), ev('prompt', 1050, { text: 'x' }), ev('workflow.started', 1100, { runId: R, source: 'fs' }), fsAgent(1150, 'a1'),
      ev('workflow.finished', 1800, { runId: R, status: 'failed', source: 'fs' }), ev('turn.finished', 1900, { backgroundTasks: 0 }));
    expect(s).toMatchObject({ state: 'done', runs: [{ status: 'failed', endedAt: 1800, agentsFinished: 1 }] });
    // A late spawn from the mod, a start before the end, and what the end file says of the run start nothing.
    for (const e of [hookAgent(2000, 'a2'), ev('workflow.started', 1700, { runId: R, source: 'fs' }), ev('workflow.started', 2000, { runId: R, name: 'checkout-verify', source: 'fs' })]) {
      const after = applyEvent(s, e)!;
      expect([e.ts, after.state, after.runs[0]!.status, after.runs[0]!.endedAt]).toEqual([e.ts, 'done', 'failed', 1800]);
    }
    s = applyEvent(s, ev('workflow.started', 2100, { runId: R, source: 'fs' }))!;
    expect(s).toMatchObject({ state: 'in_meeting', stateSince: 2100, runs: [{ status: 'running', endedAt: null, startedAt: 1100, agentsFinished: 1 }] });
    s = applyEvent(s, fsAgent(2200, 'a3'))!;
    expect(s.runs[0]!.agents.map((a) => [a.id, a.running])).toEqual([['a1', false], ['a3', true]]);
    s = applyEvent(s, ev('workflow.finished', 2500, { runId: R, status: 'completed', source: 'fs' }))!;
    expect(s).toMatchObject({ state: 'done', stateSince: 2500, runs: [{ status: 'completed', endedAt: 2500, agentsFinished: 2 }] });
  });

  it("leaves a meeting no earlier than it began when a run's end is read after it began, and ends the run as its end file says", () => {
    // The turn ends at 1500 while the run goes on; the scan after it reads the end file written at 1400.
    const late = run(seen(), ev('prompt', 1050, { text: 'x' }), ev('workflow.started', 1100, { runId: R, source: 'fs' }), fsAgent(1150, 'a1'),
      ev('turn.finished', 1500, { backgroundTasks: 0 }), ev('workflow.finished', 1400, { runId: R, status: 'completed', startedAt: 1100, source: 'fs' }));
    expect(late).toMatchObject({ state: 'done', stateSince: 1500, runs: [{ status: 'completed', endedAt: 1400 }] });
    // A run launched again whose resumed part ended before the scan that took it up: started again as of that scan, ended
    // as of its new end file, and done as of the meeting its start began.
    const resumed = run(seen(), ev('prompt', 1050, { text: 'x' }), ev('workflow.started', 1100, { runId: R, source: 'fs' }),
      ev('workflow.finished', 1800, { runId: R, status: 'failed', source: 'fs' }), ev('turn.finished', 1900, { backgroundTasks: 0 }),
      ev('workflow.started', 2600, { runId: R, source: 'fs' }), ev('workflow.finished', 2500, { runId: R, status: 'completed', startedAt: 2400, source: 'fs' }));
    expect(resumed).toMatchObject({ state: 'done', stateSince: 2600, runs: [{ status: 'completed', startedAt: 1100, endedAt: 2500 }] });
  });
});

describe('normalizeSession', () => {
  it('gives a row saved before runs existed their defaults', () => {
    const current = run(seen(), ev('prompt', 1100, { text: 'x' }));
    const { runs: _runs, recentActions: _a, lastAnswer: _b, lastAnswerAt: _c, lastPromptAt: _d, summary: _e, ...older } = current;
    expect(normalizeSession(older as Session)).toEqual({ ...current, runs: [], recentActions: [], lastAnswer: null, lastAnswerAt: null, lastPromptAt: null, summary: null });
  });

  it('stops the agents of a run seen only through the mod, and keeps those of a run on disk, which its journal corrects', () => {
    const s = run(seen(), ev('prompt', 1050, { text: 'x' }), fsAgent(1100, 'a1'), fsAgent(1200, 'a2'), ev('agent.finished', 1300, { agentId: 'a1', source: 'fs' }),
      ev('agent.started', 1400, { agentId: 'h1', agentType: 'workflow-subagent', description: null, runId: R2, phase: null }),
      ev('turn.finished', 1500, { backgroundTasks: 0 }));
    expect(s.state).toBe('in_meeting');
    const restored = normalizeSession(s);
    expect(restored.runs.map((r) => [r.id, r.status, r.agentsFinished, r.agents.map((a) => a.running)])).toEqual([[R, 'running', 1, [false, true]], [R2, 'running', 1, [false]]]);
    expect(restored.runs[1]!.agents[0]!.updatedAt).toBe(1400);
    expect(restored).toMatchObject({ state: 'in_meeting', stateSince: 1500 });
  });

  it('ends a restored meeting that nothing holds any more, as of when it began', () => {
    const hooksOnly = run(seen(), ev('prompt', 1050, { text: 'x' }), hookAgent(1100, 'a1'), ev('turn.finished', 1200, { backgroundTasks: 0 }));
    expect(hooksOnly.state).toBe('in_meeting');
    expect(normalizeSession(hooksOnly)).toMatchObject({ state: 'done', stateSince: 1200, seenAt: null, runs: [{ status: 'running', agents: [{ running: false }] }] });
    const ended = run(seen(), ev('prompt', 1050, { text: 'x' }), fsAgent(1100, 'a1'), ev('turn.finished', 1200, { backgroundTasks: 0 }),
      ev('workflow.finished', 1300, { runId: R, status: 'completed', source: 'fs' }));
    expect(normalizeSession({ ...ended, state: 'in_meeting', stateSince: 1250 })).toMatchObject({ state: 'done', stateSince: 1250 });
  });
});

it('keeps workflow agent telemetry without changing lifecycle or counting another completion', () => {
  const telemetry = { model: 'sonnet', usage: null, costUSD: 0, startedAt: 10, endedAt: 20, complete: true };
  const s = run(seen(0), fsAgent(10, 'a1'), ev('agent.finished', 20, { agentId: 'a1' }),
    ev('agent.metrics', 30, { runId: R, agentId: 'a1', telemetry }));
  expect(s.runs[0]!.agents[0]).toMatchObject({ running: false, telemetry });
  expect(s.runs[0]!.agentsFinished).toBe(1);
});

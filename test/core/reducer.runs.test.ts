import { describe, expect, it } from 'vitest';
import { applyEvent, MAX_RUN_AGENTS, MAX_RUNS, newSession, normalizeSession, RUN_ID } from '../../src/core/reducer.js';
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
    let s = run(seen(), ev('prompt', 1100, { text: 'verify the checkout' }),
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
    expect(restored.runs.map((r) => [r.id, r.status, r.agentsFinished, r.agents.map((a) => a.running)])).toEqual([[R, 'running', 1, [false, true]], [R2, 'running', 0, [false]]]);
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

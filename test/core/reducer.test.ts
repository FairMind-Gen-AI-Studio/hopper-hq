import { describe, expect, it } from 'vitest';
import { applyEvent, markSeen } from '../../src/core/reducer.js';
import type { Session } from '../../src/core/types.js';
import { ev, seen, WS } from '../helpers/events.js';

function run(...events: Parameters<typeof applyEvent>[1][]): Session {
  let s: Session | undefined;
  for (const e of events) s = applyEvent(s, e);
  if (!s) throw new Error('no session');
  return s;
}

describe('applyEvent', () => {
  it('creates a session only from session.seen', () => {
    expect(applyEvent(undefined, ev('prompt', 1, { text: 'hi' }))).toBeUndefined();
    const s = run(seen(1000));
    expect(s).toMatchObject({ id: 'S1', state: 'idle', stateSince: 1000, pid: 42, name: 'orders-api-a1', tmuxPane: '%7', workspace: WS, startedAt: 1000 });
  });

  it('merges a later session.seen without changing state', () => {
    const s = run(seen(1000), ev('prompt', 1100, { text: 'go' }), ev('session.seen', 1200, { workspace: { ...WS, branch: null }, pid: null, name: 'renamed' }));
    expect(s.state).toBe('working');
    expect(s.name).toBe('renamed');
    expect(s.pid).toBe(42);
    expect(s.workspace.branch).toBe('feat/checkout-v2');
  });

  it('a prompt starts work and records first and last prompt', () => {
    const s = run(seen(), ev('prompt', 1100, { text: 'first' }), ev('prompt', 1200, { text: 'second' }));
    expect(s).toMatchObject({ state: 'working', stateSince: 1100, firstPrompt: 'first', lastPrompt: 'second' });
  });

  it('tracks the open tool and last action', () => {
    let s = run(seen(), ev('tool.started', 1100, { toolId: 't1', tool: 'Bash', label: 'Bash: npm test', agentId: null }));
    expect(s).toMatchObject({ state: 'working', lastAction: 'Bash: npm test', lastActionAt: 1100, openTool: { id: 't1', label: 'Bash: npm test', startedAt: 1100 } });
    s = applyEvent(s, ev('tool.finished', 1200, { toolId: 't1', ok: true, agentId: null }))!;
    expect(s.openTool).toBeNull();
    expect(s.state).toBe('working');
  });

  it('waits for the user, then resumes on the next activity', () => {
    let s = run(seen(), ev('tool.started', 1100, { toolId: 't1', tool: 'Bash', label: 'Bash: rm -rf dist', agentId: null }),
      ev('waiting', 1150, { reason: { kind: 'permission', text: 'Bash', detail: 'Bash: rm -rf dist' } }));
    expect(s).toMatchObject({ state: 'needs_you', stateSince: 1150, waitReason: { kind: 'permission', text: 'Bash', detail: 'Bash: rm -rf dist' } });
    s = applyEvent(s, ev('tool.finished', 1300, { toolId: 't1', ok: true, agentId: null }))!;
    expect(s).toMatchObject({ state: 'working', waitReason: null });
  });

  it('keeps a detailed wait reason when a vaguer one of the same kind follows', () => {
    const s = run(seen(), ev('waiting', 1100, { reason: { kind: 'permission', text: 'Bash', detail: 'Bash: rm -rf dist' } }),
      ev('waiting', 1101, { reason: { kind: 'permission', text: 'Claude needs your permission to use Bash' } }));
    expect(s.waitReason).toEqual({ kind: 'permission', text: 'Bash', detail: 'Bash: rm -rf dist' });
    expect(s.stateSince).toBe(1100);
  });

  it('finishes a turn as done, or in a meeting when background work runs', () => {
    expect(run(seen(), ev('prompt', 1100, { text: 'x' }), ev('turn.finished', 1200, { backgroundTasks: 0 })))
      .toMatchObject({ state: 'done', stateSince: 1200, seenAt: null, openTool: null });
    const m = run(seen(), ev('prompt', 1100, { text: 'x' }), ev('turn.finished', 1200, { backgroundTasks: 2 }));
    expect(m).toMatchObject({ state: 'in_meeting', backgroundTasks: 2 });
  });

  it('leaves the meeting when the last background agent finishes', () => {
    let s = run(seen(), ev('agent.started', 1050, { agentId: 'a1', agentType: 'Explore', description: null }),
      ev('agent.started', 1060, { agentId: 'a2', agentType: 'general-purpose', description: 'Implement' }),
      ev('turn.finished', 1100, { backgroundTasks: 2 }));
    expect(s.state).toBe('in_meeting');
    s = applyEvent(s, ev('agent.finished', 1200, { agentId: 'a1' }))!;
    expect(s.state).toBe('in_meeting');
    s = applyEvent(s, ev('agent.finished', 1300, { agentId: 'a2' }))!;
    expect(s).toMatchObject({ state: 'done', stateSince: 1300, backgroundTasks: 0 });
    expect(s.children.map((c) => [c.id, c.running])).toEqual([['a1', false], ['a2', false]]);
  });

  it('ignores stale ordered events but still learns order-free facts', () => {
    let s = run(seen(), ev('prompt', 1100, { text: 'x' }), ev('turn.finished', 2000, { backgroundTasks: 0 }));
    s = applyEvent(s, ev('tool.started', 1500, { toolId: 't9', tool: 'Bash', label: 'Bash: late', agentId: null }))!;
    expect(s).toMatchObject({ state: 'done', lastAction: null });
    s = applyEvent(s, ev('title', 1, { title: 'Fix the checkout' }))!;
    expect(s.title).toBe('Fix the checkout');
  });

  it('uses seq to order events with the same timestamp', () => {
    const a = ev('tool.started', 1100, { toolId: 't1', tool: 'Bash', label: 'Bash: a', agentId: null, seq: 10 });
    const b = ev('turn.finished', 1100, { backgroundTasks: 0, seq: 11 });
    expect(run(seen(), a, b).state).toBe('done');
    const late = ev('tool.started', 1100, { toolId: 't2', tool: 'Bash', label: 'Bash: b', agentId: null, seq: 5 });
    expect(run(seen(), a, b, late).state).toBe('done');
  });

  it('fills a missing first prompt from a stale prompt', () => {
    const s = run(seen(), ev('prompt', 2000, { text: 'recent' }), ev('prompt', 1100, { text: 'earliest' }));
    expect(s).toMatchObject({ firstPrompt: 'recent', lastPrompt: 'recent' });
    const t = run(seen(), ev('tool.started', 2000, { toolId: 't', tool: 'Read', label: 'Read a', agentId: null }), ev('prompt', 1100, { text: 'earliest' }));
    expect(t.firstPrompt).toBe('earliest');
  });

  it('routes subagent tool events to the child, not the session', () => {
    const s = run(seen(), ev('prompt', 1100, { text: 'x' }), ev('turn.finished', 1200, { backgroundTasks: 1 }),
      ev('tool.started', 1300, { toolId: 'c1', tool: 'Grep', label: 'Grep useCart', agentId: 'a1' }));
    expect(s.state).toBe('in_meeting');
    expect(s.lastAction).toBeNull();
    expect(s.children).toEqual([{ id: 'a1', type: 'agent', description: null, running: true, lastAction: 'Grep useCart', updatedAt: 1300 }]);
  });

  it("a subagent's wait ends with that subagent's next step, not with another one's", () => {
    let s = run(seen(), ev('prompt', 1100, { text: 'x' }),
      ev('tool.started', 1200, { toolId: 'm1', tool: 'Agent', label: 'Agent: Review', agentId: null }),
      ev('tool.started', 1300, { toolId: 'c1', tool: 'Write', label: 'Write a.ts', agentId: 'a1' }),
      ev('waiting', 1350, { reason: { kind: 'permission', text: 'Write', detail: 'Write a.ts' }, agentId: 'a1' }));
    expect(s).toMatchObject({ state: 'needs_you', waitAgentId: 'a1' });
    s = applyEvent(s, ev('tool.finished', 1400, { toolId: 'c9', ok: true, agentId: 'a2' }))!;
    expect(s).toMatchObject({ state: 'needs_you', waitAgentId: 'a1' });
    s = applyEvent(s, ev('tool.started', 1340, { toolId: 'c0', tool: 'Read', label: 'Read b.ts', agentId: 'a1' }))!;
    expect(s).toMatchObject({ state: 'needs_you', waitAgentId: 'a1' });
    s = applyEvent(s, ev('tool.finished', 1500, { toolId: 'c1', ok: true, agentId: 'a1' }))!;
    expect(s).toMatchObject({ state: 'working', stateSince: 1500, waitReason: null, waitAgentId: null, openTool: { id: 'm1' }, lastEventAt: 1500 });
  });

  it("a background subagent's wait returns the session to its meeting, and the subagent's end makes it done", () => {
    let s = run(seen(), ev('prompt', 1100, { text: 'x' }),
      ev('agent.started', 1150, { agentId: 'a1', agentType: 'general-purpose', description: null }),
      ev('turn.finished', 1200, { backgroundTasks: 0 }),
      ev('waiting', 1300, { reason: { kind: 'permission', text: 'Bash', detail: 'Bash: npm test' }, agentId: 'a1' }));
    expect(s).toMatchObject({ state: 'needs_you', waitAgentId: 'a1' });
    s = applyEvent(s, ev('tool.started', 1400, { toolId: 'c1', tool: 'Bash', label: 'Bash: npm test', agentId: 'a1' }))!;
    expect(s).toMatchObject({ state: 'in_meeting', stateSince: 1400, waitReason: null, waitAgentId: null });
    s = applyEvent(s, ev('waiting', 1500, { reason: { kind: 'permission', text: 'Bash', detail: 'Bash: git push' }, agentId: 'a1' }))!;
    s = applyEvent(s, ev('agent.finished', 1600, { agentId: 'a1' }))!;
    expect(s).toMatchObject({ state: 'done', stateSince: 1600, waitReason: null, waitAgentId: null });
  });

  it("a subagent's finish older than its wait does not end it", () => {
    // The filesystem reports a subagent finished once its transcript goes quiet, as it does while the subagent waits for you.
    const s = run(seen(), ev('prompt', 1100, { text: 'x' }),
      ev('agent.started', 1150, { agentId: 'a1', agentType: 'general-purpose', description: null }),
      ev('turn.finished', 1200, { backgroundTasks: 0 }),
      ev('waiting', 1300, { reason: { kind: 'permission', text: 'Bash' }, agentId: 'a1' }),
      ev('agent.finished', 1250, { agentId: 'a1', source: 'fs' }));
    expect(s).toMatchObject({ state: 'needs_you', waitAgentId: 'a1' });
    expect(s.children.map((c) => [c.id, c.running])).toEqual([['a1', false]]);
  });

  it("a subagent's finish inferred from its quiet transcript does not end its wait, even a newer one", () => {
    const wait = (finish: 'fs' | 'hook') => run(seen(), ev('prompt', 1100, { text: 'x' }),
      ev('agent.started', 1150, { agentId: 'a1', agentType: 'general-purpose', description: null }),
      ev('turn.finished', 1200, { backgroundTasks: 0 }),
      ev('waiting', 1300, { reason: { kind: 'permission', text: 'Bash', detail: 'Bash: npm test' }, agentId: 'a1' }),
      ev('agent.finished', 1400, { agentId: 'a1', source: finish }));
    const quiet = wait('fs');
    expect(quiet).toMatchObject({ state: 'needs_you', waitReason: { kind: 'permission', text: 'Bash', detail: 'Bash: npm test' }, waitAgentId: 'a1' });
    expect(quiet.children.map((c) => [c.id, c.running])).toEqual([['a1', false]]);
    expect(wait('hook')).toMatchObject({ state: 'done', waitReason: null, waitAgentId: null });
  });

  it('a wait raised over another one is ended only by the session itself', () => {
    let s = run(seen(), ev('prompt', 1100, { text: 'x' }),
      ev('waiting', 1200, { reason: { kind: 'permission', text: 'Write', detail: 'Write a.ts' }, agentId: 'a1' }),
      ev('waiting', 1300, { reason: { kind: 'permission', text: 'Bash', detail: 'Bash: ls' }, agentId: 'a2' }));
    expect(s).toMatchObject({ state: 'needs_you', waitAgentId: null });
    s = applyEvent(s, ev('tool.finished', 1400, { toolId: 'c1', ok: true, agentId: 'a1' }))!;
    expect(s.state).toBe('needs_you');
    s = applyEvent(s, ev('tool.started', 1500, { toolId: 't1', tool: 'Bash', label: 'Bash: ls', agentId: null }))!;
    expect(s).toMatchObject({ state: 'working', waitAgentId: null });
    const own = run(seen(), ev('waiting', 1100, { reason: { kind: 'question', text: 'Redis or Postgres?' }, agentId: null }),
      ev('waiting', 1200, { reason: { kind: 'permission', text: 'Bash' }, agentId: 'a1' }));
    expect(own).toMatchObject({ state: 'needs_you', waitAgentId: null });
  });

  it('a vaguer follow-up keeps whose wait it is', () => {
    const s = run(seen(), ev('waiting', 1100, { reason: { kind: 'permission', text: 'Write', detail: 'Write a.ts' }, agentId: 'a1' }),
      ev('waiting', 1101, { reason: { kind: 'permission', text: 'Claude needs your permission to use Write' }, agentId: null }));
    expect(s).toMatchObject({ waitReason: { kind: 'permission', text: 'Write', detail: 'Write a.ts' }, waitAgentId: 'a1' });
  });

  it("the session's own activity ends a subagent's wait too", () => {
    const w = run(seen(), ev('prompt', 1100, { text: 'x' }), ev('waiting', 1200, { reason: { kind: 'permission', text: 'Bash' }, agentId: 'a1' }));
    expect(applyEvent(w, ev('prompt', 1300, { text: 'go on' }))).toMatchObject({ state: 'working', waitReason: null, waitAgentId: null });
    expect(applyEvent(w, ev('tool.started', 1300, { toolId: 't1', tool: 'Read', label: 'Read a.ts', agentId: null }))).toMatchObject({ state: 'working', waitAgentId: null });
    expect(applyEvent(w, ev('turn.finished', 1300, { backgroundTasks: 0 }))).toMatchObject({ state: 'done', waitAgentId: null });
    expect(applyEvent(w, ev('session.status', 1300, { status: 'busy', waitingFor: null, source: 'fs' }))).toMatchObject({ state: 'working', waitAgentId: null });
    expect(applyEvent(w, ev('session.ended', 1300, { reason: 'other' }))).toMatchObject({ state: 'ended', waitAgentId: null });
  });

  it('applies the filesystem status fallback', () => {
    // busy -> working
    expect(run(seen(), ev('session.status', 1100, { status: 'busy', waitingFor: null, source: 'fs' })).state).toBe('working');
    // waiting without a hook reason
    expect(run(seen(), ev('session.status', 1100, { status: 'waiting', waitingFor: 'input needed', source: 'fs' })))
      .toMatchObject({ waitReason: { kind: 'input', text: 'input needed' }, waitAgentId: null });
    // waiting keeps the richer hook reason
    expect(run(seen(), ev('waiting', 1100, { reason: { kind: 'permission', text: 'Bash' } }),
      ev('session.status', 1101, { status: 'waiting', waitingFor: 'input needed', source: 'fs' })).waitReason)
      .toEqual({ kind: 'permission', text: 'Bash' });
    // idle after work -> done
    expect(run(seen(), ev('session.status', 1100, { status: 'busy', waitingFor: null, source: 'fs' }),
      ev('session.status', 1200, { status: 'idle', waitingFor: null, source: 'fs' })).state).toBe('done');
    // idle on a session we never saw working stays idle
    expect(run(seen(), ev('session.status', 1100, { status: 'idle', waitingFor: null, source: 'fs' })).state).toBe('idle');
  });

  it('session.started resets to idle (compactions are filtered out earlier, by the hook mapper)', () => {
    const s = run(seen(), ev('prompt', 1100, { text: 'x' }), ev('session.started', 1200));
    expect(s.state).toBe('idle');
  });

  it('ends and revives', () => {
    let s = run(seen(), ev('session.ended', 1100, { reason: 'prompt_input_exit' }));
    expect(s.state).toBe('ended');
    s = applyEvent(s, ev('prompt', 1200, { text: 'back' }))!;
    expect(s.state).toBe('working');
  });

  it('records branch changes', () => {
    expect(run(seen(), ev('branch', 1100, { branch: 'feat/other' })).workspace.branch).toBe('feat/other');
    expect(run(seen(), ev('branch', 1100, { branch: null })).workspace.branch).toBe('feat/checkout-v2');
  });
});

describe('markSeen', () => {
  it('marks a done session as seen and ignores other states', () => {
    const done = run(seen(), ev('prompt', 1100, { text: 'x' }), ev('turn.finished', 1200, { backgroundTasks: 0 }));
    expect(markSeen(done, 5000).seenAt).toBe(5000);
    expect(markSeen({ ...done, stateSince: 9000 }, 5000).seenAt).toBe(9000);
    const working = run(seen(), ev('prompt', 1100, { text: 'x' }));
    expect(markSeen(working, 5000)).toBe(working);
  });
});

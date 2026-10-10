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

  it('applies the filesystem status fallback', () => {
    // busy -> working
    expect(run(seen(), ev('session.status', 1100, { status: 'busy', waitingFor: null, source: 'fs' })).state).toBe('working');
    // waiting without a hook reason
    expect(run(seen(), ev('session.status', 1100, { status: 'waiting', waitingFor: 'input needed', source: 'fs' })).waitReason)
      .toEqual({ kind: 'input', text: 'input needed' });
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

import { describe, expect, it } from 'vitest';
import { ANSWER_MAX, applyEvent, markSeen, MAX_RECENT_ACTIONS, normalizeSession, settleRestored } from '../../src/core/reducer.js';
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

  it('takes a pane and its tmux session together, from the same session.seen', () => {
    const named = run(ev('session.seen', 1000, { workspace: WS, tmuxPane: '%7', tmuxSession: 'work' }));
    expect([named.tmuxPane, named.tmuxSession]).toEqual(['%7', 'work']);
    const kept = applyEvent(named, ev('session.seen', 1100, { workspace: WS, tmuxPane: null }))!;
    expect([kept.tmuxPane, kept.tmuxSession]).toEqual(['%7', 'work']);
    const moved = applyEvent(named, ev('session.seen', 1200, { workspace: WS, tmuxPane: '%9' }))!;
    expect([moved.tmuxPane, moved.tmuxSession]).toEqual(['%9', null]);
    expect(run(seen()).tmuxSession).toBeNull();
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

  it('makes no subagent of an end it cannot place, and still ends the wait the agent raised', () => {
    const waiting = run(seen(), ev('prompt', 1100, { text: 'x' }), ev('tool.started', 1200, { toolId: 'm1', tool: 'Agent', label: 'Agent: Review', agentId: null }),
      ev('waiting', 1300, { reason: { kind: 'permission', text: 'Bash' }, agentId: 'ghost' }));
    const ended = applyEvent(waiting, ev('agent.finished', 1400, { agentId: 'ghost' }))!;
    expect(ended).toMatchObject({ state: 'working', stateSince: 1400, waitAgentId: null, children: [] });
    const done = run(seen(), ev('prompt', 1100, { text: 'x' }), ev('turn.finished', 1200, { backgroundTasks: 0 }));
    for (const source of ['hook', 'fs'] as const) expect(applyEvent(done, ev('agent.finished', 1300, { agentId: 'ghost', source }))!.children).toEqual([]);
  });

  it('does not start again a subagent a hook ended, on the word of a transcript written before that end', () => {
    // The filesystem marks a subagent running while its transcript is fresh: one that a hook ended first stays ended.
    let s = run(seen(), ev('prompt', 1050, { text: 'x' }), ev('agent.started', 1100, { agentId: 'c1', agentType: 'Explore', description: null }),
      ev('agent.finished', 1200, { agentId: 'c1' }));
    s = applyEvent(s, ev('agent.started', 1150, { agentId: 'c1', agentType: 'Explore', description: null, source: 'fs' }))!;
    s = applyEvent(s, ev('turn.finished', 1250, { backgroundTasks: 0 }))!;
    expect([s.state, s.children.map((c) => c.running)]).toEqual(['done', [false]]);
    // A teammate that wakes up writes on: it runs again.
    s = applyEvent(s, ev('agent.started', 1300, { agentId: 'c1', agentType: 'Explore', description: null, source: 'fs' }))!;
    expect([s.state, s.children.map((c) => [c.running, c.updatedAt])]).toEqual(['done', [[true, 1300]]]);
  });

  it('starts again a subagent a restart stopped, on the word of a transcript as old as what the store last heard of it, but not once a hook has ended it', () => {
    const saved = run(seen(), ev('prompt', 1050, { text: 'x' }), ev('agent.started', 1100, { agentId: 'c1', agentType: 'Explore', description: null, source: 'fs' }),
      ev('turn.finished', 1200, { backgroundTasks: 1 }));
    // c1 ran when the session was saved. The restart stopped it before anything reported on it, as it does in a session
    // the first scan does not track; then the filesystem reads its transcript, last written when the store last heard of it.
    let s: Session = { ...saved, state: 'done', children: saved.children.map((c) => ({ ...c, running: false, restored: true })) };
    s = applyEvent(s, ev('agent.started', 1100, { agentId: 'c1', agentType: 'Explore', description: null, source: 'fs' }))!;
    expect(s.children).toEqual(saved.children);
    // A hook ends it: a transcript written before that end does not start it again.
    s = applyEvent(s, ev('agent.finished', 1300, { agentId: 'c1' }))!;
    s = applyEvent(s, ev('agent.started', 1250, { agentId: 'c1', agentType: 'Explore', description: null, source: 'fs' }))!;
    expect(s.children).toEqual([{ ...saved.children[0]!, running: false, updatedAt: 1300 }]);
    // One a hook ended before the restart is restored as it was, and such a transcript does not start it again either.
    const ended = normalizeSession(run(seen(), ev('prompt', 1050, { text: 'x' }), ev('agent.started', 1100, { agentId: 'c2', agentType: 'Explore', description: null }),
      ev('agent.finished', 1200, { agentId: 'c2' }), ev('turn.finished', 1250, { backgroundTasks: 0 })));
    expect(applyEvent(ended, ev('agent.started', 1150, { agentId: 'c2', agentType: 'Explore', description: null, source: 'fs' }))!.children).toEqual([
      { id: 'c2', type: 'Explore', description: null, running: false, lastAction: null, updatedAt: 1200 },
    ]);
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

describe('what a summary reads', () => {
  it('keeps the latest reply by its time, cleaned and cut to ANSWER_MAX code points, and changes nothing else', () => {
    const working = run(seen(), ev('prompt', 1100, { text: 'x' }));
    let s = applyEvent(working, ev('answer', 1300, { text: 'Tests\u0007 pass.\nShipping next.' }))!;
    expect(s).toMatchObject({ lastAnswer: 'Tests pass. Shipping next.', lastAnswerAt: 1300, state: 'working', lastEventAt: 1100 });
    s = applyEvent(s, ev('answer', 1200, { text: 'An older reply' }))!;
    expect(s.lastAnswer).toBe('Tests pass. Shipping next.');
    s = applyEvent(s, ev('answer', 1400, { text: '\u0007 \u202E' }))!;
    expect(s.lastAnswerAt).toBe(1300);
    s = applyEvent(s, ev('answer', 1400, { text: '\u{1F600}'.repeat(ANSWER_MAX + 5) }))!;
    expect(ANSWER_MAX).toBe(2000);
    expect(Array.from(s.lastAnswer!)).toHaveLength(ANSWER_MAX);
    expect(s.lastAnswer!.endsWith('\u2026')).toBe(true);
  });

  it('records when the user last sent a prompt, whatever order prompts arrive in', () => {
    const s = run(seen(), ev('prompt', 1200, { text: 'second' }), ev('prompt', 1100, { text: 'first' }), ev('prompt', 1300, { text: null }));
    expect(s).toMatchObject({ lastPromptAt: 1200, lastPrompt: 'second' });
    expect(applyEvent(s, ev('prompt', 1400, { text: 'third' }))).toMatchObject({ lastPromptAt: 1400 });
    expect(run(seen()).lastPromptAt).toBeNull();
  });

  it("keeps the main agent's last MAX_RECENT_ACTIONS actions, oldest first, without a repeat in a row", () => {
    const tool = (ts: number, label: string, agentId: string | null = null) => ev('tool.started', ts, { toolId: `t${ts}`, tool: 'Read', label, agentId });
    let s = run(seen(), tool(1100, 'Read a.ts'), tool(1110, 'Read a.ts'), tool(1120, 'Edit a.ts'), tool(1130, 'Grep useCart', 'a1'), tool(1050, 'Read late.ts'), tool(1140, 'Read a.ts'));
    expect(MAX_RECENT_ACTIONS).toBe(10);
    expect(s.recentActions).toEqual(['Read a.ts', 'Edit a.ts', 'Read a.ts']);
    for (let i = 1; i <= 12; i++) s = applyEvent(s, tool(1200 + i, `Bash: step ${i}`))!;
    expect(s.recentActions).toEqual(Array.from({ length: 10 }, (_, i) => `Bash: step ${i + 3}`));
  });
});

describe('normalizeSession', () => {
  it('keeps a subagent that ran running, marked as restored, with the meeting it holds, until it is settled: it stops then, and the meeting ends as of when it began', () => {
    const s = run(seen(), ev('prompt', 1040, { text: 'x' }), ev('agent.started', 1050, { agentId: 'a1', agentType: 'Explore', description: null }),
      ev('agent.started', 1060, { agentId: 'a2', agentType: 'Plan', description: null }), ev('agent.finished', 1070, { agentId: 'a2' }),
      ev('turn.finished', 1100, { backgroundTasks: 0 }));
    expect(s).toMatchObject({ state: 'in_meeting', stateSince: 1100, seenAt: null });
    expect(s.children.map((c) => c.running)).toEqual([true, false]);
    const n = normalizeSession(s);
    expect(n).toEqual({ ...s, children: [{ ...s.children[0]!, restored: true }, s.children[1]!] });
    const settled = settleRestored(n);
    expect(settled.children).toEqual([{ ...s.children[0]!, running: false, restored: true }, s.children[1]!]);
    expect({ ...settled, children: s.children }).toEqual({ ...s, state: 'done' });
    // Settled once, there is nothing left to settle.
    expect(settleRestored(settled)).toBe(settled);
  });

  it('keeps the state of a session that holds no meeting', () => {
    const working = run(seen(), ev('prompt', 1040, { text: 'x' }), ev('agent.started', 1050, { agentId: 'a1', agentType: 'Explore', description: null }));
    const n = normalizeSession(working);
    expect(n).toMatchObject({ state: 'working', stateSince: 1040, children: [{ id: 'a1', running: true, restored: true }] });
    expect(settleRestored(n)).toMatchObject({ state: 'working', stateSince: 1040, children: [{ id: 'a1', running: false, restored: true }] });
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

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { countBackgroundTasks, HOOK_EVENTS, mapHookPayload } from '../../src/adapters/claude-code/hooks.js';
import { Collector } from '../../src/collector.js';

const fx = (name: string): unknown => JSON.parse(readFileSync(new URL(`../fixtures/hooks/${name}.json`, import.meta.url), 'utf8'));
const NOW = 1_800_000_000_000;
const SID = '11111111-1111-4111-8111-111111111111';
const CWD = '/home/dev/shop/orders-api';
const base = (ts: number) => ({ sessionId: SID, ts, source: 'hook', cwd: CWD });

describe('HOOK_EVENTS', () => {
  it('lists the payload names the mapper understands', () => {
    expect(HOOK_EVENTS).toEqual(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'Notification', 'Stop', 'SubagentStart', 'SubagentStop', 'SessionEnd']);
  });
});

describe('mapHookPayload with the mod fixtures', () => {
  it('UserPromptSubmit becomes a prompt, timed by the mod', () => {
    expect(mapHookPayload(fx('UserPromptSubmit'), NOW)).toEqual([{ ...base(1791660000000), type: 'prompt', text: 'Run ls with the Bash tool, then reply with the single word ok.' }]);
  });

  it('PreToolUse and PostToolUse track a main-thread tool', () => {
    expect(mapHookPayload(fx('PreToolUse'), NOW)).toEqual([{ ...base(1791660001000), type: 'tool.started', toolId: 'toolu_01ABCDEFGHIJKLMNOPQRSTUV', tool: 'Bash', label: 'Bash: ls', agentId: null }]);
    expect(mapHookPayload(fx('PostToolUse'), NOW)).toEqual([{ ...base(1791660002000), type: 'tool.finished', toolId: 'toolu_01ABCDEFGHIJKLMNOPQRSTUV', ok: true, agentId: null }]);
    expect(mapHookPayload(fx('PostToolUseFailure'), NOW)).toEqual([{ ...base(1791660002500), type: 'tool.finished', toolId: 'toolu_02ABCDEFGHIJKLMNOPQRSTUV', ok: false, agentId: null }]);
  });

  it('tool events inside a subagent carry its id', () => {
    expect(mapHookPayload(fx('PreToolUse.subagent'), NOW)).toEqual([{ ...base(1791660002700), type: 'tool.started', toolId: 'toolu_03ABCDEFGHIJKLMNOPQRSTUV', tool: 'Grep', label: 'Grep useCart', agentId: 'a58cb74ebedcc3070' }]);
  });

  it('AskUserQuestion waits for an answer', () => {
    expect(mapHookPayload(fx('PreToolUse.AskUserQuestion'), NOW)).toEqual([{ ...base(1791660002800), type: 'waiting', reason: { kind: 'question', text: 'Should the retry queue use Redis or Postgres?' }, agentId: null }]);
  });

  it('PermissionRequest waits with the command as detail', () => {
    expect(mapHookPayload(fx('PermissionRequest'), NOW)).toEqual([{ ...base(1791660003000), type: 'waiting', reason: { kind: 'permission', text: 'Bash', detail: 'Bash: rm -rf dist && npm run build' }, agentId: null }]);
  });

  it('SubagentStart, Stop and SessionEnd', () => {
    expect(mapHookPayload(fx('SubagentStart'), NOW)).toEqual([{ ...base(1791660004000), type: 'agent.started', agentId: 'a58cb74ebedcc3070', agentType: 'Explore', description: 'Find every caller of useCart', runId: null, phase: null }]);
    expect(mapHookPayload(fx('Stop'), NOW)).toEqual([
      { ...base(1791660005000), type: 'answer', text: 'Ran ls: the folder holds src, test and package.json. ok' },
      { ...base(1791660005000), type: 'turn.finished', backgroundTasks: 0 },
    ]);
    expect(mapHookPayload(fx('SessionEnd'), NOW)).toEqual([{ ...base(1791660006000), type: 'session.ended', reason: 'other' }]);
  });

  it('an agent a workflow script started names its run', () => {
    expect(mapHookPayload(fx('SubagentStart.workflow'), NOW)).toEqual([
      { ...base(1791660004200), type: 'agent.started', agentId: 'a7c41e09b2d35f681', agentType: 'workflow-subagent', description: 'plan:orders-api', runId: 'wf_0000aaaa-001', phase: null },
    ]);
  });

  it('the end of a subagent turn ends that subagent, not the session turn', () => {
    expect(mapHookPayload(fx('Stop.subagent'), NOW)).toEqual([{ ...base(1791660004500), type: 'agent.finished', agentId: 'a58cb74ebedcc3070' }]);
  });

  it('maps a whole batch, item by item, in order', () => {
    const batch = fx('batch') as unknown[];
    expect(batch.flatMap((p) => mapHookPayload(p, NOW)).map((e) => e.type)).toEqual(['prompt', 'tool.started', 'tool.finished', 'answer', 'turn.finished']);
  });
});

describe('the mod fixtures through the collector', () => {
  it('a subagent whose turn ended holds no meeting: the session turn that follows ends done', async () => {
    const c = new Collector({ resolveWorkspace: async (cwd) => ({ cwd, repoRoot: cwd, repoName: 'orders-api', worktree: false, branch: 'main' }), now: () => NOW, saveDelayMs: 0 });
    for (const name of ['SubagentStart', 'Stop.subagent', 'Stop']) for (const e of mapHookPayload(fx(name), NOW)) await c.ingest(e);
    expect(c.view(SID)).toMatchObject({ state: 'done', stateSince: 1791660005000, children: [{ id: 'a58cb74ebedcc3070', type: 'Explore', running: false }] });
  });
});

describe('mapHookPayload edge cases', () => {
  const p = { session_id: 'S1', cwd: '/w/shop' };

  it('falls back to arrival time without a timestamp from the sender', () => {
    expect(mapHookPayload({ ...p, hook_event_name: 'Stop' }, NOW)[0]).toMatchObject({ ts: NOW });
  });

  it('understands the names the mod does not send today', () => {
    expect(mapHookPayload({ ...p, hook_event_name: 'SessionStart', source: 'startup' }, NOW)).toEqual([expect.objectContaining({ type: 'session.started' })]);
    expect(mapHookPayload({ ...p, hook_event_name: 'SessionStart', source: 'compact' }, NOW)).toEqual([]);
    expect(mapHookPayload({ ...p, hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' }, NOW))
      .toEqual([expect.objectContaining({ type: 'waiting', reason: { kind: 'permission', text: 'Claude needs your permission to use Bash' } })]);
    expect(mapHookPayload({ ...p, hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'Claude is waiting for your input' }, NOW)).toEqual([]);
    expect(mapHookPayload({ ...p, hook_event_name: 'SubagentStop', agent_id: 'a1' }, NOW)).toEqual([expect.objectContaining({ type: 'agent.finished', agentId: 'a1' })]);
  });

  it('ignores subagent-only lifecycle events and unknown events', () => {
    expect(mapHookPayload({ ...p, hook_event_name: 'SessionEnd', agent_id: 'a1' }, NOW)).toEqual([]);
    expect(mapHookPayload({ ...p, hook_event_name: 'SubagentStart' }, NOW)).toEqual([]);
    expect(mapHookPayload({ ...p, hook_event_name: 'PreCompact' }, NOW)).toEqual([]);
  });

  it("reads the main loop's final reply, cleaned and cut, and no reply from a subagent's turn end", () => {
    const stop = (extra: Record<string, unknown>) => mapHookPayload({ ...p, hook_event_name: 'Stop', ...extra }, NOW);
    expect(stop({ last_assistant_message: 'Done\u0007.\n\nAll green \u202E' })).toEqual([
      expect.objectContaining({ type: 'answer', text: 'Done. All green' }),
      expect.objectContaining({ type: 'turn.finished' }),
    ]);
    expect((stop({ last_assistant_message: 'x'.repeat(2500) })[0] as { text: string }).text).toHaveLength(2000);
    for (const empty of ['', ' \u0007 ', 42, null, ['ok']]) expect(stop({ last_assistant_message: empty }).map((e) => e.type)).toEqual(['turn.finished']);
    expect(stop({ agent_id: 'a1', last_assistant_message: 'found 3 callers' })).toEqual([expect.objectContaining({ type: 'agent.finished', agentId: 'a1' })]);
  });

  it('takes a run id only when it is one, and a cleaned description of at most 200 characters', () => {
    const start = (extra: Record<string, unknown>) => mapHookPayload({ ...p, hook_event_name: 'SubagentStart', agent_id: 'a1', ...extra }, NOW)[0];
    for (const runId of ['wf_', 'wf_a/b', '../wf_1', 42, 'run-1']) expect(start({ workflow_run_id: runId })).toMatchObject({ runId: null });
    expect(start({ workflow_run_id: 'wf_0000aaaa-001' })).toMatchObject({ runId: 'wf_0000aaaa-001', phase: null, agentType: 'agent', description: null });
    expect(start({ description: 'd'.repeat(300) })).toMatchObject({ description: 'd'.repeat(199) + '\u2026' });
    expect(start({ description: '\u0007\u202E' })).toMatchObject({ description: null });
  });

  it('a permission request inside a subagent still needs the user, and says whose it is', () => {
    expect(mapHookPayload({ ...p, hook_event_name: 'PermissionRequest', agent_id: 'a1', tool_name: 'Write', tool_input: { file_path: '/w/shop/a.ts' } }, NOW))
      .toEqual([expect.objectContaining({ type: 'waiting', reason: { kind: 'permission', text: 'Write', detail: 'Write a.ts' }, agentId: 'a1' })]);
    expect(mapHookPayload({ ...p, hook_event_name: 'Notification', agent_id: 'a1', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Write' }, NOW))
      .toEqual([expect.objectContaining({ type: 'waiting', agentId: 'a1' })]);
  });

  it('cleans the text of a wait first, and falls back to a default when nothing is left', () => {
    const reason = (extra: Record<string, unknown>) => (mapHookPayload({ ...p, ...extra }, NOW)[0] as { reason?: unknown }).reason;
    expect(reason({ hook_event_name: 'PermissionRequest', tool_name: 'Ba\u001b[2Ksh\u202E' })).toEqual({ kind: 'permission', text: 'Ba[2Ksh', detail: 'Ba[2Ksh' });
    expect(reason({ hook_event_name: 'PermissionRequest', tool_name: '\u0007\u202E' })).toEqual({ kind: 'permission', text: 'Permission' });
    expect(reason({ hook_event_name: 'PermissionRequest', tool_name: 'x'.repeat(200) })).toMatchObject({ text: 'x'.repeat(119) + '\u2026' });
    expect(reason({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: '\u0007 \u202E' })).toEqual({ kind: 'permission', text: 'Permission needed' });
    expect(reason({ hook_event_name: 'Notification', notification_type: 'elicitation_dialog', message: '\u0000' })).toEqual({ kind: 'question', text: 'Input needed' });
  });

  it('rejects a session id that could not name a session in a URL or a file name', () => {
    for (const id of ['..', '.', '../../etc/passwd', 'a/b', 'a\\b', 'a\u0007', '%2e%2e']) {
      expect([id, mapHookPayload({ session_id: id, cwd: '/w/shop', hook_event_name: 'UserPromptSubmit', prompt: 'hi' }, NOW)]).toEqual([id, []]);
    }
    expect(mapHookPayload({ session_id: '7ef904e4-9872-4cca-924f-e7ddde08fc55', cwd: '/w/shop', hook_event_name: 'Stop' }, NOW)).toHaveLength(1);
  });

  it('rejects payloads without a session or event name', () => {
    expect(mapHookPayload(null, NOW)).toEqual([]);
    expect(mapHookPayload('x', NOW)).toEqual([]);
    expect(mapHookPayload([], NOW)).toEqual([]);
    expect(mapHookPayload({ hook_event_name: 'Stop' }, NOW)).toEqual([]);
    expect(mapHookPayload({ session_id: 'S1' }, NOW)).toEqual([]);
  });
});

describe('countBackgroundTasks', () => {
  it('accepts a count, an array or an object', () => {
    expect(countBackgroundTasks(3)).toBe(3);
    expect(countBackgroundTasks([{}, {}])).toBe(2);
    expect(countBackgroundTasks({ a: 1 })).toBe(1);
    expect(countBackgroundTasks(-1)).toBe(0);
    expect(countBackgroundTasks('x')).toBe(0);
    expect(countBackgroundTasks(undefined)).toBe(0);
  });
});

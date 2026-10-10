import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { countBackgroundTasks, HOOK_EVENTS, mapHookPayload } from '../../src/adapters/claude-code/hooks.js';

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
    expect(mapHookPayload(fx('PreToolUse.AskUserQuestion'), NOW)).toEqual([{ ...base(1791660002800), type: 'waiting', reason: { kind: 'question', text: 'Should the retry queue use Redis or Postgres?' } }]);
  });

  it('PermissionRequest waits with the command as detail', () => {
    expect(mapHookPayload(fx('PermissionRequest'), NOW)).toEqual([{ ...base(1791660003000), type: 'waiting', reason: { kind: 'permission', text: 'Bash', detail: 'Bash: rm -rf dist && npm run build' } }]);
  });

  it('SubagentStart, Stop and SessionEnd', () => {
    expect(mapHookPayload(fx('SubagentStart'), NOW)).toEqual([{ ...base(1791660004000), type: 'agent.started', agentId: 'a58cb74ebedcc3070', agentType: 'Explore', description: null }]);
    expect(mapHookPayload(fx('Stop'), NOW)).toEqual([{ ...base(1791660005000), type: 'turn.finished', backgroundTasks: 0 }]);
    expect(mapHookPayload(fx('SessionEnd'), NOW)).toEqual([{ ...base(1791660006000), type: 'session.ended', reason: 'other' }]);
  });

  it('maps a whole batch, item by item, in order', () => {
    const batch = fx('batch') as unknown[];
    expect(batch.flatMap((p) => mapHookPayload(p, NOW)).map((e) => e.type)).toEqual(['prompt', 'tool.started', 'tool.finished', 'turn.finished']);
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
    expect(mapHookPayload({ ...p, hook_event_name: 'Stop', agent_id: 'a1' }, NOW)).toEqual([]);
    expect(mapHookPayload({ ...p, hook_event_name: 'SessionEnd', agent_id: 'a1' }, NOW)).toEqual([]);
    expect(mapHookPayload({ ...p, hook_event_name: 'SubagentStart' }, NOW)).toEqual([]);
    expect(mapHookPayload({ ...p, hook_event_name: 'PreCompact' }, NOW)).toEqual([]);
  });

  it('a permission request inside a subagent still needs the user', () => {
    expect(mapHookPayload({ ...p, hook_event_name: 'PermissionRequest', agent_id: 'a1', tool_name: 'Write', tool_input: { file_path: '/w/shop/a.ts' } }, NOW))
      .toEqual([expect.objectContaining({ type: 'waiting', reason: { kind: 'permission', text: 'Write', detail: 'Write a.ts' } })]);
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

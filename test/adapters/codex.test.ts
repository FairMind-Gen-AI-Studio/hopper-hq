import { afterEach, describe, expect, it } from 'vitest';
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRolloutLine } from '../../src/adapters/codex/rollout.js';
import { CodexAdapter } from '../../src/adapters/codex/fs-adapter.js';
import { mapCodexHook } from '../../src/adapters/codex/hooks.js';
import { Collector } from '../../src/collector.js';
import type { RawEvent } from '../../src/core/types.js';
import { newSession } from '../../src/core/reducer.js';
import { formatBuilding } from '../../src/cli-format.js';

const cwd = '/work/api';
const id = '11111111-1111-4111-8111-111111111111';
const sessionId = `codex-${id}`;
const resolveWorkspace = async (cwd: string) => ({ cwd, root: cwd, repoRoot: '/work/api', repoName: 'api', branch: 'feat/login', worktree: false });
const record = (type: string, payload: unknown, ts = '2026-10-17T10:00:01Z') => JSON.stringify({ timestamp: ts, type, payload });
const fixture = () => readFile(new URL('../fixtures/codex/rollout.jsonl', import.meta.url), 'utf8');
const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });

describe('Codex rollout contract', () => {
  it('maps a redacted legacy rollout to a Codex desk beside Claude on the same floor', async () => {
    const c = new Collector({ resolveWorkspace, now: () => Date.parse('2026-10-17T10:01:00Z') });
    const events = (await fixture()).trim().split('\n').flatMap(l => parseRolloutLine(l, { sessionId, cwd }).events);
    expect(events.map(e => e.type)).toEqual(['session.status', 'prompt', 'tool.started', 'tool.finished', 'answer', 'turn.finished']);
    await c.ingest({ type: 'session.seen', source: 'fs', sessionId, cwd, ts: 1, workspace: await resolveWorkspace(cwd), agentKind: 'codex' });
    for (const e of events) await c.ingest(e);
    await c.ingest({ type: 'session.seen', source: 'fs', sessionId: 'claude1', cwd, ts: 1, workspace: await resolveWorkspace(cwd) });
    expect(c.session(sessionId)).toMatchObject({ agentKind: 'codex', state: 'done', lastPrompt: 'Add login', lastAnswer: 'Login is ready.' });
    expect(c.snapshot().floors).toHaveLength(1);
    const floor = c.floor(c.scene().floors[0]!.key)!;
    expect(floor.pods.flatMap(p => p.desks).find(d => d.occupant?.sessionId === sessionId)?.occupant).toMatchObject({ agentKind: 'codex', name: 'api-1111' });
    expect(formatBuilding(c.snapshot())).toContain('Codex');
    await c.close();
  });
  it('reads paginated items, explicit questions and subagent activity; never guesses permission from tool arguments', () => {
    const parse = (p: unknown) => parseRolloutLine(record('event_msg', p), { sessionId, cwd }).events;
    expect(parse({ type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: 'hello' }] } })[0]).toMatchObject({ type: 'prompt', text: 'hello' });
    expect(parse({ type: 'item_completed', item: { type: 'AgentMessage', content: [{ type: 'Text', text: 'reply' }] } })[0]).toMatchObject({ type: 'answer', text: 'reply' });
    expect(parse({ type: 'sub_agent_activity', kind: 'started', agent_thread_id: 'child1', agent_path: '/root/child' })[0]).toMatchObject({ type: 'agent.started', agentId: 'child1' });
    expect(parse({ type: 'item_completed', item: { type: 'SubAgentActivity', kind: 'completed', agent_thread_id: 'child1' } })[0]).toMatchObject({ type: 'agent.finished' });
    const e = parseRolloutLine(record('response_item', { type: 'function_call', name: 'request_user_input', call_id: 'q', arguments: JSON.stringify({ questions: [{ question: 'Which database?' }] }) }), { sessionId, cwd }).events;
    expect(e.at(-1)).toMatchObject({ type: 'waiting', reason: { kind: 'question', text: 'Which database?' } });
    expect(parseRolloutLine(record('response_item', { type: 'function_call', name: 'exec_command', arguments: '{"sandbox_permissions":"require_escalated"}' }), { sessionId, cwd }).events.some(e => e.type === 'waiting')).toBe(false);
  });
  it('skips and counts malformed or unknown records and rejects invalid timestamps', () => {
    for (const l of ['{', 'null', record('future', {}), record('event_msg', { type: 'future' }), record('event_msg', { type: 'task_started' }, 'bad')]) {
      expect(parseRolloutLine(l, { sessionId, cwd })).toMatchObject({ events: [], skipped: 1 });
    }
  });
});

describe('Codex file discovery', () => {
  it('tails dated rollouts without changing them, ignores non-CLI sources, and waits for complete lines', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hopper-codex-')); dirs.push(dir);
    const day = join(dir, 'sessions/2026/10/17'); await mkdir(day, { recursive: true });
    const path = join(day, 'rollout-session.jsonl'); await writeFile(path, await fixture());
    await writeFile(join(day, 'rollout-app.jsonl'), record('session_meta', { id: 'app', cwd, source: 'vscode', cli_version: '0.162.0' }) + '\n');
    const before = await stat(path);
    const events: RawEvent[] = [];
    const a = new CodexAdapter({ codexDir: dir, emit: e => events.push(e), resolveWorkspace });
    await a.poll();
    expect(events[0]).toMatchObject({ type: 'session.seen', agentKind: 'codex', sessionId, cwd, transcriptPath: path });
    expect(events.some(e => e.sessionId === 'codex-app')).toBe(false);
    const count = events.length; await a.poll(); expect(events).toHaveLength(count);
    expect(await readFile(path, 'utf8')).toBe(await fixture());
    const next = record('event_msg', { type: 'task_started' }, '2026-10-17T11:00:00Z');
    await appendFile(path, next); await a.poll(); expect(events).toHaveLength(count);
    await appendFile(path, '\n' + record('future', {}) + '\n'); await a.poll();
    expect(events.at(-1)?.type).toBe('session.status'); expect(a.skipped).toBe(1);
    expect((await stat(path)).mode).toBe(before.mode);
    a.stop();
  });
});

describe('Codex hook contract', () => {
  it('isolates identity and maps live approval, tools, turn end, tmux and child lifecycle', async () => {
    const c = new Collector({ resolveWorkspace });
    const hook = async (hook_event_name: string, extra = {}) => { for (const e of mapCodexHook({ session_id: id, cwd, hook_event_name, ...extra }, 100)) await c.ingest(e); };
    await hook('SessionStart', { hopper_tmux_pane: '%7', hopper_tmux_session: 'work' });
    expect(c.session(sessionId)).toMatchObject({ agentKind: 'codex', tmuxPane: '%7', tmuxSession: 'work' });
    await hook('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'npm test' } });
    expect(c.session(sessionId)).toMatchObject({ state: 'needs_you', waitReason: { kind: 'permission' } });
    await hook('PostToolUse', { tool_name: 'Bash', tool_use_id: 'a' });
    expect(c.session(sessionId)?.state).toBe('working');
    await hook('SubagentStart', { agent_id: 'child1', agent_type: 'explorer' });
    await hook('Stop'); expect(c.session(sessionId)?.state).toBe('in_meeting');
    await hook('SubagentStop', { agent_id: 'child1' }); expect(c.session(sessionId)?.state).toBe('done');
    await hook('SessionEnd'); expect(c.session(sessionId)?.state).toBe('ended');
    expect(newSession('legacy', 1, await resolveWorkspace(cwd)).agentKind).toBe('claude-code');
    await c.close();
  });
});

it('starts working before the first prompt arrives', async () => {
  const c = new Collector({ resolveWorkspace });
  await c.ingest({ type: 'session.seen', source: 'fs', sessionId, ts: 0, cwd, agentKind: 'codex', workspace: await resolveWorkspace(cwd) });
  for (const event of parseRolloutLine(record('event_msg', { type: 'task_started' }), { sessionId, cwd }).events) await c.ingest(event);
  expect(c.session(sessionId)?.state).toBe('working');
  await c.close();
});

it('preserves lifecycle events before a large rollout tail', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hopper-codex-large-')); dirs.push(dir);
  await mkdir(join(dir, 'sessions'));
  const lines = (await fixture()).trim().split('\n');
  const child = record('event_msg', { type: 'sub_agent_activity', kind: 'started', agent_thread_id: 'child1' }, '2026-10-17T10:00:04Z');
  const padding = record('event_msg', { type: 'token_count', padding: 'x'.repeat(1024 * 1024) }, '2026-10-17T10:00:04Z');
  await writeFile(join(dir, 'sessions/rollout-large.jsonl'), [...lines.slice(0, -1), child, padding, lines.at(-1)].join('\n') + '\n');
  const c = new Collector({ resolveWorkspace });
  const a = new CodexAdapter({ codexDir: dir, resolveWorkspace, emit: e => void c.ingest(e) });
  await a.poll(); await c.idle();
  expect(c.session(sessionId)).toMatchObject({ state: 'in_meeting', children: [{ id: 'child1', running: true }] });
  a.stop(); await c.close();
});

it('uses a resumed turn cwd and follows its current branch rather than stale session metadata', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hopper-codex-cwd-')); dirs.push(dir);
  await mkdir(join(dir, 'sessions'));
  const newCwd = '/work/other';
  const resolve = async (path: string) => ({ ...await resolveWorkspace(path), branch: path === newCwd ? 'feat/other' : 'feat/login' });
  const path = join(dir, 'sessions/rollout-cwd.jsonl');
  await writeFile(path, await fixture() + record('turn_context', { cwd: newCwd }) + '\n' + record('event_msg', { type: 'user_message', message: 'Continue here' }, '2026-10-17T12:00:00Z') + '\n');
  const c = new Collector({ resolveWorkspace: resolve });
  const a = new CodexAdapter({ codexDir: dir, resolveWorkspace: resolve, emit: e => void c.ingest(e) });
  await a.poll(); await c.idle();
  expect(c.session(sessionId)?.workspace).toMatchObject({ cwd: newCwd, branch: 'feat/other' });
  expect(c.session(sessionId)?.lastPrompt).toBe('Continue here');
  a.stop(); await c.close();
});

it('clears an active wait when Codex reports an interruption', async () => {
  const c = new Collector({ resolveWorkspace });
  for (const e of mapCodexHook({ session_id: id, cwd, hook_event_name: 'PermissionRequest', tool_name: 'Bash' }, 100)) await c.ingest(e);
  expect(c.session(sessionId)?.state).toBe('needs_you');
  for (const e of mapCodexHook({ session_id: id, cwd, hook_event_name: 'Interrupt' }, 101)) await c.ingest(e);
  expect(c.session(sessionId)).toMatchObject({ state: 'done', waitReason: null, openTool: null });
  await c.close();
});

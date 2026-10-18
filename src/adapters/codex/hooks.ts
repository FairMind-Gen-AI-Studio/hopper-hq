import { mapHookPayload } from '../claude-code/hooks.js';
import type { RawEvent } from '../../core/types.js';
import { codexSessionId, object, string } from './rollout.js';
import { cleanOrNull, isSessionId } from '../../scene/text.js';

/** Codex's experimental Claude-compatible hooks carry raw payloads, never normalized collector events. */
export function mapCodexHook(payload: unknown, now: number): RawEvent[] {
  const p = object(payload);
  const id = string(p.session_id);
  if (!id || !isSessionId(codexSessionId(id)) || !string(p.cwd)) return [];
  const sessionId = codexSessionId(id);
  const tool = string(p.tool_name);
  const toolName = tool === 'request_user_input' ? 'AskUserQuestion' : tool;
  if (p.hook_event_name === 'Interrupt') return [{ type: 'session.status', sessionId, agentKind: 'codex', source: 'hook', cwd: string(p.cwd), ts: typeof p._hopper_ts === 'number' && Number.isFinite(p._hopper_ts) ? p._hopper_ts : now, status: 'idle', waitingFor: null }];
  const events: RawEvent[] = mapHookPayload({ ...p, session_id: sessionId, tool_name: toolName }, now).map(e => ({ ...e, agentKind: 'codex' }));
  const pane = string(p.hopper_tmux_pane);
  if (/^%\d+$/.test(pane)) {
    // Collector fills workspace via its resolver; metadata is attached by the dedicated event.
    events.push({ type: 'session.focus', sessionId, agentKind: 'codex', source: 'hook', cwd: string(p.cwd), ts: now, tmuxPane: pane, tmuxSession: cleanOrNull(p.hopper_tmux_session, 100) });
  }
  return events;
}

import { AGENT_ID, ANSWER_MAX, RUN_ID } from '../../core/reducer.js';
import { isSmokeTest, toolLabel, truncate, waitingFromTool } from '../../core/tool-label.js';
import type { RawEvent } from '../../core/types.js';
import { isSessionId } from '../../scene/text.js';
import { promptText } from './transcript.js';

/** The payload names the mapper understands. The mod sends a subset (see test/mod-contract.test.ts). */
export const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Notification',
  'Stop',
  'SubagentStart',
  'SubagentStop',
  'SessionEnd',
] as const;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** background_tasks is not documented in detail: accept a count, an array or an object. */
export function countBackgroundTasks(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.max(0, Math.floor(v));
  if (Array.isArray(v)) return v.length;
  if (v && typeof v === 'object') return Object.keys(v).length;
  return 0;
}

const QUESTION_NOTIFICATIONS = new Set(['elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input']);

export function mapHookPayload(payload: unknown, receivedAt: number): RawEvent[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  const p = payload as Record<string, unknown>;
  const sessionId = str(p.session_id);
  const name = str(p.hook_event_name);
  if (!isSessionId(sessionId) || !name) return [];

  const ts = typeof p._hopper_ts === 'number' && Number.isFinite(p._hopper_ts) ? p._hopper_ts : receivedAt;
  const cwd = str(p.cwd);
  const agentId = str(p.agent_id) || null;
  // An agent id that is not one names no agent: the payload is dropped, not taken as the session's.
  if (agentId !== null && !AGENT_ID.test(agentId)) return [];
  const toolName = str(p.tool_name);
  const toolId = str(p.tool_use_id) || null;
  const base = { sessionId, ts, source: 'hook' as const, ...(cwd ? { cwd } : {}) };

  switch (name) {
    case 'SessionStart':
      return agentId || p.source === 'compact' ? [] : [{ ...base, type: 'session.started' }];
    case 'UserPromptSubmit':
      return [{ ...base, type: 'prompt', text: promptText(p.prompt) }];
    case 'PreToolUse': {
      if (!toolName) return [];
      const wait = agentId ? null : waitingFromTool(toolName, p.tool_input);
      if (wait) return [{ ...base, type: 'waiting', reason: wait, agentId: null }];
      const smoke = isSmokeTest(toolName, p.tool_input);
      return [{ ...base, type: 'tool.started', toolId, tool: toolName, label: toolLabel(toolName, p.tool_input, cwd || undefined), agentId, ...(smoke ? { smoke: true } : {}) }];
    }
    case 'PostToolUse':
    case 'PostToolUseFailure':
      return [{ ...base, type: 'tool.finished', toolId, ok: name === 'PostToolUse', agentId }];
    case 'PermissionRequest': {
      // Cleaned first: a default stands in for a name with nothing left.
      const tool = truncate(toolName, 120);
      return [{
        ...base,
        type: 'waiting',
        reason: { kind: 'permission', text: tool || 'Permission', ...(tool ? { detail: toolLabel(toolName, p.tool_input, cwd || undefined) } : {}) },
        agentId,
      }];
    }
    case 'Notification': {
      const type = str(p.notification_type);
      const message = truncate(str(p.message), 120);
      if (type === 'permission_prompt') return [{ ...base, type: 'waiting', reason: { kind: 'permission', text: message || 'Permission needed' }, agentId }];
      if (QUESTION_NOTIFICATIONS.has(type)) return [{ ...base, type: 'waiting', reason: { kind: 'question', text: message || 'Input needed' }, agentId }];
      return [];
    }
    case 'Stop': {
      // A subagent's turn end is that subagent's: its loop has run its course. Only the main loop's ends the session's turn.
      if (agentId) return [{ ...base, type: 'agent.finished', agentId }];
      const finished: RawEvent = { ...base, type: 'turn.finished', backgroundTasks: countBackgroundTasks(p.background_tasks) };
      // The main loop's final reply comes first: by the turn's end the session holds it.
      const answer = truncate(str(p.last_assistant_message), ANSWER_MAX);
      return answer ? [{ ...base, type: 'answer', text: answer }, finished] : [finished];
    }
    case 'SubagentStart': {
      if (!agentId) return [];
      const runId = str(p.workflow_run_id);
      return [{
        ...base,
        type: 'agent.started',
        agentId,
        agentType: str(p.agent_type) || 'agent',
        description: truncate(str(p.description), 200) || null,
        runId: RUN_ID.test(runId) ? runId : null,
        phase: null,
      }];
    }
    case 'SubagentStop':
      return agentId ? [{ ...base, type: 'agent.finished', agentId }] : [];
    case 'SessionEnd':
      return agentId ? [] : [{ ...base, type: 'session.ended', reason: str(p.reason) || 'other' }];
    default:
      return [];
  }
}

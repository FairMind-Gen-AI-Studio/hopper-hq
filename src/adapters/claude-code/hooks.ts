import { toolLabel, truncate, waitingFromTool } from '../../core/tool-label.js';
import type { RawEvent } from '../../core/types.js';
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
  if (!sessionId || !name) return [];

  const ts = typeof p._scranton_ts === 'number' && Number.isFinite(p._scranton_ts) ? p._scranton_ts : receivedAt;
  const cwd = str(p.cwd);
  const agentId = str(p.agent_id) || null;
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
      return [{ ...base, type: 'tool.started', toolId, tool: toolName, label: toolLabel(toolName, p.tool_input, cwd || undefined), agentId }];
    }
    case 'PostToolUse':
    case 'PostToolUseFailure':
      return [{ ...base, type: 'tool.finished', toolId, ok: name === 'PostToolUse', agentId }];
    case 'PermissionRequest':
      return [{
        ...base,
        type: 'waiting',
        reason: { kind: 'permission', text: toolName || 'Permission', ...(toolName ? { detail: toolLabel(toolName, p.tool_input, cwd || undefined) } : {}) },
        agentId,
      }];
    case 'Notification': {
      const type = str(p.notification_type);
      const message = str(p.message);
      if (type === 'permission_prompt') return [{ ...base, type: 'waiting', reason: { kind: 'permission', text: truncate(message || 'Permission needed', 120) }, agentId }];
      if (QUESTION_NOTIFICATIONS.has(type)) return [{ ...base, type: 'waiting', reason: { kind: 'question', text: truncate(message || 'Input needed', 120) }, agentId }];
      return [];
    }
    case 'Stop':
      return agentId ? [] : [{ ...base, type: 'turn.finished', backgroundTasks: countBackgroundTasks(p.background_tasks) }];
    case 'SubagentStart':
      return agentId ? [{ ...base, type: 'agent.started', agentId, agentType: str(p.agent_type) || 'agent', description: null }] : [];
    case 'SubagentStop':
      return agentId ? [{ ...base, type: 'agent.finished', agentId }] : [];
    case 'SessionEnd':
      return agentId ? [] : [{ ...base, type: 'session.ended', reason: str(p.reason) || 'other' }];
    default:
      return [];
  }
}

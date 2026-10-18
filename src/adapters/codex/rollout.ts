import type { RawEvent } from '../../core/types.js';
import { truncate } from '../../core/tool-label.js';
import { isSessionId } from '../../scene/text.js';

export const CODEX_VERSIONS = ['0.162.0'] as const;
export const codexSessionId = (id: string): string => `codex-${id}`;
export const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
export const string = (v: unknown): string => typeof v === 'string' ? v : '';

export interface RolloutMeta { id: string; cwd: string; version: string; ts: number }

/** Only CLI and exec roots become desks. App, internal and child threads have different lifecycles. */
export function rolloutMeta(line: string): RolloutMeta | null {
  try {
    const r = object(JSON.parse(line));
    const p = object(r.payload);
    const id = string(p.id);
    const ts = Date.parse(string(r.timestamp));
    if (r.type !== 'session_meta' || !isSessionId(codexSessionId(id)) || !id || !string(p.cwd) || !Number.isFinite(ts)) return null;
    if (p.source !== 'cli' && p.source !== 'exec') return null;
    return { id, cwd: string(p.cwd), version: truncate(string(p.cli_version), 40), ts };
  } catch { return null; }
}

function textContent(v: unknown): string {
  return Array.isArray(v) ? v.map(c => string(object(c).text)).filter(Boolean).join('\n') : '';
}

/** Rollout is an internal format: unsupported records are counted, never fatal. */
export function parseRolloutLine(line: string, context: { sessionId: string; cwd: string }): { events: RawEvent[]; skipped: number; cwd?: string } {
  let r: Record<string, unknown>;
  try { r = object(JSON.parse(line)); } catch { return { events: [], skipped: 1 }; }
  const ts = Date.parse(string(r.timestamp));
  if (!Number.isFinite(ts)) return { events: [], skipped: 1 };
  const base = { ...context, ts, source: 'fs' as const, agentKind: 'codex' as const };
  const p = object(r.payload);
  let events: RawEvent[] = [];
  let known = true;
  const answer = (text: string) => { if (text) events.push({ ...base, type: 'answer', text: truncate(text, 2000) }); };
  const activity = (item: Record<string, unknown>) => {
    const agentId = string(item.agent_thread_id);
    if (!isSessionId(agentId)) return;
    if (item.kind === 'started' || item.kind === 'interacted') events.push({ ...base, type: 'agent.started', agentId, agentType: 'agent', description: truncate(string(item.agent_path)) || null });
    else if (item.kind === 'completed' || item.kind === 'interrupted') events.push({ ...base, type: 'agent.finished', agentId });
  };
  if (r.type === 'event_msg') {
    switch (p.type) {
      case 'task_started': case 'turn_started': events.push({ ...base, type: 'session.status', status: 'busy', waitingFor: null }); break;
      case 'task_complete': case 'turn_complete':
        answer(string(p.last_agent_message));
        events.push({ ...base, type: 'turn.finished', backgroundTasks: 0 }); break;
      case 'turn_aborted': events.push({ ...base, type: 'session.status', status: 'idle', waitingFor: null }); break;
      case 'user_message': events.push({ ...base, type: 'prompt', text: truncate(string(p.message), 2000) || null }); break;
      case 'agent_message': answer(string(p.message)); break;
      case 'sub_agent_activity': activity(p); break;
      case 'item_completed': {
        const item = object(p.item);
        switch (item.type) {
          case 'UserMessage': events.push({ ...base, type: 'prompt', text: truncate(textContent(item.content), 2000) || null }); break;
          case 'AgentMessage': answer(textContent(item.content)); break;
          case 'SubAgentActivity': activity(item); break;
          case 'CommandExecution': case 'McpToolCall': case 'FunctionCallOutput':
            events.push({ ...base, type: 'tool.finished', toolId: string(item.id) || null, ok: true, agentId: null }); break;
          default: known = false;
        }
        break;
      }
      case 'token_count': case 'agent_reasoning': case 'agent_reasoning_raw_content': break;
      default: known = false;
    }
  } else if (r.type === 'response_item') {
    switch (p.type) {
      case 'function_call': case 'custom_tool_call': {
        const name = string(p.name);
        let input: Record<string, unknown> = {};
        try { input = object(JSON.parse(string(p.arguments))); } catch { /* custom inputs are plain text */ }
        const label = truncate(`${name}${string(input.cmd) || string(input.command) ? `: ${string(input.cmd) || string(input.command)}` : ''}`);
        events.push({ ...base, type: 'tool.started', toolId: string(p.call_id) || null, tool: name, label, agentId: null });
        if (name === 'request_user_input') {
          const q = Array.isArray(input.questions) ? object(input.questions[0]) : {};
          events.push({ ...base, type: 'waiting', reason: { kind: 'question', text: truncate(string(q.question)) || 'Input needed' }, agentId: null });
        }
        break;
      }
      case 'function_call_output': case 'custom_tool_call_output':
        events.push({ ...base, type: 'tool.finished', toolId: string(p.call_id) || null, ok: true, agentId: null }); break;
      // Messages are represented by durable user/agent events, avoiding duplicate context and injected instructions.
      case 'message': case 'reasoning': break;
      default: known = false;
    }
  } else if (r.type !== 'session_meta' && r.type !== 'turn_context' && r.type !== 'compacted') known = false;
  return { events, skipped: known ? 0 : 1, ...(r.type === 'turn_context' && string(p.cwd) ? { cwd: string(p.cwd) } : {}) };
}

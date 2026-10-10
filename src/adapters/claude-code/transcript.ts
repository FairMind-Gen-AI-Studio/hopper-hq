import { toolLabel, truncate, waitingFromTool } from '../../core/tool-label.js';
import type { RawEvent } from '../../core/types.js';

export interface ParsedLine {
  events: RawEvent[];
  ts?: number;
  branch?: string;
  cwd?: string;
}

const WRAPPERS = ['<command-', '<local-command', '<task-notification', '<system-reminder', '<bash-', '<user-prompt-submit-hook'];

function cleanPrompt(text: string): string | null {
  const t = text.trim();
  if (!t || WRAPPERS.some((w) => t.startsWith(w))) return null;
  return truncate(t, 200);
}

/** The text a person typed, from a string or an array of content blocks. Null for wrappers and non-text. */
export function promptText(content: unknown): string | null {
  if (typeof content === 'string') return cleanPrompt(content);
  if (Array.isArray(content)) {
    const texts = content
      .filter((c): c is { type: 'text'; text: unknown } => !!c && typeof c === 'object' && (c as { type?: unknown }).type === 'text')
      .map((c) => (typeof c.text === 'string' ? c.text : ''));
    return texts.length ? cleanPrompt(texts.join('\n')) : null;
  }
  return null;
}

type Block = { type?: unknown; id?: unknown; name?: unknown; input?: unknown; tool_use_id?: unknown; is_error?: unknown };

export function parseTranscriptLine(line: string, sessionId: string, cwdHint?: string): ParsedLine {
  let e: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(line);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { events: [] };
    e = parsed as Record<string, unknown>;
  } catch {
    return { events: [] };
  }

  const out: ParsedLine = { events: [] };
  const ts = typeof e.timestamp === 'string' ? Date.parse(e.timestamp) : NaN;
  if (Number.isFinite(ts)) out.ts = ts;
  if (typeof e.gitBranch === 'string' && e.gitBranch) out.branch = e.gitBranch;
  if (typeof e.cwd === 'string' && e.cwd) out.cwd = e.cwd;
  const base = { sessionId, ts: Number.isFinite(ts) ? ts : 0, source: 'fs' as const };

  if (e.type === 'ai-title') {
    if (typeof e.aiTitle === 'string' && e.aiTitle.trim()) out.events.push({ ...base, type: 'title', title: truncate(e.aiTitle, 120) });
    return out;
  }
  if (e.isSidechain === true) return out;

  const message = e.message && typeof e.message === 'object' ? (e.message as { content?: unknown }) : {};
  const content = message.content;

  if (e.type === 'user') {
    if (e.isMeta === true) return out;
    const blocks: Block[] = Array.isArray(content) ? (content as Block[]) : [];
    const results = blocks.filter((b) => b && b.type === 'tool_result');
    for (const b of results) {
      out.events.push({ ...base, type: 'tool.finished', toolId: typeof b.tool_use_id === 'string' ? b.tool_use_id : null, ok: b.is_error !== true, agentId: null });
    }
    if (results.length === 0) {
      const text = promptText(content);
      if (text) out.events.push({ ...base, type: 'prompt', text });
    }
    return out;
  }

  if (e.type === 'assistant' && Array.isArray(content)) {
    for (const b of content as Block[]) {
      if (!b || b.type !== 'tool_use' || typeof b.name !== 'string') continue;
      const wait = waitingFromTool(b.name, b.input);
      if (wait) out.events.push({ ...base, type: 'waiting', reason: wait });
      else out.events.push({ ...base, type: 'tool.started', toolId: typeof b.id === 'string' ? b.id : null, tool: b.name, label: toolLabel(b.name, b.input, out.cwd ?? cwdHint), agentId: null });
    }
  }
  return out;
}

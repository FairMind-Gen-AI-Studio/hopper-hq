import type { WaitReason } from './types.js';

const MAX_LABEL = 80;

export function truncate(text: string, max = MAX_LABEL): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : oneLine.slice(0, max - 1) + '…';
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function shortPath(p: unknown, cwd?: string): string {
  const path = str(p);
  if (!path) return '';
  if (cwd) {
    const base = cwd.endsWith('/') ? cwd : cwd + '/';
    if (path.startsWith(base)) return path.slice(base.length);
  }
  return path.split('/').filter(Boolean).slice(-2).join('/');
}

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
}

export function toolLabel(tool: string, input: unknown, cwd?: string): string {
  const i = asRecord(input);
  if (tool.startsWith('mcp__')) {
    const [, server = '', ...rest] = tool.split('__');
    return truncate(`${server}: ${rest.join('__') || 'tool'}`);
  }
  switch (tool) {
    case 'Bash':
      return truncate(`Bash: ${str(i.command).split('\n')[0] ?? ''}`);
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
      return truncate(`${tool} ${shortPath(i.file_path, cwd)}`);
    case 'NotebookEdit':
      return truncate(`${tool} ${shortPath(i.notebook_path, cwd)}`);
    case 'Grep':
    case 'Glob':
      return truncate(`${tool} ${str(i.pattern)}`);
    case 'WebFetch': {
      let host = '';
      try {
        host = new URL(str(i.url)).host;
      } catch {
        host = '';
      }
      return truncate(`WebFetch ${host}`);
    }
    case 'WebSearch':
      return truncate(`WebSearch ${str(i.query)}`);
    case 'Agent':
    case 'Task':
      return truncate(`Agent: ${str(i.description) || str(i.subagent_type) || 'subagent'}`);
    case 'Skill':
      return truncate(`Skill ${str(i.skill)}`);
    default:
      return truncate(tool);
  }
}

/** Tools whose call means the session now waits for the user. */
export function waitingFromTool(tool: string, input: unknown): WaitReason | null {
  if (tool === 'AskUserQuestion') {
    const questions = asRecord(input).questions;
    const first = Array.isArray(questions) ? asRecord(questions[0]).question : undefined;
    return { kind: 'question', text: truncate(str(first) || 'Question', 120) };
  }
  if (tool === 'ExitPlanMode') return { kind: 'plan', text: 'Plan approval' };
  return null;
}

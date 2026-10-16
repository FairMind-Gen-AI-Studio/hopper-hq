import { cleanText } from '../scene/text.js';
import type { WaitReason } from './types.js';

const MAX_LABEL = 80;

/** Untrusted text as one clean line of at most `max` code points (see cleanText). */
export function truncate(text: string, max = MAX_LABEL): string {
  return cleanText(text, max);
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

const SMOKE_RUNNER_PKG = /\b(npm|pnpm|yarn|npx|bun)\b/;
const SMOKE_RUNNER_VERB = /\b(run|test)\b/;
const SMOKE_RUNNER_TOOL = /\b(playwright|vitest|jest|cypress)\b/;
const SMOKE_WORD = /\bsmoke\b/;
const SMOKE_FILE = /[\w./-]*smoke[\w./-]*\.(spec|test)\.[tj]sx?/;
const SMOKE_PATH_SEGMENT = /(^|[\s/])smoke([\s/]|$)/;
const SMOKE_NPM_SCRIPT = /\b(test|run)[:\s-]*smoke\b/;

/** A Bash command invokes a test runner: a package-manager runner with run/test, or a test-runner binary. */
function isTestRunnerInvocation(command: string): boolean {
  return (SMOKE_RUNNER_PKG.test(command) && SMOKE_RUNNER_VERB.test(command)) || SMOKE_RUNNER_TOOL.test(command);
}

function isSmokeBash(input: unknown): boolean {
  const command = str(asRecord(input).command).split('\n')[0]?.toLowerCase() ?? '';
  if (!command) return false;
  const runner = isTestRunnerInvocation(command);
  if (runner && SMOKE_WORD.test(command)) return true;
  if (SMOKE_FILE.test(command)) return true;
  if (runner && SMOKE_PATH_SEGMENT.test(command)) return true;
  return SMOKE_NPM_SCRIPT.test(command);
}

/** Whether the tool call a session/sub-agent made runs a smoke test. Pure; no I/O, no Date. */
export function isSmokeTest(tool: string, input: unknown): boolean {
  if (tool === 'Bash') return isSmokeBash(input);
  if (tool === 'Skill') return /smoke/i.test(str(asRecord(input).skill));
  if (tool.startsWith('mcp__playwright__')) {
    return Object.values(asRecord(input)).some((v) => typeof v === 'string' && SMOKE_FILE.test(v.toLowerCase()));
  }
  return false;
}

/** Tools whose call means the session now waits for the user. */
export function waitingFromTool(tool: string, input: unknown): WaitReason | null {
  if (tool === 'AskUserQuestion') {
    const questions = asRecord(input).questions;
    const first = Array.isArray(questions) ? asRecord(questions[0]).question : undefined;
    return { kind: 'question', text: truncate(str(first), 120) || 'Question' };
  }
  if (tool === 'ExitPlanMode') return { kind: 'plan', text: 'Plan approval' };
  return null;
}

import { cleanText, friendlyServer } from '../scene/text.js';
import type { McpCall, WaitReason } from './types.js';

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
    const [, rawServer = '', ...rest] = tool.split('__');
    // Friendly server names ("friendly server names" follow-up): the DOM chip and the side panel's "Running" line
    // both read this same label, so the readable name belongs here, not layered on separately at either call site.
    // Fairmind keeps its own raw spelling, unchanged — `labels.ts`'s own `tagTitle` doc comment already names this
    // as deliberate (the chip shows whatever case the real tool name happened to use for Fairmind), and this
    // function must not quietly start canonicalising it.
    const { server, fairmind } = resolveServer(rawServer);
    const shown = fairmind ? rawServer : friendlyServer(server);
    return truncate(`${shown}: ${rest.join('__') || 'tool'}`);
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

/**
 * The server segment of an MCP tool name (`mcp__<server>__<tool>`), resolved to one canonical human token
 * (hq-mcp-switchboard proposal.md §3 item 2, the shared prerequisite both judge panels flagged):
 * - `plugin_<plugin>_<server>` (a plugin-qualified server) reduces to `<server>` — its last `_`-separated segment,
 *   so a multi-word plugin name ('plugin_fairmind-coding_fairmind') still resolves to the server alone.
 * - `claude_ai_<Name>` (the claude.ai connector naming) reduces to `<Name>`, the whole remainder after the prefix.
 * - every other spelling is the server as-is.
 * Returns the resolved token and whether it is a Fairmind identity (see FAIRMIND_SERVER below) — callers canonicalise
 * a Fairmind identity to the literal `'fairmind'` themselves, so a non-Fairmind resolved token keeps its own case.
 */
export function resolveServer(raw: string): { server: string; fairmind: boolean } {
  let server = raw;
  if (/^plugin_/i.test(server)) {
    const rest = server.slice('plugin_'.length);
    const at = rest.lastIndexOf('_');
    server = at === -1 ? rest : rest.slice(at + 1);
  } else if (/^claude_ai_/i.test(server)) {
    server = server.slice('claude_ai_'.length);
  }
  return { server, fairmind: FAIRMIND_SERVER.test(server) };
}

/**
 * The plugin's own anchored rule for 'this is Fairmind, not merely something that starts the same way' (from
 * `_mcp_config.py`), applied here to the MCP *server* segment — a different axis from `src/scene/fairmind.ts`'s
 * `FAIRMIND_NAMESPACE` (an agent *identity*: which plugin spawned it). Matches 'Fairmind' and 'fairmind-dev' (so
 * both collapse to one identity); rejects 'fairmindish' (the lookahead fails: 'i' follows) and 'not-fairmind-proxy'
 * (not anchored at the start).
 */
const FAIRMIND_SERVER = /^fairmind(?![a-z0-9])/i;

/** A Fairmind MCP tool name's family prefix: the work graph, projects/sessions/RAG, the decision graph, telemetry write-back, or the code graph (proposal.md §2). */
const FAMILY_PREFIX: ReadonlyArray<readonly [RegExp, string]> = [
  [/^Studio_/i, 'Studio'],
  [/^(General_|rag_)/i, 'General'],
  [/^Brain_/i, 'Brain'],
  [/^Insights_/i, 'Insights'],
  [/^Code_/i, 'Code'],
];

/** Write verbs (record/set-status/journal/document/supersede/bind): every other verb defaults to read. */
const WRITE_VERB = /^(record_|set_status|bulk_update_status|process_journal|add_document|supersede_|bind_repository)/i;

/**
 * Classifies an MCP tool call from its name alone (`mcp__<server>__<tool>`) — never its arguments (privacy:
 * proposal.md §3). Pure; no I/O. Returns null for a non-MCP tool. `tool` is the verb segment as spelled in the name
 * (truncated like every other untrusted string this module emits), the same text `toolLabel`'s own 'server: tool'
 * DOM chip already shows — `classifyMcp` keeps its own copy so a caller that only has the classified `McpCall` (the
 * façade's antenna tooltip, build.ts's `activeLinesOf`) can still name the tool, never its arguments.
 */
export function classifyMcp(tool: string): McpCall | null {
  if (!tool.startsWith('mcp__')) return null;
  const [, rawServer = '', ...rest] = tool.split('__');
  const verb = rest.join('__');
  const { server, fairmind } = resolveServer(rawServer);
  let family: string | null = null;
  let remainder = verb;
  for (const [prefix, name] of FAMILY_PREFIX) {
    if (prefix.test(verb)) {
      family = name;
      remainder = verb.replace(prefix, '');
      break;
    }
  }
  return { server: fairmind ? 'fairmind' : server, family: fairmind ? family : null, write: WRITE_VERB.test(remainder), fairmind, tool: truncate(verb || 'tool') };
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

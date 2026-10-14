import { spawn as nodeSpawn } from 'node:child_process';
import { cleanText } from '../scene/text.js';
import type { ProviderName } from './config.js';
import { INSTRUCTION } from './input.js';

export interface SummaryProvider {
  readonly name: ProviderName | 'demo';
  readonly model: string | null;
  /** Resolves with the provider's raw text; rejects with an Error whose message is one short line. */
  summarize(input: string, signal: AbortSignal): Promise<string>;
}
export const DEFAULT_MODELS: Record<ProviderName, string> = { 'claude-cli': 'haiku', 'anthropic-api': 'claude-haiku-5-5' };

/** The first line of text that is not blank once cleaned; '' when there is none. */
function firstLine(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const clean = cleanText(line, 200);
    if (clean) return clean;
  }
  return '';
}

/** A child told to stop that has not stopped this long after is killed. */
const KILL_AFTER_MS = 5000;
/** What ties a child to the Claude Code session that started the daemon, and the API key, which `-p` would bill. */
const SESSION_ENV = new Set(['CLAUDECODE', 'AI_AGENT', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'CLAUDE_PLUGIN_DATA', 'CLAUDE_PLUGIN_ROOT', 'ANTHROPIC_API_KEY']);
/**
 * The CLAUDE_CODE_* variables of that session. The others say how claude signs in, how it reaches the API and where it
 * sends its requests, and stay.
 */
const SESSION_CLAUDE_CODE_ENV = /^CLAUDE_CODE_(ENTRYPOINT|EXECPATH|CHILD_SESSION|BRIDGE_SESSION_ID|SESSION_[A-Z_]+|SESSION_ID|MESSAGING_[A-Z_]+|SSE_PORT)$/;

/**
 * The environment of a summary's claude: the daemon's, without what ties it to the session that started the daemon or
 * bills the API key, and marked as the summarizer's.
 */
function summarizerEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const kept = Object.entries(env).filter(([name]) => !SESSION_ENV.has(name) && !SESSION_CLAUDE_CODE_ENV.test(name));
  return { ...Object.fromEntries(kept), HOPPER_HQ_SUMMARIZER: '1' };
}

/**
 * `claude -p` for one summary. --safe-mode leaves out the user's plugins, hooks, CLAUDE.md, skills and MCP servers;
 * --no-session-persistence keeps no session; no tools.
 */
export function claudeCliArgs(model: string | null): string[] {
  return ['-p', '--safe-mode', '--model', model ?? DEFAULT_MODELS['claude-cli'], '--no-session-persistence', '--tools', '', '--strict-mcp-config', '--system-prompt', INSTRUCTION];
}

/**
 * Summarizes through the claude CLI on the user's account: the notes go on stdin, the first non-blank line of stdout is
 * the answer. The child runs in `cwd` with HOPPER_HQ_SUMMARIZER set, so that the building leaves its session out, and
 * without the variables of the session that started the daemon or the API key. Its output, stdout and stderr together,
 * is capped. A child told to stop that does not is killed.
 */
export function claudeCliProvider(o: {
  command?: string;
  model: string | null;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxOutputBytes?: number;
  spawn?: typeof import('node:child_process').spawn;
}): SummaryProvider {
  const timeoutMs = o.timeoutMs ?? 60_000;
  const maxOutputBytes = o.maxOutputBytes ?? 16_384;
  return {
    name: 'claude-cli',
    model: o.model ?? DEFAULT_MODELS['claude-cli'],
    summarize(input, signal) {
      return new Promise((resolve, reject) => {
        if (signal.aborted) return reject(new Error('claude timed out'));
        const child = (o.spawn ?? nodeSpawn)(o.command ?? 'claude', claudeCliArgs(o.model), {
          cwd: o.cwd,
          env: summarizerEnv(o.env ?? process.env),
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let size = 0;
        let settled = false;
        const settle = (fn: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
          fn();
        };
        const stop = (message: string) => {
          child.kill('SIGTERM');
          const kill = setTimeout(() => child.kill('SIGKILL'), KILL_AFTER_MS);
          kill.unref();
          child.once('close', () => clearTimeout(kill));
          settle(() => reject(new Error(message)));
        };
        const timer = setTimeout(() => stop('claude timed out'), timeoutMs);
        const onAbort = () => stop('claude timed out');
        signal.addEventListener('abort', onAbort, { once: true });
        const collect = (into: Buffer[]) => (chunk: Buffer) => {
          if (settled) return;
          size += chunk.length;
          if (size > maxOutputBytes) return stop('claude wrote too much output');
          into.push(chunk);
        };
        child.stdout.on('data', collect(stdout));
        child.stderr.on('data', collect(stderr));
        child.on('error', (err: NodeJS.ErrnoException) =>
          settle(() => reject(new Error(err.code === 'ENOENT' ? 'claude was not found on PATH' : `claude could not start: ${cleanText(err.message, 200)}`))),
        );
        child.on('close', (code, sig) =>
          settle(() => {
            if (code === 0) return resolve(firstLine(Buffer.concat(stdout).toString('utf8')));
            if (code === null) return reject(new Error(`claude was stopped by ${sig ?? 'a signal'}`));
            const why = firstLine(Buffer.concat(stderr).toString('utf8'));
            reject(new Error(`claude exited with code ${code}${why ? `: ${why}` : ''}`));
          }),
        );
        // A child that exits before reading its input closes the pipe: what it would have read no longer matters.
        child.stdin.on('error', () => {});
        child.stdin.end(input);
      });
    },
  };
}

const API_URL = 'https://api.anthropic.com/v1/messages';

/** Summarizes through the Anthropic Messages API, with the key from the daemon's environment. */
export function anthropicApiProvider(o: { apiKey: string | undefined; model: string | null; fetch?: typeof fetch; timeoutMs?: number }): SummaryProvider {
  const model = o.model ?? DEFAULT_MODELS['anthropic-api'];
  return {
    name: 'anthropic-api',
    model,
    async summarize(input, signal) {
      if (!o.apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
      const both = AbortSignal.any([signal, AbortSignal.timeout(o.timeoutMs ?? 30_000)]);
      let status: number;
      let ok: boolean;
      let body: string;
      try {
        const res = await (o.fetch ?? globalThis.fetch)(API_URL, {
          method: 'POST',
          headers: { 'x-api-key': o.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
          body: JSON.stringify({ model, max_tokens: 100, system: INSTRUCTION, messages: [{ role: 'user', content: input }] }),
          signal: both,
        });
        status = res.status;
        ok = res.ok;
        body = await res.text();
      } catch (err) {
        if (both.aborted) throw new Error('Anthropic API timed out');
        throw new Error(`Anthropic API could not be reached: ${cleanText(err instanceof Error ? err.message : err, 200)}`);
      }
      let data: unknown = null;
      try {
        data = JSON.parse(body);
      } catch {
        data = null;
      }
      const record = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {});
      if (!ok) {
        const message = cleanText(record(record(data).error).message, 200);
        throw new Error(`Anthropic API answered ${status}${message ? `: ${message}` : ''}`);
      }
      const content = record(data).content;
      const block = Array.isArray(content) ? content.map(record).find((b) => b.type === 'text' && typeof b.text === 'string') : undefined;
      return (block?.text as string | undefined) ?? '';
    },
  };
}

/** Fixed lines for the demo: no network, no process. */
export function demoProvider(lineFor: (input: string) => string): SummaryProvider {
  return { name: 'demo', model: null, summarize: async (input) => lineFor(input) };
}

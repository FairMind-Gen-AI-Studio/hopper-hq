import { describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INSTRUCTION } from '../../src/summary/input.js';
import { anthropicApiProvider, claudeCliArgs, claudeCliProvider, DEFAULT_MODELS, demoProvider } from '../../src/summary/providers.js';

/**
 * A stand-in for the claude CLI, run directly by node: never the real one. It records what it got next to itself and
 * behaves as STANDIN_MODE says.
 */
const STANDIN = `#!${process.execPath}
'use strict';
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const mode = process.env.STANDIN_MODE || 'ok';
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
  const env = { HOPPER_HQ_SUMMARIZER: process.env.HOPPER_HQ_SUMMARIZER, STANDIN_MARKER: process.env.STANDIN_MARKER };
  writeFileSync(join(__dirname, 'call.json'), JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env, input }));
  writeFileSync(join(__dirname, 'names.json'), JSON.stringify(Object.keys(process.env).sort()));
  if (mode === 'ok') process.stdout.write('\\n   \\nTests pass;   the PR is open.\\nA second line\\n');
  if (mode === 'fail') {
    process.stderr.write('\\n  Error:   rate   limited\\nmore\\n');
    process.exitCode = 3;
  }
  if (mode === 'quiet') process.exitCode = 2;
  if (mode === 'long') {
    process.stderr.write('x'.repeat(300) + '\\n');
    process.exitCode = 1;
  }
  if (mode === 'killed') process.kill(process.pid, 'SIGKILL');
});
if (mode === 'sleep') setTimeout(() => {}, 30000);
if (mode === 'flood') {
  process.stdout.write('y'.repeat(20000));
  setTimeout(() => {}, 30000);
}
`;

async function standIn() {
  const dir = await mkdtemp(join(tmpdir(), 'shq-standin-'));
  const command = join(dir, 'claude-standin.cjs');
  await writeFile(command, STANDIN, { mode: 0o755 });
  const call = async () => JSON.parse(await readFile(join(dir, 'call.json'), 'utf8'));
  return { dir, command, call };
}

/** The real spawn, keeping each child so that a test can wait for its end. */
function watched() {
  const ends: Promise<NodeJS.Signals | null>[] = [];
  const fn = ((command: string, args: string[], options: object) => {
    const child: ChildProcess = spawn(command, args, options);
    ends.push(new Promise((resolve) => child.once('close', (_code, signal) => resolve(signal))));
    return child;
  }) as unknown as typeof spawn;
  return { fn, ends };
}

const live = () => new AbortController().signal;

describe('claudeCliArgs', () => {
  it('runs one prompt in safe mode, with no tools, no session and no MCP servers', () => {
    expect(claudeCliArgs(null)).toEqual(['-p', '--safe-mode', '--model', 'haiku', '--no-session-persistence', '--tools', '', '--strict-mcp-config', '--system-prompt', INSTRUCTION]);
    expect(claudeCliArgs('sonnet')[3]).toBe('sonnet');
    expect(DEFAULT_MODELS).toEqual({ 'claude-cli': 'haiku', 'anthropic-api': 'claude-haiku-5-5' });
  });
});

describe('claudeCliProvider', () => {
  it('sends the notes on stdin from its own directory, marked as the summarizer, and answers with the first line', async () => {
    const s = await standIn();
    const cwd = await mkdtemp(join(tmpdir(), 'shq-summarizer-'));
    const p = claudeCliProvider({ command: s.command, model: null, cwd, env: { STANDIN_MARKER: 'm1' } });
    expect([p.name, p.model]).toEqual(['claude-cli', 'haiku']);
    expect(await p.summarize('Title: Fix the login form\nState: done', live())).toBe('Tests pass; the PR is open.');
    expect(await s.call()).toEqual({
      argv: claudeCliArgs(null),
      cwd: await realpath(cwd),
      env: { HOPPER_HQ_SUMMARIZER: '1', STANDIN_MARKER: 'm1' },
      input: 'Title: Fix the login form\nState: done',
    });
    expect((await s.call()).argv[6]).toBe('');
  });

  it('runs claude apart from the session that started the daemon and off the API key, keeping how it signs in and connects, and the rest of the environment', async () => {
    const s = await standIn();
    // A made-up environment, like that of a daemon started from inside a Claude Code session; never this process's.
    const env = {
      HOME: '/home/dev', PATH: '/usr/bin:/bin', CLAUDE_CONFIG_DIR: '/home/dev/.claude-work', STANDIN_MARKER: 'm2',
      CLAUDECODE: '1', AI_AGENT: 'claude-code', CLAUDE_PID: '4242', CLAUDE_EFFORT: 'high',
      CLAUDE_PLUGIN_DATA: '/home/dev/.claude/plugins/data/x', CLAUDE_PLUGIN_ROOT: '/home/dev/.claude/plugins/x',
      ANTHROPIC_API_KEY: 'sk-ant-made-up-0000',
      CLAUDE_CODE_SESSION_ID: '11111111-1111-4111-8111-111111111111', CLAUDE_CODE_SESSION_ATTENDED: '1', CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_CODE_EXECPATH: '/home/dev/.local/bin/claude', CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_CODE_SSE_PORT: '41234',
      CLAUDE_CODE_BRIDGE_SESSION_ID: '22222222-2222-4222-8222-222222222222',
      CLAUDE_CODE_MESSAGING_SOCKET: '/home/dev/cc.sock', CLAUDE_CODE_MESSAGING_TOKEN: 'made-up-0000',
      // How claude signs in, reaches the API and picks its provider: none of it belongs to the session.
      CLAUDE_CODE_OAUTH_TOKEN: 'made-up-oauth-0000', CLAUDE_CODE_OAUTH_REFRESH_TOKEN: 'made-up-refresh-0000',
      CLAUDE_CODE_CLIENT_CERT: '/home/dev/certs/client.pem', CLAUDE_CODE_CLIENT_KEY: '/home/dev/certs/client.key', CLAUDE_CODE_CERT_STORE: 'system',
      CLAUDE_CODE_API_KEY_HELPER_TTL_MS: '60000', CLAUDE_CODE_PROXY_RESOLVES_HOSTS: '1',
      CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_USE_VERTEX: '0', CLAUDE_CODE_USE_FOUNDRY: '1',
    };
    await claudeCliProvider({ command: s.command, model: null, cwd: s.dir, env }).summarize('notes', live());
    const names: string[] = JSON.parse(await readFile(join(s.dir, 'names.json'), 'utf8'));
    expect(names.filter((n) => n in env || n === 'HOPPER_HQ_SUMMARIZER')).toEqual([
      'CLAUDE_CODE_API_KEY_HELPER_TTL_MS', 'CLAUDE_CODE_CERT_STORE', 'CLAUDE_CODE_CLIENT_CERT', 'CLAUDE_CODE_CLIENT_KEY',
      'CLAUDE_CODE_OAUTH_REFRESH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_PROXY_RESOLVES_HOSTS',
      'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CONFIG_DIR', 'HOME', 'HOPPER_HQ_SUMMARIZER', 'PATH', 'STANDIN_MARKER',
    ]);
    expect((await s.call()).env).toEqual({ HOPPER_HQ_SUMMARIZER: '1', STANDIN_MARKER: 'm2' });
  });

  it('kills a claude that does not stop when told to, five seconds after', async () => {
    vi.useFakeTimers();
    try {
      const run = (stops: boolean) => {
        const signals: string[] = [];
        const child = Object.assign(new EventEmitter(), {
          stdout: new EventEmitter(),
          stderr: new EventEmitter(),
          stdin: Object.assign(new EventEmitter(), { end: () => {} }),
          kill: (signal: string) => {
            signals.push(signal);
            // A real child closes later, never within kill().
            if (stops) void Promise.resolve().then(() => child.emit('close', null, signal));
            return true;
          },
        });
        const fake = (() => child) as unknown as typeof spawn;
        const done = claudeCliProvider({ command: 'claude', model: null, cwd: '/home/dev', env: {}, timeoutMs: 100, spawn: fake }).summarize('notes', live());
        return { signals, done: done.catch((err: Error) => err.message) };
      };
      const stuck = run(false);
      const polite = run(true);
      await vi.advanceTimersByTimeAsync(100);
      expect([await stuck.done, await polite.done]).toEqual(['claude timed out', 'claude timed out']);
      await vi.advanceTimersByTimeAsync(4999);
      expect([stuck.signals, polite.signals]).toEqual([['SIGTERM'], ['SIGTERM']]);
      await vi.advanceTimersByTimeAsync(1);
      expect([stuck.signals, polite.signals]).toEqual([['SIGTERM', 'SIGKILL'], ['SIGTERM']]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('passes the model it was given', async () => {
    const s = await standIn();
    const p = claudeCliProvider({ command: s.command, model: 'sonnet', cwd: s.dir, env: {} });
    expect(p.model).toBe('sonnet');
    await p.summarize('notes', live());
    expect((await s.call()).argv.slice(2, 4)).toEqual(['--model', 'sonnet']);
  });

  it('says how it exited, with the first line of its errors', async () => {
    const s = await standIn();
    const run = (mode: string) => claudeCliProvider({ command: s.command, model: null, cwd: s.dir, env: { STANDIN_MODE: mode } }).summarize('notes', live());
    await expect(run('fail')).rejects.toThrow(new Error('claude exited with code 3: Error: rate limited'));
    await expect(run('quiet')).rejects.toThrow(new Error('claude exited with code 2'));
    await expect(run('long')).rejects.toThrow(new Error(`claude exited with code 1: ${'x'.repeat(199)}\u2026`));
    await expect(run('killed')).rejects.toThrow(new Error('claude was stopped by SIGKILL'));
    expect(await run('empty')).toBe('');
  });

  it('says when claude is not there', async () => {
    const s = await standIn();
    const p = claudeCliProvider({ command: join(s.dir, 'missing-claude'), model: null, cwd: s.dir, env: {} });
    await expect(p.summarize('notes', live())).rejects.toThrow(new Error('claude was not found on PATH'));
  });

  it('stops a claude that takes too long, or that the caller gives up on', async () => {
    const s = await standIn();
    const w = watched();
    const sleepy = claudeCliProvider({ command: s.command, model: null, cwd: s.dir, env: { STANDIN_MODE: 'sleep' }, timeoutMs: 200, spawn: w.fn });
    await expect(sleepy.summarize('notes', live())).rejects.toThrow(new Error('claude timed out'));
    const ac = new AbortController();
    const waiting = claudeCliProvider({ command: s.command, model: null, cwd: s.dir, env: { STANDIN_MODE: 'sleep' }, spawn: w.fn }).summarize('notes', ac.signal);
    ac.abort();
    await expect(waiting).rejects.toThrow(new Error('claude timed out'));
    expect(await Promise.all(w.ends)).toEqual(['SIGTERM', 'SIGTERM']);
    await expect(sleepy.summarize('notes', ac.signal)).rejects.toThrow(new Error('claude timed out'));
    expect(w.ends).toHaveLength(2);
  });

  it('stops a claude that writes too much', async () => {
    const s = await standIn();
    const w = watched();
    const p = claudeCliProvider({ command: s.command, model: null, cwd: s.dir, env: { STANDIN_MODE: 'flood' }, spawn: w.fn });
    await expect(p.summarize('notes', live())).rejects.toThrow(new Error('claude wrote too much output'));
    expect(await Promise.all(w.ends)).toEqual(['SIGTERM']);
  });
});

/** A fetch that records each request and answers with `status` and `body`. */
function stubFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init! });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fn, calls };
}

/** A fetch that never answers, until its request is aborted. */
const hangingFetch = (async (_url: string | URL | Request, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason)))) as typeof fetch;

describe('anthropicApiProvider', () => {
  it('posts the notes to the Messages API and answers with the first text block', async () => {
    const f = stubFetch(200, { content: [{ type: 'thinking', thinking: '...' }, { type: 'text', text: 'Tests pass; the PR is open.' }, { type: 'text', text: 'more' }] });
    const p = anthropicApiProvider({ apiKey: 'sk-test-0000', model: null, fetch: f.fn });
    expect([p.name, p.model]).toEqual(['anthropic-api', 'claude-haiku-5-5']);
    expect(await p.summarize('Title: Fix the login form', live())).toBe('Tests pass; the PR is open.');
    expect(f.calls).toHaveLength(1);
    const { url, init } = f.calls[0]!;
    expect([url, init.method]).toEqual(['https://api.anthropic.com/v1/messages', 'POST']);
    expect(init.headers).toEqual({ 'x-api-key': 'sk-test-0000', 'anthropic-version': '2023-06-01', 'content-type': 'application/json' });
    expect(JSON.parse(init.body as string)).toEqual({
      model: 'claude-haiku-5-5',
      max_tokens: 100,
      system: INSTRUCTION,
      messages: [{ role: 'user', content: 'Title: Fix the login form' }],
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const sonnet = stubFetch(200, { content: [] });
    expect(await anthropicApiProvider({ apiKey: 'sk-test-0000', model: 'claude-x', fetch: sonnet.fn }).summarize('notes', live())).toBe('');
    expect(JSON.parse(sonnet.calls[0]!.init.body as string).model).toBe('claude-x');
  });

  it('makes no request without a key', async () => {
    const f = stubFetch(200, { content: [] });
    await expect(anthropicApiProvider({ apiKey: undefined, model: null, fetch: f.fn }).summarize('notes', live())).rejects.toThrow(new Error('ANTHROPIC_API_KEY is not set'));
    await expect(anthropicApiProvider({ apiKey: '', model: null, fetch: f.fn }).summarize('notes', live())).rejects.toThrow(new Error('ANTHROPIC_API_KEY is not set'));
    expect(f.calls).toEqual([]);
  });

  it('says what the API answered when it fails', async () => {
    const run = (status: number, body: unknown) => anthropicApiProvider({ apiKey: 'sk-test-0000', model: null, fetch: stubFetch(status, body).fn }).summarize('notes', live());
    await expect(run(529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded\n  try later' } })).rejects.toThrow(new Error('Anthropic API answered 529: Overloaded try later'));
    await expect(run(401, '<html>nope</html>')).rejects.toThrow(new Error('Anthropic API answered 401'));
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    await expect(anthropicApiProvider({ apiKey: 'sk-test-0000', model: null, fetch: down }).summarize('notes', live())).rejects.toThrow(new Error('Anthropic API could not be reached: fetch failed'));
  });

  it('gives up after its timeout, or when the caller does', async () => {
    await expect(anthropicApiProvider({ apiKey: 'sk-test-0000', model: null, fetch: hangingFetch, timeoutMs: 20 }).summarize('notes', live())).rejects.toThrow(new Error('Anthropic API timed out'));
    const ac = new AbortController();
    const waiting = anthropicApiProvider({ apiKey: 'sk-test-0000', model: null, fetch: hangingFetch }).summarize('notes', ac.signal);
    ac.abort();
    await expect(waiting).rejects.toThrow(new Error('Anthropic API timed out'));
  });
});

describe('demoProvider', () => {
  it('answers with the line it is given for the notes', async () => {
    const p = demoProvider((input) => `Line for ${input.split('\n')[0]}`);
    expect([p.name, p.model]).toEqual(['demo', null]);
    expect(await p.summarize('Title: Fix the login form\nState: done', live())).toBe('Line for Title: Fix the login form');
  });
});

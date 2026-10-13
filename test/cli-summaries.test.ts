import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HELP, main, type Io } from '../src/cli.js';
import { writeDaemonFile } from '../src/daemon-file.js';
import { startDaemon } from '../src/daemon.js';
import { configPath, DEFAULT_SUMMARY_CONFIG, readSummaryConfig } from '../src/summary/config.js';
import { close, listen } from './helpers/http.js';

const tmp = (prefix: string) => mkdtemp(join(tmpdir(), prefix));
const MIN = 60_000;

/** Runs `scranton-hq summaries ARGS` with the given environment, never this process's. */
async function summaries(args: string[], env: NodeJS.ProcessEnv = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (l) => out.push(l), err: (l) => err.push(l), env };
  const code = await main(['summaries', ...args], io);
  return { code, out, err };
}

const ON_CLI = "Summaries are on (claude-cli, model default). Each finished turn sends the session's title, last request, state, recent actions and last reply to the claude CLI on your account.";

/** A daemon file pointing at a server that answers /api/summaries as `answer` says. */
async function fakeDaemon(dataDir: string, status: number, body: unknown) {
  const token = 'cd'.repeat(24);
  const server = createServer((req, res) => {
    const ok = req.headers.authorization === `Bearer ${token}` && req.url === '/api/summaries';
    res.writeHead(ok ? status : 401, { 'content-type': 'application/json' }).end(JSON.stringify(ok ? body : { error: 'no' }));
  });
  const port = await listen(server);
  await writeDaemonFile(dataDir, { port, token, pid: 4242, startedAt: Date.now() });
  return server;
}

describe('scranton-hq summaries', () => {
  it('turns summaries on and off in a private config file, and says what goes where', async () => {
    const dir = await tmp('shq-sum-');
    expect(await summaries(['on', '--data-dir', dir])).toEqual({ code: 0, out: [ON_CLI], err: [] });
    expect(JSON.parse(await readFile(configPath(dir), 'utf8'))).toEqual({ summaries: { enabled: true, provider: 'claude-cli', model: null } });
    expect((await stat(configPath(dir))).mode & 0o777).toBe(0o600);
    expect(await summaries(['off', '--data-dir', dir])).toEqual({ code: 0, out: ['Summaries are off.'], err: [] });
    expect(await summaries(['status', '--data-dir', dir])).toEqual({ code: 0, out: ['Summaries are off (claude-cli, model default).', 'The daemon is not running.'], err: [] });
    expect((await summaries(['--data-dir', dir])).out).toEqual(['Summaries are off (claude-cli, model default).', 'The daemon is not running.']);
  });

  it('picks a provider and a model, and reminds that the daemon reads the API key from its own environment', async () => {
    const dir = await tmp('shq-sum-');
    const api = "Each finished turn sends the session's title, last request, state, recent actions and last reply to the Anthropic API.";
    expect((await summaries(['on', '--provider', 'anthropic-api', '--data-dir', dir])).out).toEqual([
      `Summaries are on (anthropic-api, model default). ${api}`,
      'The daemon reads ANTHROPIC_API_KEY from its own environment.',
    ]);
    expect((await summaries(['on', '--model', 'claude-x', '--data-dir', dir], { ANTHROPIC_API_KEY: 'sk-test-0000' })).out).toEqual([`Summaries are on (anthropic-api, model claude-x). ${api}`]);
    expect((await summaries(['off', '--provider', 'claude-cli', '--data-dir', dir])).out).toEqual(['Summaries are off.']);
    expect(await readSummaryConfig(dir)).toEqual({ enabled: false, provider: 'claude-cli', model: null });
    expect((await summaries(['on', '--model', 'sonnet', '--data-dir', dir])).out[0]).toMatch(/^Summaries are on \(claude-cli, model sonnet\)\. /);
  });

  it('refuses a bad provider or model with exit 1, and anything else it does not know as a usage error', async () => {
    const dir = await tmp('shq-sum-');
    expect(await summaries(['on', '--provider', 'gpt', '--data-dir', dir])).toEqual({ code: 1, out: [], err: ['Unknown provider: gpt. Use claude-cli or anthropic-api.'] });
    expect(await summaries(['on', '--model', 'haiku; rm', '--data-dir', dir])).toEqual({
      code: 1,
      out: [],
      err: ["Invalid model: haiku; rm. A model is 1 to 64 letters, digits, '.', '_', ':' or '-', and starts with a letter or digit."],
    });
    expect((await summaries(['on', '--model=--debug', '--data-dir', dir])).err).toEqual([
      "Invalid model: --debug. A model is 1 to 64 letters, digits, '.', '_', ':' or '-', and starts with a letter or digit.",
    ]);
    expect(await readSummaryConfig(dir)).toEqual(DEFAULT_SUMMARY_CONFIG);
    for (const args of [['maybe'], ['on', 'off'], ['status', '--model', 'haiku'], ['on', '--bogus']]) {
      const r = await summaries([...args, '--data-dir', dir]);
      expect([args, r.code, r.out]).toEqual([args, 2, []]);
      expect(r.err.at(-1)).toBe(HELP);
    }
    await writeFile(configPath(dir), '{ broken');
    expect(await summaries(['on', '--data-dir', dir])).toEqual({ code: 1, out: [], err: [`${configPath(dir)} does not hold a JSON object. Fix or remove it.`] });
    expect(await readFile(configPath(dir), 'utf8')).toBe('{ broken');
  });

  it("reports the running daemon's summaries, which follow the config file", async () => {
    const dir = await tmp('shq-sum-');
    const provider = () => ({ name: 'claude-cli' as const, model: 'haiku', summarize: async () => 'unused' });
    const d = await startDaemon({ port: 0, dataDir: dir, claudeDir: await tmp('shq-claude-'), watchFiles: false, log: () => {}, summarizer: { provider } });
    try {
      expect((await summaries(['status', '--data-dir', dir])).out).toEqual(['Summaries are off (claude-cli, model default).', 'The daemon does not summarize.', 'Last summary: none yet.']);
      await summaries(['on', '--data-dir', dir]);
      expect((await summaries(['status', '--data-dir', dir])).out).toEqual([
        'Summaries are on (claude-cli, model default).',
        'The daemon summarizes with claude-cli, model haiku.',
        'Last summary: none yet.',
      ]);
    } finally {
      await d.stop();
    }
  });

  it("words the daemon's last summary, last error, pause and queue, as text only", async () => {
    const dir = await tmp('shq-sum-');
    const now = Date.now();
    const server = await fakeDaemon(dir, 200, {
      enabled: true,
      provider: 'anthropic-api',
      model: 'claude-haiku-5-5',
      lastOkAt: now - 3 * MIN,
      lastError: { at: now - 90_000, message: 'Anthropic API timed out\u001b[31m\nagain' },
      pausedUntil: now + 14.5 * MIN,
      queued: 2,
    });
    try {
      expect(await summaries(['status', '--data-dir', dir])).toEqual({
        code: 0,
        out: [
          'Summaries are off (claude-cli, model default).',
          'The daemon summarizes with anthropic-api, model claude-haiku-5-5.',
          'Last summary: 3m ago.',
          'Last error 1m ago: Anthropic API timed out[31m again',
          'Paused for 14m after 3 failures in a row.',
          'Sessions waiting for a summary: 2.',
        ],
        err: [],
      });
    } finally {
      await close(server);
    }
  });

  it('says when the daemon is older than the command', async () => {
    const dir = await tmp('shq-sum-');
    const server = await fakeDaemon(dir, 404, { error: 'Not found' });
    try {
      expect(await summaries(['status', '--data-dir', dir])).toEqual({
        code: 1,
        out: ['Summaries are off (claude-cli, model default).'],
        err: ['The running daemon is older than the summaries command. Restart it to summarize.'],
      });
    } finally {
      await close(server);
    }
  });

  it('is listed in the help', () => {
    expect(HELP).toContain('scranton-hq summaries [status|on|off] [--provider claude-cli|anthropic-api] [--model ID] [--data-dir DIR]');
  });
});

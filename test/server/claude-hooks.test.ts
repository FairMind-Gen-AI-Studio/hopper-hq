import { afterEach, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Collector } from '../../src/collector.js';
import { createApiServer } from '../../src/server/http.js';
import { forwardClaudeHook } from '../../src/adapters/claude-code/forward.js';
import { bearer, call, close, listen } from '../helpers/http.js';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

it('reports a Claude print run without session files, resumes it, and excludes summary runs', async () => {
  const c = new Collector({ resolveWorkspace: async cwd => ({ cwd, repoRoot: cwd, repoName: 'api', branch: 'main', worktree: false }) });
  const server = createApiServer({ collector: c, token: 'test-token' });
  const port = await listen(server);
  const dir = await mkdtemp(join(tmpdir(), 'hopper claude hooks ')); dirs.push(dir);
  await writeFile(join(dir, 'daemon.json'), JSON.stringify({ port, token: 'test-token', pid: process.pid, startedAt: Date.now() }));
  const send = async (fields: object, env: NodeJS.ProcessEnv = {}) => {
    await forwardClaudeHook(Readable.from([JSON.stringify({ session_id: 'print-one', cwd: dir, ...fields })]), { HOPPER_HQ_HOME: dir, ...env });
    await c.idle();
  };
  try {
    await send({ hook_event_name: 'SessionStart', source: 'startup' });
    await send({ hook_event_name: 'UserPromptSubmit', prompt: 'Inspect the repository' });
    expect(c.session('print-one')).toMatchObject({ state: 'working', lastPrompt: 'Inspect the repository' });
    await send({ hook_event_name: 'Stop', last_assistant_message: 'Inspection complete' });
    expect(c.session('print-one')).toMatchObject({ state: 'done', lastAnswer: 'Inspection complete' });
    await send({ hook_event_name: 'SessionEnd', reason: 'other' });
    expect(c.session('print-one')?.state).toBe('ended');
    await send({ hook_event_name: 'SessionStart', source: 'resume' });
    await send({ hook_event_name: 'UserPromptSubmit', prompt: 'Continue' });
    expect(c.session('print-one')).toMatchObject({ state: 'working', lastPrompt: 'Continue' });
    const seq = c.session('print-one')!.lastSeq;
    await send({ hook_event_name: 'Stop' }, { HOPPER_HQ_SUMMARIZER: '1' });
    await forwardClaudeHook(Readable.from(['null']), { HOPPER_HQ_HOME: dir });
    await forwardClaudeHook(Readable.from(['x'.repeat(900_001)]), { HOPPER_HQ_HOME: dir });
    await forwardClaudeHook(Readable.from(['{}']), { HOPPER_HQ_HOME: join(dir, 'absent') });
    expect(c.session('print-one')!.lastSeq).toBe(seq);
  } finally { await close(server); await c.close(); }
});

it('keeps command reports authoritative when a delayed mod batch has shortened payloads', async () => {
  const c = new Collector({ resolveWorkspace: async cwd => ({ cwd, repoRoot: cwd, repoName: 'api', branch: 'main', worktree: false }) });
  const server = createApiServer({ collector: c, token: 'test-token' });
  const port = await listen(server);
  const send = async (transport: string, event: string, ts: number, extra = {}) => {
    await call(port, { method: 'POST', path: '/api/hooks', headers: bearer('test-token'), body: JSON.stringify({ session_id: 'both', cwd: '/work/api', _hopper_transport: transport, _hopper_ts: ts, hook_event_name: event, prompt: 'Again', ...extra }) });
    await c.idle();
  };
  try {
    const prompt = 'a'.repeat(100) + '\n'.repeat(300) + 'b';
    await send('command', 'UserPromptSubmit', 100, { prompt });
    await send('command', 'Stop', 200);
    await send('mod', 'UserPromptSubmit', 300, { prompt: prompt.slice(0, 400) });
    expect(c.session('both')?.state).toBe('done');
    expect(c.session('both')?.lastPrompt).toBe('a'.repeat(100) + ' b');
    await send('mod', 'Stop', 400);
    await send('command', 'UserPromptSubmit', 500);
    expect(c.session('both')).toMatchObject({ state: 'working', lastPromptAt: 500 });
    await send('mod', 'UserPromptSubmit', 600);
    expect(c.session('both')?.lastPromptAt).toBe(500);
    await send('command', 'UserPromptSubmit', 700);
    expect(c.session('both')?.lastPromptAt).toBe(700);
    await send('mod', 'UserPromptSubmit', 800, { session_id: 'mod-only' });
    await send('mod', 'UserPromptSubmit', 900, { session_id: 'mod-only' });
    expect(c.session('mod-only')?.lastPromptAt).toBe(900);
  } finally { await close(server); await c.close(); }
});

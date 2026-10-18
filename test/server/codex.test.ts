import { afterEach, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Collector } from '../../src/collector.js';
import { createApiServer } from '../../src/server/http.js';
import { forwardCodexHook } from '../../src/adapters/codex/forward.js';
import { bearer, call, close, listen } from '../helpers/http.js';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
it('requires bearer auth, enforces the hook body limit, and forwards optional hooks without changing Codex files', async () => {
  const c = new Collector({ resolveWorkspace: async cwd => ({ cwd, repoRoot: cwd, repoName: 'api', branch: 'main', worktree: false }) });
  const server = createApiServer({ collector: c, token: 'test-token', maxBodyBytes: 4096 });
  const port = await listen(server);
  const dataDir = await mkdtemp(join(tmpdir(), 'hopper-codex-hook-')); dirs.push(dataDir);
  await writeFile(join(dataDir, 'daemon.json'), JSON.stringify({ port, token: 'test-token', pid: process.pid, startedAt: Date.now() }));
  const body = JSON.stringify({ session_id: 'one', cwd: '/work/api', hook_event_name: 'PermissionRequest', tool_name: 'Bash' });
  try {
    expect((await call(port, { method: 'POST', path: '/api/hooks/codex', body })).status).toBe(401);
    expect((await call(port, { method: 'POST', path: '/api/hooks/codex', headers: bearer('test-token'), body: 'x'.repeat(4097) })).status).toBe(413);
    expect((await call(port, { method: 'POST', path: '/api/hooks/codex', headers: bearer('test-token'), body: '{' })).status).toBe(400);
    await forwardCodexHook(Readable.from([body]), { HOPPER_HQ_HOME: dataDir });
    await c.idle();
    expect(c.session('codex-one')).toMatchObject({ agentKind: 'codex', state: 'needs_you' });
    expect(c.scene().attention.needsYou[0]?.sessionId).toBe('codex-one');
    await forwardCodexHook(Readable.from(['null']), { HOPPER_HQ_HOME: dataDir });
    await forwardCodexHook(Readable.from([body]), { HOPPER_HQ_HOME: join(dataDir, 'absent') });
  } finally { await close(server); await c.close(); }
});

it('discovers a Codex rollout through the running daemon and stops its watcher', async () => {
  const { startDaemon } = await import('../../src/daemon.js');
  const { readFile, appendFile } = await import('node:fs/promises');
  const { mkdir } = await import('node:fs/promises');
  const dir = await mkdtemp(join(tmpdir(), 'hopper-codex-daemon-')); dirs.push(dir);
  const codexDir = join(dir, 'codex');
  await mkdir(join(codexDir, 'sessions'), { recursive: true });
  const fixture = await readFile(new URL('../fixtures/codex/rollout.jsonl', import.meta.url), 'utf8');
  const path = join(codexDir, 'sessions/rollout-live.jsonl');
  const startedAt = Date.now() - 60_000;
  const liveFixture = fixture.trim().split('\n').map((line, index) => {
    const record = JSON.parse(line);
    record.timestamp = new Date(startedAt + index * 1000).toISOString();
    return JSON.stringify(record);
  }).join('\n') + '\n';
  await writeFile(path, liveFixture);
  const daemon = await startDaemon({ dataDir: join(dir, 'data'), claudeDir: join(dir, 'claude'), codexDir, port: 0, log: () => {} });
  try {
    await expect.poll(() => daemon.collector.session('codex-11111111-1111-4111-8111-111111111111')?.state).toBe('done');
    expect(daemon.collector.snapshot().floors[0]?.sessions[0]?.agentKind).toBe('codex');
  } finally { await daemon.stop(); }
  await appendFile(path, '{"timestamp":"2026-10-17T20:00:00Z","type":"event_msg","payload":{"type":"task_started"}}\n');
  expect(daemon.collector.session('codex-11111111-1111-4111-8111-111111111111')?.state).toBe('done');
});

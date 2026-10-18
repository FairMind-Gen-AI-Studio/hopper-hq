import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import test from 'node:test';

const bin = fileURLToPath(new URL('../dist/bin.js', import.meta.url));

test('native CLI discovers processes and observes Claude/Codex runs across daemon restarts', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hopper native '));
  const data = join(dir, 'data');
  const claude = join(dir, 'claude');
  const codex = join(dir, 'codex');
  await mkdir(join(claude, 'sessions'), { recursive: true });
  const env = { ...process.env, HOPPER_HQ_HOME: data };
  delete env.HOPPER_HQ_SUMMARIZER;
  const cli = (args, input = '') => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let out = '', err = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(out) : reject(new Error(`${args.join(' ')}: ${code}: ${err}`)));
    child.stdin.end(input);
  });
  const start = () => cli(['up', '--port', '0', '--no-open', '--claude-dir', claude, '--codex-dir', codex]);
  const sessions = async () => {
    const info = JSON.parse(await readFile(join(data, 'daemon.json'), 'utf8'));
    const response = await fetch(`http://127.0.0.1:${info.port}/api/building`, { headers: { authorization: `Bearer ${info.token}` } });
    assert.equal(response.status, 200);
    return (await response.json()).floors.flatMap(floor => floor.sessions);
  };
  const until = async predicate => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (await predicate(await sessions())) return;
      await setTimeout(100);
    }
    assert.fail('Session state did not arrive before the deadline');
  };
  const hook = (agent, session, event, extra = {}) => cli([`${agent}-hook`], JSON.stringify({ session_id: session, cwd: dir, hook_event_name: event, ...extra }));
  const pluginHook = (agent, event) => new Promise((resolve, reject) => {
    const helper = fileURLToPath(new URL(agent === 'claude' ? '../mod/scripts/hook.mjs' : '../plugins/hopper-hq/scripts/hopper.mjs', import.meta.url));
    const child = spawn(process.execPath, [helper, 'hook'], { env: { ...env, HOPPER_HQ_BIN: bin }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      try { assert.equal(code, 0); assert.equal(output, ''); resolve(); } catch (err) { reject(err); }
    });
    child.stdin.end(JSON.stringify({ session_id: `${agent}-plugin`, cwd: dir, hook_event_name: event, prompt: 'Inspect the repository' }));
  });
  try {
    const live = { pid: process.pid, cwd: dir, startedAt: Date.now(), status: 'idle', statusUpdatedAt: Date.now() };
    await writeFile(join(claude, 'sessions/live.json'), JSON.stringify({ ...live, sessionId: 'native-live' }));
    await writeFile(join(claude, 'sessions/stale.json'), JSON.stringify({ ...live, startedAt: 1, sessionId: 'reused-pid' }));
    await start();
    await until(rows => rows.some(row => row.id === 'native-live'));
    assert(!(await sessions()).some(row => row.id === 'reused-pid'));
    for (const agent of ['claude', 'codex']) {
      const id = `${agent}-print`;
      const stored = agent === 'codex' ? `codex-${id}` : id;
      await hook(agent, id, 'SessionStart', { source: 'startup' });
      await hook(agent, id, 'UserPromptSubmit', { prompt: 'Inspect the repository' });
      await until(rows => rows.some(row => row.id === stored && row.state === 'working'));
      await hook(agent, id, 'Stop', { last_assistant_message: 'Inspection complete' });
      await until(rows => rows.some(row => row.id === stored && row.state === 'done'));
      await cli(['down']);
      await start();
      await hook(agent, id, 'SessionStart', { source: 'resume' });
      await hook(agent, id, 'UserPromptSubmit', { prompt: 'Continue' });
      await until(rows => rows.filter(row => row.id === stored).length === 1 && rows.some(row => row.id === stored && row.state === 'working'));
      await hook(agent, id, 'SessionEnd', { reason: 'other' });
      await until(rows => !rows.some(row => row.id === stored));
      const pluginId = agent === 'codex' ? 'codex-codex-plugin' : 'claude-plugin';
      await pluginHook(agent, 'UserPromptSubmit');
      await until(rows => rows.some(row => row.id === pluginId && row.state === 'working'));
      await pluginHook(agent, 'SessionEnd');
      await until(rows => !rows.some(row => row.id === pluginId));
    }
    await cli(['down']);
    assert.equal(await hook('claude', 'offline', 'Stop'), '');
    assert.equal(await hook('codex', 'offline', 'Stop'), '');
    await pluginHook('claude', 'Stop');
    await pluginHook('codex', 'Stop');
  } finally {
    await cli(['down']).catch(() => {});
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

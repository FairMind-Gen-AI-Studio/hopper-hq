import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { mapCodexHook } from '../src/adapters/codex/hooks.js';

const run = promisify(execFile);
const root = resolve('plugins/hopper-hq');
const helper = join(root, 'scripts/hopper.mjs');
const read = async (p: string) => JSON.parse(await readFile(p, 'utf8'));
const dirs: string[] = [];
afterEach(async () => { for (const p of dirs.splice(0)) await rm(p, { recursive: true, force: true }); });

async function fakeCli(body: string) {
  const dir = await mkdtemp(join(tmpdir(), 'hopper plugin ')); dirs.push(dir);
  const bin = join(dir, 'hopper-hq');
  await writeFile(bin, `#!${process.execPath}\n${body}\n`); await chmod(bin, 0o755);
  return { dir, bin, env: { ...process.env, HOPPER_HQ_BIN: bin } };
}

function hook(payload: string, env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [helper, 'hook'], { env, timeout: 6000 }, (err, stdout, stderr) => {
      if (err && !('code' in err)) return reject(err);
      resolve({ code: err ? (err as { code: number }).code : 0, stdout, stderr });
    });
    child.stdin!.end(payload);
  });
}

describe('Codex plugin package', () => {
  it('exposes the plugin through the repository marketplace and references packaged skills/hooks', async () => {
    const marketplace = await read('.agents/plugins/marketplace.json');
    expect(marketplace.name).toBe('hopper-hq-codex');
    const entry = marketplace.plugins.find((p: { name: string }) => p.name === 'hopper-hq');
    expect(entry.source).toEqual({ source: 'local', path: './plugins/hopper-hq' });
    expect(entry.policy.installation).toBe('AVAILABLE');
    const manifest = await read(join(root, 'plugin.json'));
    expect(manifest.name).toBe('hopper-hq');
    expect(await readFile(join(root, 'LICENSE'), 'utf8')).toBe(await readFile('LICENSE', 'utf8'));
    expect(manifest.extensions['com.openai'].hooks).toBe('./hooks/hooks.json');
    const opening = await readFile(join(root, 'skills/hopper-hq/SKILL.md'), 'utf8');
    const setup = await readFile(join(root, 'skills/setup/SKILL.md'), 'utf8');
    expect(opening).toContain('scripts/hopper.mjs');
    expect(opening).toContain('open');
    expect(setup).toContain('check');
    expect(manifest.extensions['com.openai'].onboardingSkill).toBe('./skills/setup/SKILL.md');
  });
  it('ships supported observer events with quoted plugin paths and bounded synchronous execution', async () => {
    const hooks = (await read(join(root, 'hooks/hooks.json'))).hooks;
    expect(Object.keys(hooks).sort()).toEqual(['Interrupt', 'PermissionRequest', 'PostToolUse', 'PreToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'SubagentStart', 'SubagentStop', 'UserPromptSubmit'].sort());
    for (const [event, groups] of Object.entries(hooks)) {
      const handler = (groups as Array<{ hooks: unknown[] }>)[0]!.hooks[0];
      expect(handler).toMatchObject({ type: 'command', command: 'node "${PLUGIN_ROOT}/scripts/hopper.mjs" hook', timeout: 3 });
      expect((handler as { async?: boolean }).async).not.toBe(true);
      expect(mapCodexHook({ session_id: 'plugin-test', cwd: '/work/api', hook_event_name: event, tool_name: 'Bash', agent_id: event.startsWith('Subagent') ? 'child1' : undefined }, 100).length, event).toBeGreaterThan(0);
    }
  });
});

describe('plugin helper', () => {
  it('forwards stdin and tmux environment unchanged without emitting CLI output', async () => {
    const cli = await fakeCli(`import { readFileSync, writeFileSync } from 'node:fs';
const payload = readFileSync(0, 'utf8');
writeFileSync(process.env.RECEIVED, JSON.stringify({ args: process.argv.slice(2), payload, pane: process.env.TMUX_PANE, home: process.env.HOPPER_HQ_HOME }));
console.log('must stay silent'); console.error('must stay silent');`);
    const received = join(cli.dir, 'received.json');
    const payload = JSON.stringify({ session_id: 'S1', hook_event_name: 'Stop' });
    const result = await hook(payload, { ...cli.env, RECEIVED: received, TMUX_PANE: '%7', HOPPER_HQ_HOME: '/custom/hopper' });
    expect(result).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(await read(received)).toEqual({ args: ['codex-hook'], payload, pane: '%7', home: '/custom/hopper' });
  });
  it('fails open when the CLI is missing, fails, or hangs', async () => {
    expect(await hook('{}', { ...process.env, HOPPER_HQ_BIN: '/missing/hopper' })).toEqual({ code: 0, stdout: '', stderr: '' });
    const failed = await fakeCli('process.exit(2);');
    expect(await hook('{}', failed.env)).toEqual({ code: 0, stdout: '', stderr: '' });
    const hanging = await fakeCli('setInterval(() => {}, 1000);');
    expect(await hook('{}', hanging.env)).toEqual({ code: 0, stdout: '', stderr: '' });
  });
  it('opens with argv, supporting a CLI path containing spaces; checks for Codex support first', async () => {
    const cli = await fakeCli(`import { appendFileSync } from 'node:fs';
if (process.argv[2] === '--help') console.log('hopper-hq codex-hook');
else appendFileSync(process.env.CALLS, JSON.stringify(process.argv.slice(2))+'\\n');`);
    const calls = join(cli.dir, 'calls');
    const result = await run(process.execPath, [helper, 'open'], { env: { ...cli.env, CALLS: calls } });
    expect(result.stderr).toBe('');
    expect((await readFile(calls, 'utf8')).trim()).toBe('["up"]');
    const old = await fakeCli("console.log('hopper-hq --version');");
    await expect(run(process.execPath, [helper, 'open'], { env: old.env })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('Codex support') });
  });
});

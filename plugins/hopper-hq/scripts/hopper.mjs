#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const binary = process.env.HOPPER_HQ_BIN || 'hopper-hq';
const [action] = process.argv.slice(2);

function invocation(args) {
  if (/\.(?:cjs|mjs|js)$/i.test(binary)) return { command: process.execPath, args: [binary, ...args], env: process.env };
  if (process.platform !== 'win32') return { command: binary, args, env: process.env };
  return {
    command: process.env.ComSpec || 'cmd.exe',
    args: ['/d', '/v:off', '/s', '/c', `""%HOPPER_HQ_EXECUTABLE%" ${args.join(' ')}"`],
    env: { ...process.env, HOPPER_HQ_EXECUTABLE: binary },
    windowsVerbatimArguments: true,
  };
}

/** Hooks observe only: an absent or stalled CLI must not delay or control a Codex turn. */
async function forward() {
  await new Promise(resolve => {
    const cli = invocation(['codex-hook']);
    const child = spawn(cli.command, cli.args, {
      env: cli.env,
      windowsVerbatimArguments: cli.windowsVerbatimArguments,
      stdio: ['inherit', 'ignore', 'ignore'],
      timeout: 2200,
      killSignal: 'SIGKILL',
      windowsHide: true,
    });
    child.on('error', resolve);
    child.on('close', resolve);
  });
}

async function check() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 13)) throw new Error('Hopper HQ requires Node.js 22.13 or later.');
  let help;
  try {
    const cli = invocation(['--help']);
    help = await exec(cli.command, cli.args, { env: cli.env, windowsVerbatimArguments: cli.windowsVerbatimArguments, timeout: 2000, maxBuffer: 64 * 1024, windowsHide: true });
  } catch {
    throw new Error('Hopper HQ with Codex support is required. Install the Hopper CLI, or set HOPPER_HQ_BIN to its executable path.');
  }
  if (!/\bcodex-hook\b/.test(help.stdout)) throw new Error('This Hopper CLI does not have Codex support. Update it before using the plugin.');
}

async function open() {
  await check();
  const code = await new Promise(resolve => {
    const cli = invocation(['up']);
    const child = spawn(cli.command, cli.args, { env: cli.env, windowsVerbatimArguments: cli.windowsVerbatimArguments, stdio: 'inherit', windowsHide: true });
    child.on('error', err => { process.stderr.write(`${err.message}\n`); resolve(1); });
    child.on('close', code => resolve(code ?? 1));
  });
  process.exitCode = code;
}

try {
  if (action === 'hook') await forward();
  else if (action === 'check') { await check(); process.stdout.write('Hopper HQ is ready for Codex.\n'); }
  else if (action === 'open') await open();
  else { process.stderr.write('Usage: node hopper.mjs hook|check|open\n'); process.exitCode = 2; }
} catch (err) {
  if (action !== 'hook') { process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`); process.exitCode = 1; }
}

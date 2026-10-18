#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const binary = process.env.HOPPER_HQ_BIN || 'hopper-hq';
const [action] = process.argv.slice(2);

/** Hooks observe only: an absent or stalled CLI must not delay or control a Codex turn. */
async function forward() {
  await new Promise(resolve => {
    const child = spawn(binary, ['codex-hook'], {
      env: process.env,
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
    help = await exec(binary, ['--help'], { timeout: 2000, maxBuffer: 64 * 1024 });
  } catch {
    throw new Error('Hopper HQ with Codex support is required. Install the Hopper CLI, or set HOPPER_HQ_BIN to its executable path.');
  }
  if (!/\bcodex-hook\b/.test(help.stdout)) throw new Error('This Hopper CLI does not have Codex support. Update it before using the plugin.');
}

async function open() {
  await check();
  const code = await new Promise(resolve => {
    const child = spawn(binary, ['up'], { env: process.env, stdio: 'inherit', windowsHide: true });
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

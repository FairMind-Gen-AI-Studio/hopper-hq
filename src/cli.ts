import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { AttentionSummary, Snapshot } from './collector.js';
import { resolvePaths } from './config.js';

export interface Io {
  out(line: string): void;
  err(line: string): void;
  /** Opens a URL in the browser. Without it, `ui` only prints the link. */
  open?(url: string): Promise<void>;
  /** Resolves when a long-running command (start, demo) should stop. Default: SIGINT or SIGTERM. */
  untilStopped?(): Promise<void>;
}

/** Opens a URL with the desktop's opener (macOS, Linux). Failures are ignored: the link is printed anyway. */
function openInBrowser(url: string): Promise<void> {
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'linux' ? 'xdg-open' : null;
  if (!opener) return Promise.resolve();
  return new Promise((resolve) => {
    execFile(opener, [url], { timeout: 10_000 }, () => resolve());
  });
}

function untilSignal(): Promise<void> {
  return new Promise((resolve) => {
    process.once('SIGINT', () => resolve());
    process.once('SIGTERM', () => resolve());
  });
}

const stdio: Io = {
  out: (line) => void process.stdout.write(line + '\n'),
  err: (line) => void process.stderr.write(line + '\n'),
  open: openInBrowser,
  untilStopped: untilSignal,
};

export const HELP = `scranton-hq: watch your coding-agent sessions work

Usage:
  scranton-hq start [--port N] [--claude-dir DIR] [--data-dir DIR] [--no-watch]
  scranton-hq status [--format text|tmux|json] [--data-dir DIR]
  scranton-hq ls [--data-dir DIR]
  scranton-hq ack [SESSION_ID] [--data-dir DIR]
  scranton-hq ui [--no-open] [--data-dir DIR]
  scranton-hq demo [--port N] [--data-dir DIR]
  scranton-hq --version`;

class UsageError extends Error {}

function version(): string {
  return (createRequire(import.meta.url)('../package.json') as { version: string }).version;
}

function isParseError(err: unknown): boolean {
  return typeof (err as { code?: unknown })?.code === 'string' && (err as { code: string }).code.startsWith('ERR_PARSE_ARGS');
}

export async function main(argv: string[], io: Io = stdio): Promise<number> {
  const [cmd, ...args] = argv;
  try {
    switch (cmd) {
      case 'start':
        return await cmdStart(args, io);
      case 'status':
        return await cmdStatus(args, io);
      case 'ls':
        return await cmdLs(args, io);
      case 'ack':
        return await cmdAck(args, io);
      case 'demo':
        return await cmdDemo(args, io);
      case 'ui':
        return await cmdUi(args, io);
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        io.out(HELP);
        return 0;
      case '--version':
      case '-v':
        io.out(version());
        return 0;
      default:
        throw new UsageError(`Unknown command: ${cmd}`);
    }
  } catch (err) {
    if (err instanceof UsageError || isParseError(err)) {
      io.err((err as Error).message);
      io.err(HELP);
      return 2;
    }
    throw err;
  }
}

const dataDirOption = { 'data-dir': { type: 'string' } } as const;

async function cmdStart(args: string[], io: Io): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { port: { type: 'string' }, 'claude-dir': { type: 'string' }, ...dataDirOption, 'no-watch': { type: 'boolean', default: false } },
  });
  const port = values.port === undefined ? undefined : Number(values.port);
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) throw new UsageError(`Invalid port: ${values.port}`);
  const { startDaemon } = await import('./daemon.js');
  let daemon;
  try {
    daemon = await startDaemon({ port, claudeDir: values['claude-dir'], dataDir: values['data-dir'], watchFiles: !values['no-watch'], log: io.err });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      io.err(`Port ${port ?? 7337} is already in use. Is scranton-hq already running? Check with: scranton-hq status`);
      return 1;
    }
    throw err;
  }
  io.err('Open the building in your browser with: scranton-hq ui');
  await (io.untilStopped ?? untilSignal)();
  await daemon.stop();
  return 0;
}

async function cmdStatus(args: string[], io: Io): Promise<number> {
  const { values } = parseArgs({ args, options: { format: { type: 'string', default: 'text' }, ...dataDirOption } });
  const format = values.format;
  if (format !== 'text' && format !== 'tmux' && format !== 'json') throw new UsageError(`Unknown format: ${format}`);
  const { dataDir } = resolvePaths({ dataDir: values['data-dir'] });
  const { callDaemon } = await import('./client.js');
  const r = await callDaemon<AttentionSummary>(dataDir, 'GET', '/api/attention', 800);
  const { formatAttentionText, formatTmux } = await import('./cli-format.js');
  if (format === 'tmux') {
    io.out(r?.ok && r.data ? formatTmux(r.data) : '');
    return 0;
  }
  if (!r) {
    io.err('scranton-hq is not running. Start it with: scranton-hq start');
    return 1;
  }
  if (!r.ok || !r.data) {
    io.err(`The daemon answered with status ${r.status}.`);
    return 1;
  }
  io.out(format === 'json' ? JSON.stringify(r.data) : formatAttentionText(r.data, Date.now()));
  return 0;
}

async function cmdLs(args: string[], io: Io): Promise<number> {
  const { values } = parseArgs({ args, options: { ...dataDirOption } });
  const { dataDir } = resolvePaths({ dataDir: values['data-dir'] });
  const { callDaemon } = await import('./client.js');
  const r = await callDaemon<Snapshot>(dataDir, 'GET', '/api/building');
  if (!r) {
    io.err('scranton-hq is not running. Start it with: scranton-hq start');
    return 1;
  }
  if (!r.ok || !r.data) {
    io.err(`The daemon answered with status ${r.status}.`);
    return 1;
  }
  const { formatBuilding } = await import('./cli-format.js');
  io.out(formatBuilding(r.data));
  return 0;
}

async function cmdAck(args: string[], io: Io): Promise<number> {
  const { values, positionals } = parseArgs({ args, options: { ...dataDirOption }, allowPositionals: true });
  const { dataDir } = resolvePaths({ dataDir: values['data-dir'] });
  const { callDaemon } = await import('./client.js');
  const id = positionals[0];
  if (id) {
    const r = await callDaemon<unknown>(dataDir, 'POST', `/api/sessions/${encodeURIComponent(id)}/seen`);
    if (!r) {
      io.err('scranton-hq is not running. Start it with: scranton-hq start');
      return 1;
    }
    if (r.status === 404) {
      io.err(`No finished session with id ${id}.`);
      return 1;
    }
    io.out(`Marked ${id} as seen.`);
    return 0;
  }
  const r = await callDaemon<{ marked: number }>(dataDir, 'POST', '/api/seen');
  if (!r || !r.data) {
    io.err('scranton-hq is not running. Start it with: scranton-hq start');
    return 1;
  }
  const n = r.data.marked;
  io.out(`Marked ${n} session${n === 1 ? '' : 's'} as seen.`);
  return 0;
}

async function cmdDemo(args: string[], io: Io): Promise<number> {
  const { values } = parseArgs({ args, options: { port: { type: 'string', default: '7338' }, ...dataDirOption } });
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UsageError(`Invalid port: ${values.port}`);
  const dataDir = values['data-dir'] ?? join(resolvePaths().dataDir, 'demo');
  const { startDaemon } = await import('./daemon.js');
  let daemon;
  try {
    daemon = await startDaemon({ demo: true, port, dataDir, log: io.err });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      io.err(`Port ${port} is already in use. Pick another with --port.`);
      return 1;
    }
    throw err;
  }
  io.err(`Demo running. In another terminal: scranton-hq ls --data-dir ${dataDir}`);
  io.err(`Open the building (this link works once, for 10 minutes): ${daemon.loginUrl()}`);
  await (io.untilStopped ?? untilSignal)();
  await daemon.stop();
  return 0;
}

async function cmdUi(args: string[], io: Io): Promise<number> {
  const { values } = parseArgs({ args, options: { 'no-open': { type: 'boolean', default: false }, ...dataDirOption } });
  const { dataDir } = resolvePaths({ dataDir: values['data-dir'] });
  const { callDaemon } = await import('./client.js');
  const r = await callDaemon<{ url: string; expiresAt: number }>(dataDir, 'POST', '/api/ui/login-code');
  if (!r) {
    io.err('scranton-hq is not running. Start it with: scranton-hq start');
    return 1;
  }
  if (!r.ok || !r.data) {
    io.err(`The daemon answered with status ${r.status}.`);
    return 1;
  }
  const minutes = Math.max(1, Math.round((r.data.expiresAt - Date.now()) / 60_000));
  io.err(`This link signs your browser in. It works once, within ${minutes} minute${minutes === 1 ? '' : 's'}:`);
  io.out(r.data.url);
  if (!values['no-open'] && io.open) await io.open(r.data.url);
  return 0;
}

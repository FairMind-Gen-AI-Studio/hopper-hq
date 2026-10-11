import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import type { AttentionSummary, Snapshot } from './collector.js';
import { resolvePaths } from './config.js';

export interface Io {
  out(line: string): void;
  err(line: string): void;
}

const stdio: Io = {
  out: (line) => void process.stdout.write(line + '\n'),
  err: (line) => void process.stderr.write(line + '\n'),
};

export const HELP = `scranton-hq: watch your coding-agent sessions work

Usage:
  scranton-hq start [--port N] [--claude-dir DIR] [--data-dir DIR] [--no-watch]
  scranton-hq status [--format text|tmux|json] [--data-dir DIR]
  scranton-hq ls [--data-dir DIR]
  scranton-hq ack [SESSION_ID] [--data-dir DIR]
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
  await new Promise<void>((resolve) => {
    process.once('SIGINT', () => resolve());
    process.once('SIGTERM', () => resolve());
  });
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

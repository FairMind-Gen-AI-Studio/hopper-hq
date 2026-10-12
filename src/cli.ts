import { execFile, spawn } from 'node:child_process';
import { mkdir, open, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { AttentionSummary, Snapshot } from './collector.js';
import { resolvePaths } from './config.js';
import { readDaemonFile } from './daemon-file.js';
import { dataDirInUse, DataDirInUseError } from './daemon-lock.js';
import { cleanText } from './scene/text.js';

/** Time, for the commands that wait. */
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

/** A daemon started in the background. */
export interface Background {
  /** Resolves when its process ends, or could not start. */
  exited: Promise<void>;
  /** Ends its process. */
  stop(): void;
}

export interface Io {
  out(line: string): void;
  err(line: string): void;
  /** Opens a URL in the browser. Without it, `ui` only prints the link. */
  open?(url: string): Promise<void>;
  /** Resolves when a long-running command (start, demo) should stop. Default: SIGINT or SIGTERM. */
  untilStopped?(): Promise<void>;
  /** For the commands that wait (up, down). Default: the real clock. */
  clock?: Clock;
  /** Starts `scranton-hq start ARGS` in the background, its output appended to `log`. Default: a detached process. */
  spawnDaemon?(args: string[], log: string): Promise<Background>;
}

/** Opens a URL with the desktop's opener (macOS, Linux). Failures are ignored: the link is printed anyway. */
function openInBrowser(url: string): Promise<void> {
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'linux' ? 'xdg-open' : null;
  if (!opener) return Promise.resolve();
  return new Promise((resolve) => {
    execFile(opener, [url], { timeout: 10_000 }, () => resolve());
  });
}

const realClock: Clock = { now: Date.now, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };

/** This CLI's entry point, beside this module: dist/bin.js once built. */
const BIN = fileURLToPath(new URL('./bin.js', import.meta.url));

/**
 * Runs `scranton-hq start ARGS` detached, in a session of its own, with its output appended to `log` and its working
 * directory the log's. It outlives this command and the terminal, and shares no pipe with this process: whoever reads
 * this command's output to its end, as the mod does, gets that end when this command exits.
 */
async function spawnDetached(args: string[], log: string): Promise<Background> {
  const file = await open(log, 'a', 0o600);
  try {
    await file.chmod(0o600);
    const child = spawn(process.execPath, [BIN, 'start', ...args], { cwd: dirname(log), detached: true, stdio: ['ignore', file.fd, file.fd] });
    const exited = new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      child.once('error', () => resolve());
    });
    child.unref();
    return { exited, stop: () => void child.kill() };
  } finally {
    await file.close();
  }
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
  scranton-hq up [--port N] [--no-open] [--claude-dir DIR] [--data-dir DIR]
  scranton-hq start [--port N] [--claude-dir DIR] [--data-dir DIR] [--no-watch]
  scranton-hq down [--data-dir DIR]
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
      case 'up':
        return await cmdUp(args, io);
      case 'start':
        return await cmdStart(args, io);
      case 'down':
        return await cmdDown(args, io);
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

/** What to add to a command printed as a hint, so that it reaches the same data directory. */
const dataDirFlag = (dataDir: string | undefined): string => (dataDir === undefined ? '' : ` --data-dir ${dataDir}`);

/** The --port value, when given: a whole number from 0 to 65535. */
function portOption(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UsageError(`Invalid port: ${value}`);
  return port;
}

/**
 * Opens the building whether or not the daemon runs: a daemon that answers is used as it is; otherwise one is started in
 * the background, and up waits until it answers. A second daemon on the data directory would find it taken, and exit.
 */
async function cmdUp(args: string[], io: Io): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { port: { type: 'string' }, 'no-open': { type: 'boolean', default: false }, 'claude-dir': { type: 'string' }, ...dataDirOption },
  });
  const port = portOption(values.port);
  const dataDir = resolve(resolvePaths({ dataDir: values['data-dir'] }).dataDir);
  const openLink = !values['no-open'];
  const { callDaemon } = await import('./client.js');
  const answers = async () => (await callDaemon<unknown>(dataDir, 'GET', '/api/health', 500))?.ok === true;
  if (await answers()) {
    io.err('scranton-hq is already running.');
    return signIn(dataDir, openLink, io);
  }
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const log = join(dataDir, 'daemon.log');
  const from = (await stat(log).catch(() => null))?.size ?? 0;
  const startArgs = ['--data-dir', dataDir];
  if (port !== undefined) startArgs.push('--port', String(port));
  if (values['claude-dir'] !== undefined) startArgs.push('--claude-dir', resolve(values['claude-dir']));
  const daemon = await (io.spawnDaemon ?? spawnDetached)(startArgs, log);
  let ended = false;
  void daemon.exited.then(() => (ended = true));
  const clock = io.clock ?? realClock;
  const until = clock.now() + WAIT_MS;
  while (!(await answers())) {
    // When another up started a daemon first, this one's exits, while the other holds the directory as it starts.
    if (ended && !(await held(dataDir))) return failed(io, 'scranton-hq stopped while starting.', log, from);
    if (clock.now() >= until) {
      if (!ended) daemon.stop();
      return failed(io, 'scranton-hq did not answer within 10 seconds.', log, from);
    }
    await clock.sleep(POLL_MS);
  }
  io.err(`Started scranton-hq in the background. Its log is ${log}`);
  io.err(`Stop it with: scranton-hq down${dataDirFlag(values['data-dir'] === undefined ? undefined : dataDir)}`);
  return signIn(dataDir, openLink, io);
}

/** Says why up failed, with what the daemon wrote to its log on the way. */
async function failed(io: Io, why: string, log: string, from: number): Promise<number> {
  io.err(why);
  for (const line of await logSince(log, from)) io.err(`  ${line}`);
  io.err(`Its log is ${log}`);
  return 1;
}

/** The lines written to the log from byte `from` on, at most its last 4 KiB, each cleaned for the terminal. */
async function logSince(log: string, from: number): Promise<string[]> {
  const file = await open(log, 'r').catch(() => null);
  if (!file) return [];
  try {
    const { size } = await file.stat();
    const length = Math.min(size - from, 4096);
    if (length <= 0) return [];
    const { buffer, bytesRead } = await file.read(Buffer.alloc(length), 0, length, size - length);
    return buffer.subarray(0, bytesRead).toString('utf8').split('\n').map((line) => cleanText(line, 300)).filter((line) => line !== '');
  } finally {
    await file.close();
  }
}

async function cmdStart(args: string[], io: Io): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { port: { type: 'string' }, 'claude-dir': { type: 'string' }, ...dataDirOption, 'no-watch': { type: 'boolean', default: false } },
  });
  const port = portOption(values.port);
  const { startDaemon } = await import('./daemon.js');
  let daemon;
  try {
    daemon = await startDaemon({ port, claudeDir: values['claude-dir'], dataDir: values['data-dir'], watchFiles: !values['no-watch'], log: io.err });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      io.err(`Port ${port ?? 7337} is already in use. Is scranton-hq already running? Check with: scranton-hq status`);
      return 1;
    }
    if (err instanceof DataDirInUseError) {
      io.err(`scranton-hq is already running. Check with: scranton-hq status${dataDirFlag(values['data-dir'])}`);
      return 1;
    }
    throw err;
  }
  io.err('Open the building in your browser with: scranton-hq ui');
  await Promise.race([(io.untilStopped ?? untilSignal)(), daemon.stopRequested]);
  await daemon.stop();
  return 0;
}

/** How long up waits for the daemon to answer and down for it to stop, and how often they look. */
const WAIT_MS = 10_000;
const POLL_MS = 100;

/** Whether a daemon holds the data directory, answering or not. */
async function held(dataDir: string): Promise<boolean> {
  // The lock is SQLite's, and Node 22 warns that node:sqlite is experimental: nothing a command should print.
  const { silenceExperimentalWarnings } = await import('./daemon.js');
  silenceExperimentalWarnings();
  return dataDirInUse(dataDir);
}

/** Asks the daemon to stop and waits until it has. No signal is sent: a process id in a file can be stale, or reused. */
async function cmdDown(args: string[], io: Io): Promise<number> {
  const { values } = parseArgs({ args, options: { ...dataDirOption } });
  const { dataDir } = resolvePaths({ dataDir: values['data-dir'] });
  const info = await readDaemonFile(dataDir);
  if (!info) {
    io.err('scranton-hq is not running.');
    return 0;
  }
  const { callDaemon } = await import('./client.js');
  const r = await callDaemon<unknown>(dataDir, 'POST', '/api/shutdown');
  if (!r) {
    // Nothing answers: the file is left over, unless a daemon still holds the directory.
    if (!(await held(dataDir))) {
      io.err('scranton-hq is not running.');
      return 0;
    }
    io.err(`scranton-hq does not answer, but it still holds ${dataDir}. Its daemon file names process ${info.pid}.`);
    return 1;
  }
  if (r.status === 404) {
    io.err(`This scranton-hq daemon (process ${info.pid}) is older than the down command. Stop it with Ctrl-C where it runs.`);
    return 1;
  }
  if (!r.ok) {
    io.err(`The daemon answered with status ${r.status}.`);
    return 1;
  }
  // The daemon removes its file last, once it has stopped.
  const clock = io.clock ?? realClock;
  const until = clock.now() + WAIT_MS;
  while ((await readDaemonFile(dataDir))?.pid === info.pid) {
    if (clock.now() >= until) {
      io.err(`scranton-hq is still stopping. Check again with: scranton-hq status${dataDirFlag(values['data-dir'])}`);
      return 1;
    }
    await clock.sleep(POLL_MS);
  }
  io.err('scranton-hq has stopped.');
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
    io.err('scranton-hq is not running. Start it with: scranton-hq up');
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
    io.err('scranton-hq is not running. Start it with: scranton-hq up');
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
      io.err('scranton-hq is not running. Start it with: scranton-hq up');
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
    io.err('scranton-hq is not running. Start it with: scranton-hq up');
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
    if (err instanceof DataDirInUseError) {
      io.err(`A demo is already running on ${dataDir}. Pick another with --data-dir.`);
      return 1;
    }
    throw err;
  }
  io.err(`Demo running. In another terminal: scranton-hq ls --data-dir ${dataDir}`);
  io.err(`Open the building (this link works once, for 10 minutes): ${daemon.loginUrl()}`);
  await Promise.race([(io.untilStopped ?? untilSignal)(), daemon.stopRequested]);
  await daemon.stop();
  return 0;
}

/** The one thing `ui` prints or opens: a sign-in link to the loopback address, as the daemon mints them. */
const LOGIN_URL = /^http:\/\/127\.0\.0\.1:\d{1,5}\/ui\/login\?code=[0-9a-f]{48}$/;

async function cmdUi(args: string[], io: Io): Promise<number> {
  const { values } = parseArgs({ args, options: { 'no-open': { type: 'boolean', default: false }, ...dataDirOption } });
  const { dataDir } = resolvePaths({ dataDir: values['data-dir'] });
  return signIn(dataDir, !values['no-open'], io);
}

/** Prints a one-time sign-in link to the building of the daemon on `dataDir`, and opens it in the browser when asked. */
async function signIn(dataDir: string, openLink: boolean, io: Io): Promise<number> {
  const { callDaemon } = await import('./client.js');
  const r = await callDaemon<{ url?: unknown; expiresAt?: unknown }>(dataDir, 'POST', '/api/ui/login-code');
  if (!r) {
    io.err('scranton-hq is not running. Start it with: scranton-hq up');
    return 1;
  }
  if (!r.ok || !r.data) {
    io.err(`The daemon answered with status ${r.status}.`);
    return 1;
  }
  // Whatever listens on the daemon's port answers here: print and open only what scranton-hq would send.
  const { url, expiresAt } = r.data;
  if (typeof url !== 'string' || !LOGIN_URL.test(url) || typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) {
    io.err('The daemon did not answer with a sign-in link.');
    return 1;
  }
  const minutes = Math.max(1, Math.round((expiresAt - Date.now()) / 60_000));
  io.err(`This link signs your browser in. It works once, within ${minutes} minute${minutes === 1 ? '' : 's'}:`);
  io.out(url);
  if (openLink && io.open) await io.open(url);
  return 0;
}

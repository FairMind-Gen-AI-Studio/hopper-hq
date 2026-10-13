import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { isSessionId } from '../../scene/text.js';

const execFileP = promisify(execFile);

export interface LiveSessionFile {
  file: string;
  pid: number;
  sessionId: string;
  cwd: string;
  /** 0 when the file does not say. */
  startedAt: number;
  status: 'busy' | 'idle' | 'waiting' | null;
  statusUpdatedAt: number | null;
  waitingFor: string | null;
  name: string | null;
  tmuxPane: string | null;
  /** The tmux session the pane is in, when the field names it. */
  tmuxSession: string | null;
  kind: string | null;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** Claude Code's tmux field, 'session:@window.%pane': the pane id, and the session when the field names it. */
function parseTmux(tmux: string | null): { tmuxPane: string | null; tmuxSession: string | null } {
  if (!tmux) return { tmuxPane: null, tmuxSession: null };
  const full = /^(.+):@\d+\.(%\d+)$/.exec(tmux);
  if (full) return { tmuxPane: full[2]!, tmuxSession: full[1]! };
  return { tmuxPane: tmux.match(/%\d+$/)?.[0] ?? null, tmuxSession: null };
}

export function parseSessionFile(file: string, text: string): LiveSessionFile | null {
  let d: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    d = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  // The id names the transcript file too: one that is not a plain id is no session.
  if (!Number.isInteger(d.pid) || !isSessionId(d.sessionId) || typeof d.cwd !== 'string' || !d.cwd) return null;
  const status = d.status === 'busy' || d.status === 'idle' || d.status === 'waiting' ? d.status : null;
  return {
    file,
    pid: d.pid as number,
    sessionId: d.sessionId,
    cwd: d.cwd,
    startedAt: num(d.startedAt) ?? 0,
    status,
    statusUpdatedAt: num(d.statusUpdatedAt),
    waitingFor: str(d.waitingFor),
    name: str(d.name),
    ...parseTmux(str(d.tmux)),
    kind: str(d.kind),
  };
}

/** The session files in the directory, or null when it could not be read: that is not the same as no live session. */
export async function readSessionsDir(dir: string): Promise<LiveSessionFile[] | null> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith('.json')).sort();
  } catch {
    return null;
  }
  const out: LiveSessionFile[] = [];
  for (const n of names) {
    const path = join(dir, n);
    try {
      const s = parseSessionFile(path, await readFile(path, 'utf8'));
      if (s) out.push(s);
    } catch {
      // the file disappeared between readdir and readFile
    }
  }
  return out;
}

/** pid -> process start time in ms, for the pids that are running; null when ps could not tell. */
export type ProcessProbe = (pids: number[], now: number) => Promise<Map<number, number> | null>;

/** Parses ps etime, "[[dd-]hh:]mm:ss", into seconds. */
export function parseEtime(etime: string): number | null {
  const m = etime.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return null;
  const [, d, h, mi, s] = m;
  return ((Number(d ?? 0) * 24 + Number(h ?? 0)) * 60 + Number(mi)) * 60 + Number(s);
}

export const psProbe: ProcessProbe = async (pids, now) => {
  const out = new Map<number, number>();
  const wanted = new Set(pids.filter((p) => Number.isInteger(p) && p > 0));
  if (wanted.size === 0) return out;
  let stdout = '';
  let ran = true;
  try {
    // Every process in one call: a pid list makes ps fail outright (and print nothing) when one pid is out of range.
    ({ stdout } = await execFileP('ps', ['-A', '-o', 'pid=,etime='], { maxBuffer: 16 * 1024 * 1024 }));
  } catch (err) {
    stdout = (err as { stdout?: string }).stdout ?? '';
    ran = stdout.trim() !== '';
  }
  if (!ran) return null;
  for (const line of stdout.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\S+)$/);
    if (!m || !wanted.has(Number(m[1]))) continue;
    const seconds = parseEtime(m[2]!);
    if (seconds !== null) out.set(Number(m[1]), now - seconds * 1000);
  }
  return out;
};

/** True when the running process is the one that wrote the file, not a later process that reused its pid. */
export function isSameProcess(file: LiveSessionFile, processStartMs: number | undefined, toleranceMs = 60_000): boolean {
  if (processStartMs === undefined) return false;
  if (!file.startedAt) return true;
  return processStartMs <= file.startedAt + toleranceMs;
}

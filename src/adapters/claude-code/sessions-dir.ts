import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

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
  kind: string | null;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

export function parseSessionFile(file: string, text: string): LiveSessionFile | null {
  let d: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    d = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!Number.isInteger(d.pid) || typeof d.sessionId !== 'string' || !d.sessionId || typeof d.cwd !== 'string' || !d.cwd) return null;
  const status = d.status === 'busy' || d.status === 'idle' || d.status === 'waiting' ? d.status : null;
  const tmux = str(d.tmux);
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
    tmuxPane: tmux ? (tmux.match(/%\d+$/)?.[0] ?? null) : null,
    kind: str(d.kind),
  };
}

export async function readSessionsDir(dir: string): Promise<LiveSessionFile[]> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith('.json')).sort();
  } catch {
    return [];
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

/** pid -> process start time in ms, for the pids that are running. */
export type ProcessProbe = (pids: number[], now: number) => Promise<Map<number, number>>;

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
  try {
    // Every process in one call: a pid list makes ps fail outright (and print nothing) when one pid is out of range.
    ({ stdout } = await execFileP('ps', ['-A', '-o', 'pid=,etime='], { maxBuffer: 16 * 1024 * 1024 }));
  } catch (err) {
    stdout = (err as { stdout?: string }).stdout ?? '';
  }
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

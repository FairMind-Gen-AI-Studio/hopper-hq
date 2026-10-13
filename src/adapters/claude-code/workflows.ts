import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, sep } from 'node:path';
import { RUN_ID } from '../../core/reducer.js';
import { truncate } from '../../core/tool-label.js';
import type { RawEvent } from '../../core/types.js';
import { cleanOrNull } from '../../scene/text.js';
import { readNewLines, type TailState } from './jsonl.js';
import { parseScriptMeta, type ScriptMeta } from './script-meta.js';
import type { WorkflowLaunch } from './transcript.js';

/** Runs followed at once per session. */
export const MAX_FOLLOWED_RUNS = 16;
const MAX_SCRIPT_BYTES = 256 * 1024;
/** A run's end file embeds its script and its results: a bigger one is not read. */
const MAX_END_BYTES = 8 * 1024 * 1024;
const MAX_PHASES = 32;
/** Journal reads per run and scan, as for transcripts. */
const READS_PER_SCAN = 8;
/** An agent id a journal line may carry: a file name is made from it. */
const AGENT_ID = /^[A-Za-z0-9_-]{1,128}$/;

export interface WorkflowScannerOptions {
  sessionId: string;
  cwd: string;
  /** When the session's process started: a run that ended, or last wrote its journal, before then is history. */
  since: number;
  /**
   * Runs the collector still holds as running on disk, from before this scanner. Each is settled whatever its age: it
   * ends with its end file, is followed while its journal is written since `since`, and is otherwise killed: it died
   * with an earlier process.
   */
  open?: readonly string[];
  emit: (e: RawEvent) => void;
}

interface FollowedRun {
  id: string;
  journal: TailState;
  /** Whether the launch's summary and script were read. */
  launched: boolean;
  /** Agent types from the agents' meta files, each read once. */
  types: Map<string, string>;
  /** The end file's modification time when the run was taken up again, resumed under its id: an end file no newer is that earlier end. Null when it had none. */
  endedBefore: number | null;
}

/** A run that is not followed: history, ended or gone. Its id is judged again when its files change or it is launched again. */
interface SettledRun {
  /** Its end file's modification time when it settled; null when it had none. */
  end: number | null;
  /** The latest change to its journal or its end file then. */
  mark: number;
  /** How far its journal was read, or how long it was when it settled: a resume reads on from there. */
  offset: number;
  /** The transcript launched it again since. */
  relaunched: boolean;
}

/** What a run is when it is judged; see WorkflowScanner.judge. */
type Verdict = 'live' | 'ended' | 'history' | 'gone' | 'unknown';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

async function stats(path: string): Promise<{ mtime: number; size: number } | null> {
  try {
    const s = await stat(path);
    return { mtime: s.mtimeMs, size: s.size };
  } catch {
    return null;
  }
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * When a run ended and started, from its end file: the end at its `timestamp`, else at `startTime + durationMs`, else at
 * the file's modification time, and never after it; the start at `startTime`, never after the end, else at the end.
 */
function endTimes(d: Record<string, unknown>, mtime: number): { start: number; end: number } {
  const stamp = typeof d.timestamp === 'string' ? Date.parse(d.timestamp) : NaN;
  const end = Math.min(Number.isFinite(stamp) ? stamp : finite(d.startTime) && finite(d.durationMs) ? d.startTime + d.durationMs : mtime, mtime);
  return { start: finite(d.startTime) ? Math.min(d.startTime, end) : end, end };
}

/** The meta of a script copy: only of a regular file of at most 256 KiB whose real path lies in the scripts directory. */
async function readScriptMeta(scriptsDir: string, path: string): Promise<ScriptMeta | null> {
  if (!isAbsolute(path)) return null;
  try {
    const [dir, real] = await Promise.all([realpath(scriptsDir), realpath(path)]);
    if (!real.startsWith(dir + sep)) return null;
    const s = await stat(real);
    if (!s.isFile() || s.size > MAX_SCRIPT_BYTES) return null;
    return parseScriptMeta(await readFile(real, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Follows the workflow runs of one live session on disk. `S` is the session's directory, next to its transcript:
 * - `S/subagents/workflows/wf_X/journal.jsonl` says which agents the run started and which finished, or failed;
 * - `S/workflows/wf_X.json` is written when the run ends, and again when a run resumed under its id ends;
 * - `S/workflows/scripts/` holds copies of the scripts, for their meta.
 * A run that goes on is followed; one that ended since the session's process started is read from its end file alone,
 * stamped with the times it gives; any other is history. A run that is not followed is judged again when its journal or
 * its end file changes, or the transcript launches it again: it was resumed. Agent transcripts are never read.
 */
export class WorkflowScanner {
  /** The launches the transcript reported, by run id. A launch alone makes no run. */
  private readonly launches = new Map<string, WorkflowLaunch>();
  /** Runs that are not followed: history, ended or gone. */
  private readonly settled = new Map<string, SettledRun>();
  private readonly runs = new Map<string, FollowedRun>();
  private readonly open: ReadonlySet<string>;

  constructor(private readonly o: WorkflowScannerOptions) {
    this.open = new Set(o.open ?? []);
  }

  noteLaunch(launch: WorkflowLaunch): void {
    this.launches.set(launch.runId, launch);
    const settled = this.settled.get(launch.runId);
    if (settled) settled.relaunched = true;
  }

  /** One scan of the session directory `sessionDir`. A run that cannot be read now is tried again on the next scan. */
  async scan(sessionDir: string, now: number): Promise<void> {
    let names: string[];
    try {
      names = await readdir(join(sessionDir, 'subagents', 'workflows'));
    } catch {
      names = [];
    }
    for (const id of [...new Set([...names, ...this.open])].sort()) {
      if (!RUN_ID.test(id) || this.runs.has(id)) continue;
      const settled = this.settled.get(id);
      const end = await stats(join(sessionDir, 'workflows', `${id}.json`));
      const journal = await stats(join(sessionDir, 'subagents', 'workflows', id, 'journal.jsonl'));
      if (settled && !settled.relaunched && Math.max(end?.mtime ?? -Infinity, journal?.mtime ?? -Infinity) <= settled.mark) continue;
      const { verdict, endedBefore } = this.judge(id, end?.mtime ?? null, journal?.mtime ?? null, settled);
      if (verdict === 'unknown') continue;
      if (verdict === 'live') {
        if (this.runs.size >= MAX_FOLLOWED_RUNS) continue;
        this.settled.delete(id);
        // A run taken up again reads its journal on from where it was left.
        await this.take(sessionDir, id, now, settled?.offset ?? 0, endedBefore);
        continue;
      }
      if (verdict === 'gone') this.o.emit({ sessionId: this.o.sessionId, ts: now, source: 'fs', cwd: this.o.cwd, type: 'workflow.finished', runId: id, status: 'killed' });
      if (verdict === 'ended') await this.end(sessionDir, id, null, null);
      this.settled.set(id, { end: end?.mtime ?? null, mark: Math.max(end?.mtime ?? -Infinity, journal?.mtime ?? -Infinity), offset: settled?.offset ?? journal?.size ?? 0, relaunched: false });
    }
    for (const run of [...this.runs.values()]) {
      try {
        await this.follow(sessionDir, run, now);
      } catch {
        // the next scan reads on from where this one stopped
      }
    }
  }

  /**
   * What a run is, from the modification times of its end file and its journal (null when missing), and how it was left
   * when it settled:
   * - launched again since it settled, or its journal written after its end file: resumed under its id. It is live when
   *   launched again or written since the session's process started, and its end file is that of an earlier end; else
   *   gone (it died with an earlier process) when the collector holds it open, else history;
   * - its end file written again, and its journal, since it settled: resumed and ended between two looks. It is live, and
   *   followed through its new lines to its new end;
   * - an end file: ended when written since the session's process started, or when the collector holds the run open;
   *   else history;
   * - a journal alone: live when written since the session's process started; else gone when held open, else history;
   * - neither: gone when held open, else not known yet.
   */
  private judge(id: string, end: number | null, journal: number | null, settled: SettledRun | undefined): { verdict: Verdict; endedBefore: number | null } {
    const open = this.open.has(id);
    if (settled?.relaunched || (end !== null && journal !== null && journal > end)) {
      if (settled?.relaunched || (journal !== null && journal >= this.o.since)) return { verdict: 'live', endedBefore: end };
      return { verdict: open ? 'gone' : 'history', endedBefore: null };
    }
    if (end !== null) {
      if (settled?.end != null && end !== settled.end && journal !== null && journal > settled.mark) return { verdict: 'live', endedBefore: settled.end };
      return { verdict: end >= this.o.since || open ? 'ended' : 'history', endedBefore: null };
    }
    if (journal !== null && journal >= this.o.since) return { verdict: 'live', endedBefore: null };
    return { verdict: open ? 'gone' : journal === null ? 'unknown' : 'history', endedBefore: null };
  }

  private async take(sessionDir: string, id: string, now: number, offset: number, endedBefore: number | null): Promise<void> {
    const launch = this.launches.get(id);
    const run: FollowedRun = { id, journal: { path: join(sessionDir, 'subagents', 'workflows', id, 'journal.jsonl'), offset, skipping: false }, launched: false, types: new Map(), endedBefore };
    this.runs.set(id, run);
    // The bare start first: it is what makes the run, or starts a finished one again.
    this.started(id, now, {}, true);
    if (launch) await this.launched(sessionDir, run, launch, now, true);
  }

  /** What the launch says beyond the run id: its summary and its script's meta. */
  private async launched(sessionDir: string, run: FollowedRun, launch: WorkflowLaunch, now: number, summary: boolean): Promise<void> {
    run.launched = true;
    if (summary) this.started(run.id, now, { summary: launch.summary });
    if (!launch.scriptPath) return;
    const meta = await readScriptMeta(join(sessionDir, 'workflows', 'scripts'), launch.scriptPath);
    if (meta) this.started(run.id, now, { name: meta.name, summary: meta.description, phases: meta.phases });
  }

  private async follow(sessionDir: string, run: FollowedRun, now: number): Promise<void> {
    const launch = run.launched ? undefined : this.launches.get(run.id);
    if (launch) await this.launched(sessionDir, run, launch, now, true);
    let drained = false;
    for (let i = 0; i < READS_PER_SCAN && !drained; i++) {
      const { lines, state } = await readNewLines(run.journal);
      run.journal = state;
      for (const line of lines) await this.journalLine(sessionDir, run, line, now);
      drained = lines.length === 0;
    }
    // The end file comes after the journal's last line: it is read once the journal is read to its end, and an end file
    // older than the journal is the end of the run before it was resumed.
    if (!drained) return;
    const ended = await this.end(sessionDir, run.id, run.endedBefore, (await stats(run.journal.path))?.mtime ?? null);
    if (ended === null) return;
    this.runs.delete(run.id);
    this.settled.set(run.id, { end: ended, mark: ended, offset: run.journal.offset, relaunched: false });
  }

  private async journalLine(sessionDir: string, run: FollowedRun, line: string, now: number): Promise<void> {
    let d: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      d = parsed as Record<string, unknown>;
    } catch {
      return;
    }
    const agentId = d.agentId;
    if (typeof agentId !== 'string' || !AGENT_ID.test(agentId)) return;
    const base = { sessionId: this.o.sessionId, ts: now, source: 'fs' as const, cwd: this.o.cwd };
    if (d.type === 'started') {
      const agentType = await this.agentType(sessionDir, run, agentId);
      this.o.emit({ ...base, type: 'agent.started', agentId, agentType, description: truncate(str(d.label), 200) || null, runId: run.id, phase: truncate(str(d.phase), 80) || null });
    } else if (d.type === 'result' || d.type === 'failed') {
      // An agent that failed gave no result, and runs no more.
      this.o.emit({ ...base, type: 'agent.finished', agentId });
    }
  }

  private async agentType(sessionDir: string, run: FollowedRun, agentId: string): Promise<string> {
    const known = run.types.get(agentId);
    if (known) return known;
    let type = 'agent';
    try {
      const d = JSON.parse(await readFile(join(sessionDir, 'subagents', 'workflows', run.id, `agent-${agentId}.meta.json`), 'utf8')) as { agentType?: unknown } | null;
      type = truncate(str(d?.agentType), 80) || 'agent';
    } catch {
      // no meta file: the type stays unknown
    }
    run.types.set(agentId, type);
    return type;
  }

  /**
   * The run's end, from its end file when there is one written after `after` and no earlier than `journal`: the end,
   * then what the file says of the run, each stamped with the times it gives. Resolves with the file's modification
   * time; null when there is no such file.
   */
  private async end(sessionDir: string, id: string, after: number | null, journal: number | null): Promise<number | null> {
    const path = join(sessionDir, 'workflows', `${id}.json`);
    let at: { size: number; mtime: number };
    try {
      const s = await stat(path);
      if (!s.isFile() || (after !== null && s.mtimeMs <= after) || (journal !== null && s.mtimeMs < journal)) return null;
      at = { size: s.size, mtime: s.mtimeMs };
    } catch {
      return null;
    }
    let d: Record<string, unknown> = {};
    if (at.size <= MAX_END_BYTES) {
      try {
        const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) d = parsed as Record<string, unknown>;
      } catch {
        // unreadable: the run still ended
      }
    }
    const phases = Array.isArray(d.phases)
      ? d.phases.flatMap((p: unknown) => {
        const title = p && typeof p === 'object' ? cleanOrNull(str((p as { title?: unknown }).title), 80) : null;
        return title ? [title] : [];
      }).slice(0, MAX_PHASES)
      : [];
    const status = d.status === 'failed' || d.status === 'killed' ? d.status : 'completed';
    const { start, end } = endTimes(d, at.mtime);
    // The end first: a run the session does not hold is made already finished, and the file's fields only fill it.
    this.o.emit({ sessionId: this.o.sessionId, ts: end, source: 'fs', cwd: this.o.cwd, type: 'workflow.finished', runId: id, status, startedAt: start });
    this.started(id, start, { name: cleanOrNull(str(d.workflowName), 120), summary: cleanOrNull(str(d.summary), 200), phases });
    return at.mtime;
  }

  /** A workflow.started with the fields that are known; with none, only when `bare` asks for the run alone. */
  private started(runId: string, now: number, f: { name?: string | null; summary?: string | null; phases?: string[] }, bare = false): void {
    const fields = { ...(f.name ? { name: f.name } : {}), ...(f.summary ? { summary: f.summary } : {}), ...(f.phases?.length ? { phases: f.phases } : {}) };
    if (!bare && Object.keys(fields).length === 0) return;
    this.o.emit({ sessionId: this.o.sessionId, ts: now, source: 'fs', cwd: this.o.cwd, type: 'workflow.started', runId, ...fields });
  }
}

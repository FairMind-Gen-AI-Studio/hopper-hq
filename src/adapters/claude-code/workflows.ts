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
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

async function mtime(path: string): Promise<number | null> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return null;
  }
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
 * - `S/workflows/wf_X.json` is written once, when the run ends;
 * - `S/workflows/scripts/` holds copies of the scripts, for their meta.
 * A run is taken up when it ended or wrote its journal since the session's process started; any other is history, and is
 * never looked at again. Agent transcripts are never read. Every event is stamped with the scan's time.
 */
export class WorkflowScanner {
  /** The launches the transcript reported, by run id. A launch alone makes no run. */
  private readonly launches = new Map<string, WorkflowLaunch>();
  /** Runs never to look at again: history, or ended. */
  private readonly done = new Set<string>();
  private readonly runs = new Map<string, FollowedRun>();
  private readonly open: ReadonlySet<string>;

  constructor(private readonly o: WorkflowScannerOptions) {
    this.open = new Set(o.open ?? []);
  }

  noteLaunch(launch: WorkflowLaunch): void {
    this.launches.set(launch.runId, launch);
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
      if (!RUN_ID.test(id) || this.done.has(id) || this.runs.has(id)) continue;
      const verdict = await this.judge(sessionDir, id);
      if (verdict === 'history') this.done.add(id);
      else if (verdict === 'gone') {
        this.done.add(id);
        this.o.emit({ sessionId: this.o.sessionId, ts: now, source: 'fs', cwd: this.o.cwd, type: 'workflow.finished', runId: id, status: 'killed' });
      } else if (verdict === 'live' && this.runs.size < MAX_FOLLOWED_RUNS) await this.take(sessionDir, id, now);
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
   * What a run seen for the first time is: live, history, gone (an open run that died with an earlier process), or not
   * known yet (neither an end file nor a journal).
   */
  private async judge(sessionDir: string, id: string): Promise<'live' | 'history' | 'gone' | 'unknown'> {
    const open = this.open.has(id);
    const ended = await mtime(join(sessionDir, 'workflows', `${id}.json`));
    if (ended !== null) return open || ended >= this.o.since ? 'live' : 'history';
    const written = await mtime(join(sessionDir, 'subagents', 'workflows', id, 'journal.jsonl'));
    if (written !== null && written >= this.o.since) return 'live';
    if (open) return 'gone';
    return written === null ? 'unknown' : 'history';
  }

  private async take(sessionDir: string, id: string, now: number): Promise<void> {
    const launch = this.launches.get(id);
    const run: FollowedRun = { id, journal: { path: join(sessionDir, 'subagents', 'workflows', id, 'journal.jsonl'), offset: 0, skipping: false }, launched: false, types: new Map() };
    this.runs.set(id, run);
    this.started(id, now, { summary: launch?.summary ?? null }, true);
    if (launch) await this.launched(sessionDir, run, launch, now, false);
  }

  /** What the launch says beyond the run id: its summary (unless already sent) and its script's meta. */
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
    // The end file comes after the journal's last line: it is read once the journal is read to its end.
    if (drained) await this.end(sessionDir, run, now);
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

  /** Once the run's end file is there: what it says of the run, then its end. The run is not followed any more. */
  private async end(sessionDir: string, run: FollowedRun, now: number): Promise<void> {
    const path = join(sessionDir, 'workflows', `${run.id}.json`);
    let size: number;
    try {
      const s = await stat(path);
      if (!s.isFile()) return;
      size = s.size;
    } catch {
      return;
    }
    let d: Record<string, unknown> = {};
    if (size <= MAX_END_BYTES) {
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
    this.started(run.id, now, { name: cleanOrNull(str(d.workflowName), 120), summary: cleanOrNull(str(d.summary), 200), phases });
    const status = d.status === 'failed' || d.status === 'killed' ? d.status : 'completed';
    this.o.emit({ sessionId: this.o.sessionId, ts: now, source: 'fs', cwd: this.o.cwd, type: 'workflow.finished', runId: run.id, status });
    this.runs.delete(run.id);
    this.done.add(run.id);
  }

  /** A workflow.started with the fields that are known; with none, only when `bare` asks for the run alone. */
  private started(runId: string, now: number, f: { name?: string | null; summary?: string | null; phases?: string[] }, bare = false): void {
    const fields = { ...(f.name ? { name: f.name } : {}), ...(f.summary ? { summary: f.summary } : {}), ...(f.phases?.length ? { phases: f.phases } : {}) };
    if (!bare && Object.keys(fields).length === 0) return;
    this.o.emit({ sessionId: this.o.sessionId, ts: now, source: 'fs', cwd: this.o.cwd, type: 'workflow.started', runId, ...fields });
  }
}

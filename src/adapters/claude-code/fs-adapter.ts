import { access, readdir, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { RawEvent } from '../../core/types.js';
import type { BranchResolver, WorkspaceResolver } from '../git.js';
import { readHeadLines, readNewLines, readTailLines, type TailState } from './jsonl.js';
import { isSameProcess, psProbe, readSessionsDir, type LiveSessionFile, type ProcessProbe } from './sessions-dir.js';
import { parseTranscriptLine } from './transcript.js';
import { readAgentMeta, WorkflowScanner } from './workflows.js';

export interface FsAdapterOptions {
  claudeDir: string;
  emit: (e: RawEvent) => void;
  resolveWorkspace: WorkspaceResolver;
  /**
   * The branch a checkout is on, asked of git. A transcript's branch is only a hint: Claude Code stamps a session's lines
   * with the branch of the checkout it last looked at, a subagent's worktree while one runs. Without it, the transcript's
   * branch is taken as it is.
   */
  resolveBranch?: BranchResolver;
  /** How long a branch check that got no answer waits before it asks again; the wait doubles with each answer missed in a row. */
  branchRetryMs?: number;
  probe?: ProcessProbe;
  now?: () => number;
  /** A subagent transcript written within this window counts as running. */
  childFreshMs?: number;
  headBytes?: number;
  tailBytes?: number;
  subagentScanMs?: number;
  transcriptRetryMs?: number;
  /** Called once, after the first scan that completes, with the sessions whose process is alive: any other has exited. */
  onFirstScan?: (live: ReadonlySet<string>) => void;
  /** The workflow runs the collector holds as running on disk for a session, asked when the adapter starts tracking it. */
  openRuns?: (sessionId: string) => readonly string[];
  /** A session file whose working directory this matches is never tracked or announced: the summarizer's own sessions. */
  ignoreCwd?: (cwd: string) => boolean;
}

interface Tracked {
  file: LiveSessionFile;
  transcript: string | null;
  tail: TailState | null;
  /** The last branch the transcript stamped, and when. */
  branch: string | null;
  branchAt: number | null;
  /** The branch is to be checked: the stamp changed, or the last check got no answer. */
  branchStale: boolean;
  /** Checks in a row that got no answer, and when the next may ask. */
  branchMisses: number;
  branchRetryAt: number;
  /** The file git rewrites when the checkout's HEAD moves, and its identity when last checked: a switch the transcript does not show changes it. */
  watch: string | null;
  watchId: string | null;
  /** The last branch reported. */
  reportedBranch: string | null;
  statusAt: number | null;
  children: Map<string, boolean>;
  metas: Map<string, { type: string; description: string | null }>;
  workflows: WorkflowScanner;
  lastSubagentScan: number;
  lastTranscriptLookup: number;
  ended: boolean;
}

/** Claude Code names a project directory after its cwd with every non-alphanumeric character replaced by '-'. Older versions differ, so lookups fall back to a scan. */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/** A session's directory, next to its transcript: its subagents and workflow runs live there. */
function sessionDirOf(transcript: string): string {
  return join(dirname(transcript), basename(transcript, '.jsonl'));
}

const BRANCH_RETRY_MAX_MS = 5 * 60_000;

/** A file's inode and mtime: git replaces the files it watches by renaming, so two writes within one mtime tick still differ. */
async function fileId(path: string): Promise<string | null> {
  try {
    const s = await stat(path);
    return `${s.ino}:${s.mtimeMs}`;
  } catch {
    return null;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export class FsAdapter {
  private readonly tracked = new Map<string, Tracked>();
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private scanned = false;
  private readonly now: () => number;
  private readonly probe: ProcessProbe;

  constructor(private readonly o: FsAdapterOptions) {
    this.now = o.now ?? Date.now;
    this.probe = o.probe ?? psProbe;
  }

  start(intervalMs = 1000): void {
    if (this.timer) return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One scan. Overlapping calls are skipped. Never throws. */
  async poll(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.scan();
    } catch {
      // keep polling; a bad scan must not stop the adapter
    } finally {
      this.busy = false;
    }
  }

  private async scan(): Promise<void> {
    const now = this.now();
    const files = await readSessionsDir(join(this.o.claudeDir, 'sessions'));
    if (!files) return;
    const starts = await this.probe(files.map((f) => f.pid), now);
    // A scan that could not read looks like "no live session": it changes nothing, so it cannot end any.
    if (!starts) return;
    const live = new Set<string>();

    for (const f of files) {
      if (!isSameProcess(f, starts.get(f.pid)) || live.has(f.sessionId) || this.o.ignoreCwd?.(f.cwd)) continue;
      live.add(f.sessionId);
      let t = this.tracked.get(f.sessionId);
      if (!t || t.ended) {
        t = await this.discover(f, now);
        this.tracked.set(f.sessionId, t);
      }
      t.file = f;
      if (f.status && f.statusUpdatedAt !== null && f.statusUpdatedAt !== t.statusAt) {
        t.statusAt = f.statusUpdatedAt;
        this.o.emit({ type: 'session.status', sessionId: f.sessionId, ts: f.statusUpdatedAt, source: 'fs', cwd: f.cwd, status: f.status, waitingFor: f.waitingFor });
      }
      await this.follow(t, now);
      await this.checkBranch(t, now);
      await this.scanSubagents(t, now);
    }

    for (const [id, t] of this.tracked) {
      if (t.ended || live.has(id)) continue;
      t.ended = true;
      // A run that ended just before its process did left its end file: it is read before the session ends.
      if (t.transcript) await t.workflows.scan(sessionDirOf(t.transcript), now);
      this.o.emit({ type: 'session.ended', sessionId: id, ts: now, source: 'fs', cwd: t.file.cwd, reason: 'process-gone' });
    }

    if (!this.scanned) {
      this.scanned = true;
      this.o.onFirstScan?.(live);
    }
  }

  private async announce(f: LiveSessionFile, transcript: string | null, now: number): Promise<void> {
    const workspace = await this.o.resolveWorkspace(f.cwd);
    this.o.emit({
      type: 'session.seen',
      sessionId: f.sessionId,
      ts: f.startedAt || now,
      source: 'fs',
      cwd: f.cwd,
      workspace,
      pid: f.pid,
      name: f.name,
      tmuxPane: f.tmuxPane,
      tmuxSession: f.tmuxSession,
      transcriptPath: transcript,
      startedAt: f.startedAt || now,
    });
  }

  private async discover(f: LiveSessionFile, now: number): Promise<Tracked> {
    const transcript = await this.findTranscript(f.sessionId, f.cwd);
    const t: Tracked = {
      file: f,
      transcript,
      tail: null,
      branch: null,
      branchAt: null,
      // The first check finds the checkout's HEAD file, to watch from then on.
      branchStale: true,
      branchMisses: 0,
      branchRetryAt: 0,
      watch: null,
      watchId: null,
      reportedBranch: null,
      statusAt: null,
      children: new Map(),
      metas: new Map(),
      // A session file that does not say when its process started: runs count from when the session was first seen.
      workflows: new WorkflowScanner({ sessionId: f.sessionId, cwd: f.cwd, since: f.startedAt || now, open: this.o.openRuns?.(f.sessionId) ?? [], emit: this.o.emit }),
      lastSubagentScan: 0,
      lastTranscriptLookup: now,
      ended: false,
    };
    await this.announce(f, transcript, now);
    if (transcript) await this.backfill(t, transcript);
    return t;
  }

  private async backfill(t: Tracked, path: string): Promise<void> {
    const headBytes = this.o.headBytes ?? 64 * 1024;
    const tailBytes = this.o.tailBytes ?? 512 * 1024;
    let size: number;
    try {
      size = (await stat(path)).size;
    } catch {
      return;
    }
    if (size > headBytes + tailBytes) {
      for (const line of await readHeadLines(path, headBytes)) this.handleLine(t, line);
      const { lines, offset } = await readTailLines(path, tailBytes);
      for (const line of lines) this.handleLine(t, line);
      t.tail = { path, offset, skipping: false };
    } else {
      t.tail = { path, offset: 0, skipping: false };
      await this.drain(t);
    }
  }

  private async follow(t: Tracked, now: number): Promise<void> {
    if (t.tail) {
      await this.drain(t);
      return;
    }
    if (now - t.lastTranscriptLookup < (this.o.transcriptRetryMs ?? 5000)) return;
    t.lastTranscriptLookup = now;
    const found = await this.findTranscript(t.file.sessionId, t.file.cwd);
    if (!found) return;
    t.transcript = found;
    await this.announce(t.file, found, now);
    // The announce's workspace may be a cached one, older than the branch reported since: the branch is reported again.
    t.reportedBranch = null;
    t.branchStale = true;
    await this.backfill(t, found);
  }

  private async drain(t: Tracked): Promise<void> {
    for (let i = 0; i < 8 && t.tail; i++) {
      const { lines, state } = await readNewLines(t.tail);
      t.tail = state;
      for (const line of lines) this.handleLine(t, line);
      if (lines.length === 0) break;
    }
  }

  private handleLine(t: Tracked, line: string): void {
    const parsed = parseTranscriptLine(line, t.file.sessionId, t.file.cwd);
    for (const e of parsed.events) this.o.emit({ ...e, cwd: t.file.cwd });
    for (const launch of parsed.launches ?? []) t.workflows.noteLaunch(launch);
    if (parsed.branch && parsed.branch !== t.branch) {
      t.branch = parsed.branch;
      t.branchAt = parsed.ts ?? this.now();
      t.branchStale = true;
    }
  }

  /**
   * Reports the session's branch once the stamp changed or the checkout's HEAD moved: the checkout says whether the
   * session moved, or a subagent's worktree only lent its branch. Git is asked at most once a scan, however many lines
   * the scan read.
   */
  private async checkBranch(t: Tracked, now: number): Promise<void> {
    if (!this.o.resolveBranch) {
      if (t.branchStale && t.branch) this.reportBranch(t, t.branch, t.branchAt ?? now);
      t.branchStale = false;
      return;
    }
    const id = t.watch ? await fileId(t.watch) : null;
    if (!t.branchStale && id === t.watchId) return;
    if (now < t.branchRetryAt) return;
    const found = await this.o.resolveBranch(t.file.cwd).catch(() => null);
    if (!found) {
      // Asked again later, as a stamp is not repeated and a HEAD that moved does not move again. Outside git, in a
      // checkout that is gone, or with a git that hangs, the answer stays missing: the waits grow, to five minutes.
      t.branchStale = true;
      t.branchMisses++;
      t.branchRetryAt = now + Math.min((this.o.branchRetryMs ?? 5000) * 2 ** (t.branchMisses - 1), BRANCH_RETRY_MAX_MS);
      return;
    }
    t.branchStale = false;
    t.branchMisses = 0;
    t.watchId = found.watch === t.watch ? id : await fileId(found.watch);
    t.watch = found.watch;
    // The stamp's time when the checkout confirms the stamp, else now: the answer is about the checkout as it is.
    this.reportBranch(t, found.branch, found.branch === t.branch && t.branchAt !== null ? t.branchAt : now);
  }

  private reportBranch(t: Tracked, branch: string, ts: number): void {
    if (branch === t.reportedBranch) return;
    t.reportedBranch = branch;
    this.o.emit({ type: 'branch', sessionId: t.file.sessionId, ts, source: 'fs', cwd: t.file.cwd, branch });
  }

  private async findTranscript(sessionId: string, cwd: string): Promise<string | null> {
    const projects = join(this.o.claudeDir, 'projects');
    const direct = join(projects, encodeProjectDir(cwd), `${sessionId}.jsonl`);
    if (await exists(direct)) return direct;
    let dirs: string[];
    try {
      dirs = await readdir(projects);
    } catch {
      return null;
    }
    for (const d of dirs) {
      const candidate = join(projects, d, `${sessionId}.jsonl`);
      if (await exists(candidate)) return candidate;
    }
    return null;
  }

  private async scanSubagents(t: Tracked, now: number): Promise<void> {
    if (!t.transcript || now - t.lastSubagentScan < (this.o.subagentScanMs ?? 3000)) return;
    t.lastSubagentScan = now;
    const sessionDir = sessionDirOf(t.transcript);
    await this.scanChildren(t, join(sessionDir, 'subagents'), now);
    await t.workflows.scan(sessionDir, now);
  }

  private async scanChildren(t: Tracked, dir: string, now: number): Promise<void> {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    const freshMs = this.o.childFreshMs ?? 90_000;
    for (const name of names) {
      const m = name.match(/^agent-(.+)\.jsonl$/);
      if (!m) continue;
      const id = m[1]!;
      let mtime: number;
      try {
        mtime = (await stat(join(dir, name))).mtimeMs;
      } catch {
        continue;
      }
      const running = now - mtime < freshMs;
      const was = t.children.get(id) ?? false;
      if (running && !was) {
        const meta = await this.readMeta(t, dir, id);
        this.o.emit({ type: 'agent.started', sessionId: t.file.sessionId, ts: mtime, source: 'fs', cwd: t.file.cwd, agentId: id, agentType: meta.type, description: meta.description });
      } else if (!running && was) {
        this.o.emit({ type: 'agent.finished', sessionId: t.file.sessionId, ts: mtime, source: 'fs', cwd: t.file.cwd, agentId: id });
      }
      t.children.set(id, running);
    }
  }

  private async readMeta(t: Tracked, dir: string, id: string): Promise<{ type: string; description: string | null }> {
    const cached = t.metas.get(id);
    if (cached) return cached;
    let meta = { type: 'agent', description: null as string | null };
    try {
      const d = (await readAgentMeta(join(dir, `agent-${id}.meta.json`))) as Record<string, unknown> | null;
      meta = {
        type: typeof d?.agentType === 'string' && d.agentType ? d.agentType : 'agent',
        description: typeof d?.description === 'string' && d.description ? d.description : null,
      };
    } catch {
      // no meta file, or one that is not JSON: keep the defaults
    }
    t.metas.set(id, meta);
    return meta;
  }
}

import { access, readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { RawEvent } from '../../core/types.js';
import type { WorkspaceResolver } from '../git.js';
import { readHeadLines, readNewLines, readTailLines, type TailState } from './jsonl.js';
import { isSameProcess, psProbe, readSessionsDir, type LiveSessionFile, type ProcessProbe } from './sessions-dir.js';
import { parseTranscriptLine } from './transcript.js';

export interface FsAdapterOptions {
  claudeDir: string;
  emit: (e: RawEvent) => void;
  resolveWorkspace: WorkspaceResolver;
  probe?: ProcessProbe;
  now?: () => number;
  /** A subagent transcript written within this window counts as running. */
  childFreshMs?: number;
  headBytes?: number;
  tailBytes?: number;
  subagentScanMs?: number;
  transcriptRetryMs?: number;
}

interface Tracked {
  file: LiveSessionFile;
  transcript: string | null;
  tail: TailState | null;
  branch: string | null;
  statusAt: number | null;
  children: Map<string, boolean>;
  metas: Map<string, { type: string; description: string | null }>;
  lastSubagentScan: number;
  lastTranscriptLookup: number;
  ended: boolean;
}

/** Claude Code names a project directory after its cwd with every non-alphanumeric character replaced by '-'. Older versions differ, so lookups fall back to a scan. */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
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
    const starts = await this.probe(files.map((f) => f.pid), now);
    const live = new Set<string>();

    for (const f of files) {
      if (!isSameProcess(f, starts.get(f.pid)) || live.has(f.sessionId)) continue;
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
      await this.scanSubagents(t, now);
    }

    for (const [id, t] of this.tracked) {
      if (t.ended || live.has(id)) continue;
      t.ended = true;
      this.o.emit({ type: 'session.ended', sessionId: id, ts: now, source: 'fs', cwd: t.file.cwd, reason: 'process-gone' });
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
      statusAt: null,
      children: new Map(),
      metas: new Map(),
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
    if (parsed.branch && parsed.branch !== t.branch) {
      t.branch = parsed.branch;
      this.o.emit({ type: 'branch', sessionId: t.file.sessionId, ts: parsed.ts ?? this.now(), source: 'fs', cwd: t.file.cwd, branch: parsed.branch });
    }
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
    const dir = join(dirname(t.transcript), basename(t.transcript, '.jsonl'), 'subagents');
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
      const d = JSON.parse(await readFile(join(dir, `agent-${id}.meta.json`), 'utf8')) as Record<string, unknown>;
      meta = {
        type: typeof d.agentType === 'string' && d.agentType ? d.agentType : 'agent',
        description: typeof d.description === 'string' && d.description ? d.description : null,
      };
    } catch {
      // no meta file: keep the defaults
    }
    t.metas.set(id, meta);
    return meta;
  }
}

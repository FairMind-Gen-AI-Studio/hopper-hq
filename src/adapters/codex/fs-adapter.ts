import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { RawEvent } from '../../core/types.js';
import type { WorkspaceResolver } from '../git.js';
import { readHeadLines, readNewLines, type TailState } from '../claude-code/jsonl.js';
import { CODEX_VERSIONS, codexSessionId, parseRolloutLine, rolloutMeta, type RolloutMeta } from './rollout.js';

interface Tracked { meta: RolloutMeta; tail: TailState; refreshed: number }
export interface CodexAdapterOptions {
  codexDir: string;
  emit: (event: RawEvent) => void;
  resolveWorkspace: WorkspaceResolver;
  ignoreCwd?: (cwd: string) => boolean;
  now?: () => number;
  log?: (line: string) => void;
}

/** Read-only rollout discovery. No file recency heuristic claims that a CLI process is alive or awaiting permission. */
export class CodexAdapter {
  readonly agentKind = 'codex' as const;
  readonly verifiedVersions = CODEX_VERSIONS;
  skipped = 0;
  private readonly tracked = new Map<string, Tracked>();
  private readonly warned = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private lastDiscovery: number | null = null;
  private readonly excluded = new Map<string, number>();
  constructor(private readonly o: CodexAdapterOptions) {}
  start(intervalMs = 1000): void {
    if (this.timer) return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), intervalMs);
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }
  async poll(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const now = (this.o.now ?? Date.now)();
      const skipped = this.skipped;
      if (this.lastDiscovery === null || now - this.lastDiscovery >= 10_000) {
        this.lastDiscovery = now;
        await this.scan(join(this.o.codexDir, 'sessions'));
      }
      for (const path of this.tracked.keys()) {
        try { await this.follow(path); } catch { /* Continue following the other sessions. */ }
      }
      if (this.skipped > skipped) this.o.log?.(`Codex skipped ${this.skipped - skipped} unsupported or malformed records (${this.skipped} total)`);
    }
    catch (err) { this.o.log?.(`Codex scan unavailable: ${err instanceof Error ? err.message : String(err)}`); }
    finally { this.busy = false; }
  }
  private async scan(dir: string, depth = 0): Promise<void> {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory() && depth < 3 && /^\d{2,4}$/.test(entry.name)) await this.scan(path, depth + 1);
      else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
        if (this.tracked.has(path)) continue;
        try {
          const modified = (await stat(path)).mtimeMs;
          if (modified < (this.o.now ?? Date.now)() - 7 * 86400_000 || this.excluded.get(path) === modified) continue;
          await this.follow(path);
          if (!this.tracked.has(path)) this.excluded.set(path, modified);
        } catch { /* A disappearing or unreadable file cannot stop other sessions. */ }
      }
    }
  }
  private async follow(path: string): Promise<void> {
    const now = (this.o.now ?? Date.now)();
    let t = this.tracked.get(path);
    if (!t) {
      const meta = (await readHeadLines(path)).map(rolloutMeta).find(m => m !== null);
      if (!meta || this.o.ignoreCwd?.(meta.cwd)) return;
      // The store retains a week; old historical sessions must not repopulate dormant floors forever.
      if ((await stat(path)).mtimeMs < now - 7 * 86400_000) return;
      t = { meta, tail: { path, offset: 0, skipping: false }, refreshed: now };
      this.tracked.set(path, t);
      if (!(CODEX_VERSIONS as readonly string[]).includes(meta.version) && !this.warned.has(meta.version)) {
        this.warned.add(meta.version);
        this.o.log?.(`Codex ${meta.version || 'unknown'}: rollout format unverified; unsupported records will be skipped`);
      }
      this.o.emit({ type: 'session.seen', agentKind: 'codex', sessionId: codexSessionId(meta.id), ts: meta.ts, source: 'fs', cwd: meta.cwd, workspace: await this.o.resolveWorkspace(meta.cwd), transcriptPath: path, startedAt: meta.ts });

    }
    if (!this.o.ignoreCwd?.(t.meta.cwd) && now - t.refreshed >= 5000) {
      t.refreshed = now;
      this.o.emit({ type: 'session.seen', agentKind: 'codex', sessionId: codexSessionId(t.meta.id), ts: now, source: 'fs', cwd: t.meta.cwd, workspace: await this.o.resolveWorkspace(t.meta.cwd), transcriptPath: path });
    }
    const next = await readNewLines(t.tail);
    if (next.state.skipping && !t.tail.skipping) this.skipped++;
    t.tail = next.state;
    for (const line of next.lines) await this.handle(t, line);
  }
  private async handle(t: Tracked, line: string): Promise<void> {
    const result = parseRolloutLine(line, { sessionId: codexSessionId(t.meta.id), cwd: t.meta.cwd });
    this.skipped += result.skipped;
    if (result.cwd && result.cwd !== t.meta.cwd) {
      t.meta.cwd = result.cwd;
      if (!this.o.ignoreCwd?.(result.cwd)) this.o.emit({ type: 'session.seen', agentKind: 'codex', sessionId: codexSessionId(t.meta.id), ts: t.meta.ts, source: 'fs', cwd: result.cwd, workspace: await this.o.resolveWorkspace(result.cwd), transcriptPath: t.tail.path });
    }
    if (!this.o.ignoreCwd?.(t.meta.cwd)) for (const event of result.events) this.o.emit(event);
  }
}

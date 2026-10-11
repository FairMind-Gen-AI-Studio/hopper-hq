import type { WorkspaceResolver } from './adapters/git.js';
import { DEFAULT_THRESHOLDS, type Thresholds } from './config.js';
import { DEFAULT_FEATURE_RULES, deriveFeature, type FeatureRules } from './core/feature.js';
import { applyEvent, markSeen } from './core/reducer.js';
import type { CollectorEvent, EventSourceKind, RawEvent, Session, WaitReason } from './core/types.js';
import { buildAttention, buildFloors, floorKeyOf, toView, type Attention, type Floor, type SessionView } from './core/view.js';
import { cleanOrNull, cleanText, taskTitle } from './scene/text.js';
import type { Store } from './store/store.js';

export interface Snapshot {
  generatedAt: number;
  floors: Floor[];
  attention: Attention;
}

export interface AttentionItem {
  id: string;
  name: string | null;
  repo: string;
  feature: string | null;
  state: 'needs_you' | 'done';
  since: number;
  reason: WaitReason | null;
  title: string | null;
  tmuxPane: string | null;
}

export interface AttentionSummary {
  generatedAt: number;
  needsYou: number;
  done: number;
  items: AttentionItem[];
}

function cleanReason(r: WaitReason): WaitReason {
  const detail = cleanOrNull(r.detail);
  return { kind: r.kind, text: cleanText(r.text), ...(detail ? { detail } : {}) };
}

export interface CollectorOptions {
  resolveWorkspace: WorkspaceResolver;
  store?: Store | null;
  now?: () => number;
  thresholds?: Thresholds;
  featureRules?: FeatureRules;
  /** When set, events from other sources are ignored. */
  acceptSources?: EventSourceKind[];
  saveDelayMs?: number;
  log?: (line: string) => void;
}

export class Collector {
  private readonly sessions = new Map<string, Session>();
  private readonly listeners = new Set<() => void>();
  private readonly dirty = new Set<string>();
  /** When each floor key was first seen: set once, never moved, so floors keep their place. */
  private readonly firstSeen = new Map<string, number>();
  /** First-seen times not yet written to the store. */
  private newFloors: Array<[string, number]> = [];
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private seq = 0;
  private queue: Promise<void> = Promise.resolve();
  private saveTimer: NodeJS.Timeout | null = null;
  dropped = 0;

  constructor(private readonly o: CollectorOptions) {
    this.now = o.now ?? Date.now;
    this.log = o.log ?? ((line) => process.stderr.write(line + '\n'));
    for (const [key, at] of o.store?.loadFloors() ?? []) this.firstSeen.set(key, at);
    for (const s of o.store?.loadSessions() ?? []) {
      this.sessions.set(s.id, s);
      this.seq = Math.max(this.seq, s.lastSeq + 1);
    }
    // Sessions saved before floors were recorded: each floor opened when its earliest live session started.
    const opened = new Map<string, number>();
    for (const s of this.sessions.values()) {
      if (s.state === 'ended') continue;
      const key = this.floorKey(s);
      if (!this.firstSeen.has(key)) opened.set(key, Math.min(opened.get(key) ?? s.startedAt, s.startedAt));
    }
    for (const [key, at] of opened) this.openFloor(key, at);
  }

  private floorKey(s: Session): string {
    return floorKeyOf({ workspace: s.workspace, feature: deriveFeature(s.workspace.branch, s.workspace.repoName, this.o.featureRules ?? DEFAULT_FEATURE_RULES) });
  }

  private openFloor(key: string, at: number): void {
    this.firstSeen.set(key, at);
    this.newFloors.push([key, at]);
  }

  ingest(raw: RawEvent): Promise<void> {
    if (this.o.acceptSources && !this.o.acceptSources.includes(raw.source)) return this.queue;
    const e = { ...raw, seq: this.seq++ } as CollectorEvent;
    this.queue = this.queue.then(() => this.apply(e)).catch(() => {
      this.dropped++;
    });
    return this.queue;
  }

  /** Resolves when every event ingested so far has been applied. */
  idle(): Promise<void> {
    return this.queue;
  }

  private async apply(e: CollectorEvent): Promise<void> {
    let prev = this.sessions.get(e.sessionId);
    let created = false;
    if (!prev && e.type !== 'session.seen') {
      if (!e.cwd) {
        this.dropped++;
        return;
      }
      const workspace = await this.o.resolveWorkspace(e.cwd);
      prev = applyEvent(undefined, { type: 'session.seen', sessionId: e.sessionId, ts: e.ts, seq: e.seq, source: e.source, cwd: e.cwd, workspace, startedAt: e.ts });
      created = true;
    }
    const next = applyEvent(prev, e);
    if (!next) {
      this.dropped++;
      return;
    }
    this.o.store?.appendEvent(e);
    if (created || next !== prev) {
      this.sessions.set(next.id, next);
      // The event that first puts a session on a floor opens it: a new session, a branch switch, a replayed old event.
      if (next.state !== 'ended') {
        const key = this.floorKey(next);
        if (!this.firstSeen.has(key)) this.openFloor(key, e.ts);
      }
      this.changed(next.id);
    }
  }

  private changed(id: string): void {
    this.dirty.add(id);
    if (!this.saveTimer) this.saveTimer = setTimeout(() => this.save(), this.o.saveDelayMs ?? 500);
    for (const fn of this.listeners) fn();
  }

  /** The timer's save. A store error must not take the daemon down: the sessions stay changed and go with the next save. */
  private save(): void {
    try {
      this.flush();
    } catch (err) {
      this.log(`scranton-hq could not save sessions: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Writes changed sessions to the store now. */
  flush(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const list = [...this.dirty].map((id) => this.sessions.get(id)).filter((s): s is Session => s !== undefined);
    if (list.length) this.o.store?.saveSessions(list, this.now());
    this.dirty.clear();
    if (this.newFloors.length) {
      this.o.store?.recordFloors(this.newFloors);
      this.newFloors = [];
    }
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  views(): SessionView[] {
    const now = this.now();
    const t = this.o.thresholds ?? DEFAULT_THRESHOLDS;
    const rules = this.o.featureRules ?? DEFAULT_FEATURE_RULES;
    return [...this.sessions.values()].map((s) => toView(s, now, t, rules));
  }

  snapshot(): Snapshot {
    const views = this.views();
    return { generatedAt: this.now(), floors: buildFloors(views, this.firstSeen), attention: buildAttention(views) };
  }

  attentionSummary(): AttentionSummary {
    const a = buildAttention(this.views());
    // Feeds the band above every prompt and `status`: names, titles and reasons are cleaned like everything shown.
    const item = (v: SessionView, state: 'needs_you' | 'done'): AttentionItem => ({
      id: v.id,
      name: cleanOrNull(v.name),
      repo: cleanText(v.workspace.repoName),
      feature: cleanOrNull(v.feature),
      state,
      since: v.effectiveSince,
      reason: v.waitReason && cleanReason(v.waitReason),
      title: taskTitle(v),
      tmuxPane: v.tmuxPane,
    });
    return {
      generatedAt: this.now(),
      needsYou: a.needsYou.length,
      done: a.done.length,
      items: [...a.needsYou.map((v) => item(v, 'needs_you')), ...a.done.map((v) => item(v, 'done'))],
    };
  }

  /** Marks a finished session as seen. False when the session is unknown or not 'done'. */
  markSeen(id: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    const view = toView(s, this.now(), this.o.thresholds ?? DEFAULT_THRESHOLDS, this.o.featureRules ?? DEFAULT_FEATURE_RULES);
    if (view.effectiveState !== 'done') return false;
    this.sessions.set(id, markSeen(s, this.now()));
    this.changed(id);
    return true;
  }

  markAllSeen(): number {
    let n = 0;
    for (const id of [...this.sessions.keys()]) if (this.markSeen(id)) n++;
    return n;
  }

  async close(): Promise<void> {
    await this.queue;
    this.flush();
  }
}

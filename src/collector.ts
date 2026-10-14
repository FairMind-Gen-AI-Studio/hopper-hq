import type { WorkspaceResolver } from './adapters/git.js';
import { DEFAULT_THRESHOLDS, type Thresholds } from './config.js';
import { DEFAULT_FEATURE_RULES, deriveFeature, type FeatureRules } from './core/feature.js';
import { applyEvent, markSeen, normalizeSession, settleRestored } from './core/reducer.js';
import type { CollectorEvent, EventSourceKind, RawEvent, Session, SessionSummary, WaitReason } from './core/types.js';
import { buildAttention, buildFloors, floorKeyOf, toView, type Attention, type Floor, type SessionView } from './core/view.js';
import { buildFloorDetail, buildScene } from './scene/build.js';
import { parseSeating, seatFloor, type Seating } from './scene/seating.js';
import { cleanOrNull, cleanText, isSessionId, taskTitle } from './scene/text.js';
import type { BuildingScene, FloorDetail } from './scene/types.js';
import type { FloorRecord, Store } from './store/store.js';

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
  /** The tmux session the pane is in, as Claude Code wrote it; null when unknown. Not cleaned: the mod compares it with what tmux says. */
  tmuxSession: string | null;
}

export interface AttentionSummary {
  generatedAt: number;
  needsYou: number;
  done: number;
  items: AttentionItem[];
}

function cleanReason(r: WaitReason): WaitReason {
  const detail = cleanOrNull(r.detail);
  return { kind: r.kind, text: cleanText(r.text) || 'Needs you', ...(detail ? { detail } : {}) };
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
  /** Events from a working directory this matches are dropped as they arrive: the summarizer's own sessions. */
  ignoreCwd?: (cwd: string) => boolean;
  /**
   * The sessions restored from the store that a session file showed keep the subagents that ran, and the meeting those
   * hold, until settleRestored() runs after the first filesystem scan: the scan reports on them first. Without it, and
   * for every other session, they stop as they are restored.
   */
  holdRestored?: boolean;
}

export class Collector {
  private readonly sessions = new Map<string, Session>();
  private readonly listeners = new Set<() => void>();
  private readonly sessionListeners = new Set<(prev: Session | undefined, next: Session) => void>();
  private readonly dirty = new Set<string>();
  /**
   * When each floor key was first seen: set once, so a floor keeps its place while sessions sit on it. A floor no session
   * sits on any more is forgotten, so that it opens on top when it comes back.
   */
  private readonly firstSeen = new Map<string, number>();
  /**
   * Who sits where on each floor. It moves on as the scene is read (seat), since time-derived states exist only then; it
   * is saved with the floor and forgotten with it, so a floor that comes back opens at the base plan.
   */
  private readonly seating = new Map<string, Seating>();
  /** How many sessions that have not ended sit on each floor. Dormant ones count. */
  private readonly occupants = new Map<string, number>();
  /** Floors opened, forgotten or seated anew since the last save. */
  private readonly dirtyFloors = new Set<string>();
  /** Local sessions restored from the store that a session file once showed (they have a pid) and that no source has reported since: whether their process still runs is not known yet. */
  private readonly unconfirmed = new Set<string>();
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private seq = 0;
  private queue: Promise<void> = Promise.resolve();
  private saveTimer: NodeJS.Timeout | null = null;
  dropped = 0;
  /** Events dropped because their working directory is ignored. */
  ignored = 0;

  constructor(private readonly o: CollectorOptions) {
    this.now = o.now ?? Date.now;
    this.log = o.log ?? ((line) => process.stderr.write(line + '\n'));
    for (const [key, floor] of o.store?.loadFloors() ?? []) {
      this.firstSeen.set(key, floor.firstSeen);
      // A seating that does not read back is dropped: the floor's first read seats it again.
      const seating = floor.plan === null ? null : parseSeating(floor.plan);
      if (seating) this.seating.set(key, seating);
    }
    let skipped = 0;
    for (const s of o.store?.loadSessions() ?? []) {
      // Saved before ids were checked: such a session could not be named in a URL.
      if (!isSessionId(s.id)) {
        skipped++;
        continue;
      }
      const fromFile = s.location === 'local' && s.state !== 'ended' && s.pid !== null;
      const restored = normalizeSession(s);
      this.sessions.set(s.id, fromFile && o.holdRestored ? restored : settleRestored(restored));
      this.seq = Math.max(this.seq, s.lastSeq + 1);
      if (fromFile) this.unconfirmed.add(s.id);
    }
    // Their rows stay in the store, which keeps every session: say how many, once.
    if (skipped > 0) this.log(`hopper-hq skipped ${skipped === 1 ? '1 saved session whose id is' : `${skipped} saved sessions whose ids are`} not valid`);
    // Sessions saved before floors were recorded: each floor opened when its earliest live session started.
    const opened = new Map<string, number>();
    for (const s of this.sessions.values()) {
      const key = this.liveKey(s);
      if (key === null) continue;
      this.occupants.set(key, (this.occupants.get(key) ?? 0) + 1);
      if (!this.firstSeen.has(key)) opened.set(key, Math.min(opened.get(key) ?? s.startedAt, s.startedAt));
    }
    for (const [key, at] of opened) this.openFloor(key, at);
    // A floor recorded with no live session on it any more is forgotten, as if its last session had just left.
    for (const key of [...this.firstSeen.keys()]) if (!this.occupants.has(key)) this.forgetFloor(key);
  }

  private floorKey(s: Session): string {
    return floorKeyOf({ workspace: s.workspace, feature: deriveFeature(s.workspace.branch, s.workspace.repoName, this.o.featureRules ?? DEFAULT_FEATURE_RULES) });
  }

  /** The floor a session sits on; null once it has ended. */
  private liveKey(s: Session | undefined): string | null {
    return s && s.state !== 'ended' ? this.floorKey(s) : null;
  }

  private openFloor(key: string, at: number): void {
    this.firstSeen.set(key, at);
    this.dirtyFloors.add(key);
  }

  private forgetFloor(key: string): void {
    this.firstSeen.delete(key);
    this.seating.delete(key);
    this.dirtyFloors.add(key);
  }

  /** A session leaves one floor for another (null: none). Its first occupant opens a floor; its last one leaving forgets it. */
  private moveSeat(from: string | null, to: string | null, at: number): void {
    if (from === to) return;
    if (from !== null) {
      const left = (this.occupants.get(from) ?? 1) - 1;
      if (left > 0) this.occupants.set(from, left);
      else {
        this.occupants.delete(from);
        this.forgetFloor(from);
      }
    }
    if (to !== null) {
      this.occupants.set(to, (this.occupants.get(to) ?? 0) + 1);
      if (!this.firstSeen.has(to)) this.openFloor(to, at);
    }
  }

  ingest(raw: RawEvent): Promise<void> {
    if (this.o.acceptSources && !this.o.acceptSources.includes(raw.source)) return this.queue;
    if (!isSessionId(raw.sessionId)) {
      this.dropped++;
      return this.queue;
    }
    if (raw.cwd !== undefined && this.o.ignoreCwd?.(raw.cwd)) {
      this.ignored++;
      return this.queue;
    }
    // A source that reports a session has seen it alive since the daemon started.
    this.unconfirmed.delete(raw.sessionId);
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

  /**
   * Ends the sessions restored from the store that no source has reported since and that `live` does not hold: their
   * process exited while the daemon was down, so no adapter saw them go, and they would hold their floors for good. Only
   * sessions a session file showed (with a pid) are judged: one seen only through hooks is left to its own end event.
   * Each ends as of its last event, so anything newer still wins. Only the first call finds any.
   */
  endGone(live: ReadonlySet<string>): void {
    const gone = [...this.unconfirmed].filter((id) => !live.has(id));
    this.unconfirmed.clear();
    for (const id of gone) {
      const s = this.sessions.get(id)!;
      void this.ingest({ type: 'session.ended', sessionId: id, ts: Math.max(s.lastEventAt, s.startedAt), source: 'fs', cwd: s.workspace.cwd, reason: 'process-gone' });
    }
  }

  /**
   * Stops the restored subagents that no source has reported on since the restart, and ends a meeting only they held as
   * of when it began. Called once the first filesystem scan has looked at them: it comes after the events ingested so
   * far, the scan's among them. Only the first call finds any.
   */
  settleRestored(): Promise<void> {
    this.queue = this.queue
      .then(() => {
        for (const prev of [...this.sessions.values()]) {
          const next = settleRestored(prev);
          if (next === prev) continue;
          this.sessions.set(next.id, next);
          this.changed(next.id);
          this.sessionChanged(prev, next);
        }
      })
      .catch((err: unknown) => this.log(`hopper-hq could not settle restored subagents: ${err instanceof Error ? err.message : String(err)}`));
    return this.queue;
  }

  private async apply(e: CollectorEvent): Promise<void> {
    const stored = this.sessions.get(e.sessionId);
    let prev = stored;
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
    // A reply's text lives in the session row only, never in the event log.
    if (e.type !== 'answer') this.o.store?.appendEvent(e);
    if (created || next !== prev) {
      this.sessions.set(next.id, next);
      // The event that first puts a session on a floor opens it: a new session, a branch switch, a replayed old event.
      // Only a new workspace or an end can move a session to another floor.
      if (!stored || stored.workspace !== next.workspace || (stored.state === 'ended') !== (next.state === 'ended')) {
        this.moveSeat(this.liveKey(stored), this.liveKey(next), e.ts);
      }
      this.changed(next.id);
      this.sessionChanged(stored, next);
    }
  }

  /** Tells the session listeners. One that throws neither stops the others nor the event. */
  private sessionChanged(prev: Session | undefined, next: Session): void {
    for (const fn of this.sessionListeners) {
      try {
        fn(prev, next);
      } catch (err) {
        this.log(`hopper-hq session listener failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private changed(id: string): void {
    this.dirty.add(id);
    this.scheduleSave();
    for (const fn of this.listeners) fn();
  }

  private scheduleSave(): void {
    if (!this.saveTimer) this.saveTimer = setTimeout(() => this.save(), this.o.saveDelayMs ?? 500);
  }

  /**
   * Moves every floor's seating on to the sessions in `views`, and saves the floors whose seating changed. A read, not a
   * change: the change listeners are not told.
   */
  private seat(views: readonly SessionView[]): ReadonlyMap<string, Seating> {
    for (const floor of buildFloors(views, this.firstSeen)) {
      const prev = this.seating.get(floor.key);
      const next = seatFloor(prev ?? null, floor);
      if (next === prev) continue;
      this.seating.set(floor.key, next);
      this.dirtyFloors.add(floor.key);
      this.scheduleSave();
    }
    return this.seating;
  }

  /** The timer's save. A store error must not take the daemon down: sessions and floors stay changed and go with the next save. */
  private save(): void {
    try {
      this.flush();
    } catch (err) {
      this.log(`hopper-hq could not save sessions and floors: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Writes changed sessions and floors to the store now, in one transaction. */
  flush(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const list = [...this.dirty].map((id) => this.sessions.get(id)).filter((s): s is Session => s !== undefined);
    const floors = new Map(
      [...this.dirtyFloors].map((key): [string, FloorRecord | null] => {
        const firstSeen = this.firstSeen.get(key);
        const seating = this.seating.get(key);
        return [key, firstSeen === undefined ? null : { firstSeen, plan: seating ? JSON.stringify(seating) : null }];
      }),
    );
    if (list.length || floors.size) this.o.store?.save(list, floors, this.now());
    this.dirty.clear();
    this.dirtyFloors.clear();
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** Calls `fn` with the previous and the new value each time a session changes; `prev` is undefined for a new one. */
  onSessionChange(fn: (prev: Session | undefined, next: Session) => void): () => void {
    this.sessionListeners.add(fn);
    return () => {
      this.sessionListeners.delete(fn);
    };
  }

  /** A session as the collector holds it, ended or not; null when it is unknown. */
  session(id: string): Session | null {
    return this.sessions.get(id) ?? null;
  }

  /** Views of the sessions still in the building. Ended sessions are skipped before any view is derived for them. */
  liveViews(): SessionView[] {
    const now = this.now();
    const t = this.o.thresholds ?? DEFAULT_THRESHOLDS;
    const rules = this.o.featureRules ?? DEFAULT_FEATURE_RULES;
    const out: SessionView[] = [];
    for (const s of this.sessions.values()) if (s.state !== 'ended') out.push(toView(s, now, t, rules));
    return out;
  }

  /** One session's view, ended or not; null when the session is unknown. */
  view(id: string): SessionView | null {
    const s = this.sessions.get(id);
    return s ? toView(s, this.now(), this.o.thresholds ?? DEFAULT_THRESHOLDS, this.o.featureRules ?? DEFAULT_FEATURE_RULES) : null;
  }

  /** Who sits where on a floor, as the last scene read left it; null before its first read. */
  seatingOf(key: string): Seating | null {
    return this.seating.get(key) ?? null;
  }

  /** The building every browser sees: façade, floor directory and attention. */
  scene(): BuildingScene {
    const views = this.liveViews();
    return buildScene(views, this.firstSeen, this.seat(views));
  }

  /** One floor in detail, or null when no live session is on it. */
  floor(key: string): FloorDetail | null {
    const views = this.liveViews();
    return buildFloorDetail(views, key, this.firstSeen, this.seat(views));
  }

  /** The building and the given floors (null for one nobody is on) from one reading of the clock: a session shows one state in all of them. */
  render(floorKeys: readonly string[]): { scene: BuildingScene; floors: Map<string, FloorDetail | null> } {
    const views = this.liveViews();
    const seating = this.seat(views);
    return {
      scene: buildScene(views, this.firstSeen, seating),
      floors: new Map(floorKeys.map((key) => [key, buildFloorDetail(views, key, this.firstSeen, seating)])),
    };
  }

  snapshot(): Snapshot {
    const views = this.liveViews();
    return { generatedAt: this.now(), floors: buildFloors(views, this.firstSeen), attention: buildAttention(views) };
  }

  attentionSummary(): AttentionSummary {
    const a = buildAttention(this.liveViews());
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
      tmuxSession: v.tmuxSession,
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
    if (!s || this.view(id)?.effectiveState !== 'done') return false;
    this.sessions.set(id, markSeen(s, this.now()));
    this.changed(id);
    return true;
  }

  /** Stores a session's summary line, with no event. False when the session is unknown. */
  setSummary(id: string, summary: SessionSummary): boolean {
    const prev = this.sessions.get(id);
    if (!prev) return false;
    const next = { ...prev, summary };
    this.sessions.set(id, next);
    this.changed(id);
    this.sessionChanged(prev, next);
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

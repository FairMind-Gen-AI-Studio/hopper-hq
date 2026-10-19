import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { CollectorEvent, Session } from '../core/types.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  source TEXT NOT NULL,
  type TEXT NOT NULL,
  json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_session_ts ON events (session_id, ts);
CREATE TABLE IF NOT EXISTS floors (
  key TEXT PRIMARY KEY,
  first_seen INTEGER NOT NULL,
  plan TEXT
);
`;

type JsonRow = { json: string };
type FloorRow = { key: string; first_seen: number; plan: unknown };

/** A floor as stored: when its key was first seen, and its seating. */
export interface FloorRecord {
  firstSeen: number;
  /** The seating as JSON (scene/seating.ts); null when none is stored. */
  plan: string | null;
}

export class Store {
  private readonly upsertSession: StatementSync;
  private readonly insertEvent: StatementSync;
  private readonly upsertFloor: StatementSync;
  private readonly deleteFloor: StatementSync;
  private readonly deleteSession: StatementSync;

  private constructor(private readonly db: DatabaseSync) {
    // Another process may hold the write lock for a moment (a second `start` on the same data dir): wait for it instead of failing.
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(SCHEMA);
    // A database made before floors kept their seating: CREATE TABLE IF NOT EXISTS leaves its floors table as it was.
    const columns = db.prepare('PRAGMA table_info(floors)').all() as unknown as { name: string }[];
    if (!columns.some((c) => c.name === 'plan')) db.exec('ALTER TABLE floors ADD COLUMN plan TEXT');
    this.upsertSession = db.prepare(
      'INSERT INTO sessions (id, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at',
    );
    this.insertEvent = db.prepare('INSERT INTO events (session_id, ts, seq, source, type, json) VALUES (?, ?, ?, ?, ?, ?)');
    this.upsertFloor = db.prepare(
      'INSERT INTO floors (key, first_seen, plan) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET first_seen = excluded.first_seen, plan = excluded.plan',
    );
    this.deleteFloor = db.prepare('DELETE FROM floors WHERE key = ?');
    this.deleteSession = db.prepare('DELETE FROM sessions WHERE id = ?');
  }

  /** Opens or creates the database. Use ':memory:' for a throwaway store. */
  static async open(path: string): Promise<Store> {
    const { DatabaseSync } = await import('node:sqlite');
    return new Store(new DatabaseSync(path));
  }

  /** Writes sessions and floors in one transaction: all of it or nothing. A floor mapped to null is forgotten. */
  save(sessions: Session[], floors: ReadonlyMap<string, FloorRecord | null>, now: number): void {
    this.db.exec('BEGIN');
    try {
      for (const s of sessions) this.upsertSession.run(s.id, JSON.stringify(s), now);
      for (const [key, floor] of floors) {
        if (floor === null) this.deleteFloor.run(key);
        else this.upsertFloor.run(key, floor.firstSeen, floor.plan);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  saveSessions(sessions: Session[], now: number): void {
    this.save(sessions, new Map(), now);
  }

  loadSessions(): Session[] {
    const rows = this.db.prepare('SELECT json FROM sessions ORDER BY id').all() as unknown as JsonRow[];
    const out: Session[] = [];
    for (const r of rows) {
      try {
        const s = JSON.parse(r.json) as Session;
        // A row written by an older version has no waitAgentId (its wait is the session's own) and no tmuxSession (unknown).
        out.push({ ...s, waitAgentId: s.waitAgentId ?? null, tmuxSession: s.tmuxSession ?? null });
      } catch {
        // skip a corrupt row
      }
    }
    return out;
  }

  /** Every stored floor. */
  loadFloors(): Map<string, FloorRecord> {
    const rows = this.db.prepare('SELECT key, first_seen, plan FROM floors').all() as unknown as FloorRow[];
    return new Map(rows.map((r) => [r.key, { firstSeen: Number(r.first_seen), plan: typeof r.plan === 'string' ? r.plan : null }]));
  }

  appendEvent(e: CollectorEvent): void {
    this.insertEvent.run(e.sessionId, e.ts, e.seq, e.source, e.type, JSON.stringify(e));
  }

  /** The latest `limit` events of a session, oldest first. */
  recentEvents(sessionId: string, limit = 50): CollectorEvent[] {
    const rows = this.db
      .prepare('SELECT json FROM events WHERE session_id = ? ORDER BY ts DESC, seq DESC LIMIT ?')
      .all(sessionId, limit) as unknown as JsonRow[];
    return rows.map((r) => JSON.parse(r.json) as CollectorEvent).reverse();
  }

  /** Deletes events older than `before`; returns how many. */
  prune(before: number): number {
    return Number(this.db.prepare('DELETE FROM events WHERE ts < ?').run(before).changes);
  }

  /**
   * Deletes the sessions that ended before `before`, by when they ended; returns how many. Only a session saved as ended
   * goes: one whose desk expires without it ending, a Codex session's, stays so that a resumed turn can return. A row
   * that does not read back stays too: loadSessions skips it, and nothing says when it ended.
   */
  pruneEndedSessions(before: number): number {
    const rows = this.db.prepare('SELECT id, json FROM sessions').all() as unknown as { id: string; json: string }[];
    const ended: string[] = [];
    for (const r of rows) {
      try {
        const s = JSON.parse(r.json) as Partial<Session>;
        if (s.state === 'ended' && typeof s.stateSince === 'number' && s.stateSince < before) ended.push(r.id);
      } catch {
        // a corrupt row: keep it
      }
    }
    if (ended.length === 0) return 0;
    this.db.exec('BEGIN');
    try {
      for (const id of ended) this.deleteSession.run(id);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return ended.length;
  }

  close(): void {
    this.db.close();
  }
}

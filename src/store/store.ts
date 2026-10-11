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
  first_seen INTEGER NOT NULL
);
`;

type JsonRow = { json: string };
type FloorRow = { key: string; first_seen: number };

export class Store {
  private readonly upsertSession: StatementSync;
  private readonly insertEvent: StatementSync;
  private readonly insertFloor: StatementSync;

  private constructor(private readonly db: DatabaseSync) {
    // Another process may hold the write lock for a moment (a second `start` on the same data dir): wait for it instead of failing.
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(SCHEMA);
    this.upsertSession = db.prepare(
      'INSERT INTO sessions (id, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at',
    );
    this.insertEvent = db.prepare('INSERT INTO events (session_id, ts, seq, source, type, json) VALUES (?, ?, ?, ?, ?, ?)');
    this.insertFloor = db.prepare('INSERT OR IGNORE INTO floors (key, first_seen) VALUES (?, ?)');
  }

  /** Opens or creates the database. Use ':memory:' for a throwaway store. */
  static async open(path: string): Promise<Store> {
    const { DatabaseSync } = await import('node:sqlite');
    return new Store(new DatabaseSync(path));
  }

  saveSessions(sessions: Session[], now: number): void {
    this.db.exec('BEGIN');
    try {
      for (const s of sessions) this.upsertSession.run(s.id, JSON.stringify(s), now);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  loadSessions(): Session[] {
    const rows = this.db.prepare('SELECT json FROM sessions ORDER BY id').all() as unknown as JsonRow[];
    const out: Session[] = [];
    for (const r of rows) {
      try {
        const s = JSON.parse(r.json) as Session;
        // A row written by an older version has no waitAgentId: its wait is the session's own.
        out.push({ ...s, waitAgentId: s.waitAgentId ?? null });
      } catch {
        // skip a corrupt row
      }
    }
    return out;
  }

  /** When each floor key was first seen. */
  loadFloors(): Map<string, number> {
    const rows = this.db.prepare('SELECT key, first_seen FROM floors').all() as unknown as FloorRow[];
    return new Map(rows.map((r) => [r.key, Number(r.first_seen)]));
  }

  /** Records first-seen times. A key already recorded keeps its first time. */
  recordFloors(entries: Array<[string, number]>): void {
    if (entries.length === 0) return;
    this.db.exec('BEGIN');
    try {
      for (const [key, firstSeen] of entries) this.insertFloor.run(key, firstSeen);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
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

  close(): void {
    this.db.close();
  }
}

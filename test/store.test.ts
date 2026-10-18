import { describe, expect, it } from 'vitest';
import { once } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { newSession } from '../src/core/reducer.js';
import type { Session } from '../src/core/types.js';
import { emptySeating, parseSeating, type Seating } from '../src/scene/seating.js';
import { Store } from '../src/store/store.js';
import { ev, WS } from './helpers/events.js';

/** S1 at the first desk, and resting in the lounge: a lounge sitter keeps its desk. */
const SITTING: Seating = { ...emptySeating(), desks: ['S1', null, null, null, 'S2', null, null, null], lounge: ['S1', null, null, null, null, null, null, null] };
const PLAN = JSON.stringify(SITTING);

/** The schema of a database made before floors kept their seating. */
const BEFORE_PLANS = `
CREATE TABLE sessions (id TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, ts INTEGER NOT NULL, seq INTEGER NOT NULL, source TEXT NOT NULL, type TEXT NOT NULL, json TEXT NOT NULL);
CREATE INDEX events_session_ts ON events (session_id, ts);
CREATE TABLE floors (key TEXT PRIMARY KEY, first_seen INTEGER NOT NULL);
`;

describe('Store', () => {
  it('saves, updates and loads sessions', async () => {
    const store = await Store.open(':memory:');
    const s = newSession('S1', 1000, WS);
    store.saveSessions([s], 5);
    expect(store.loadSessions()).toEqual([s]);
    store.saveSessions([{ ...s, title: 'Fix checkout' }], 6);
    expect(store.loadSessions()).toEqual([{ ...s, title: 'Fix checkout' }]);
    store.close();
  });

  it('keeps whose wait it is, and loads a session saved without it as its own wait', async () => {
    const store = await Store.open(':memory:');
    const older: Partial<Session> = newSession('S1', 1000, WS);
    delete older.waitAgentId;
    store.saveSessions([older as Session], 5);
    expect(store.loadSessions()).toEqual([{ ...older, waitAgentId: null }]);
    store.saveSessions([{ ...newSession('S2', 1000, WS), state: 'needs_you', waitAgentId: 'a1' }], 6);
    expect(store.loadSessions().map((s) => s.waitAgentId)).toEqual([null, 'a1']);
    store.close();
  });

  it("keeps a session's tmux session, and loads one saved without it as unknown", async () => {
    const store = await Store.open(':memory:');
    const older: Partial<Session> = newSession('S1', 1000, WS);
    delete older.tmuxSession;
    store.saveSessions([older as Session, { ...newSession('S2', 1000, WS), tmuxPane: '%3', tmuxSession: 'work' }], 5);
    expect(store.loadSessions().map((s) => [s.id, s.tmuxSession])).toEqual([['S1', null], ['S2', 'work']]);
    store.close();
  });

  it('saves sessions and floors together, with their seating, and forgets a floor saved as null', async () => {
    const store = await Store.open(':memory:');
    expect(store.loadFloors()).toEqual(new Map());
    store.save([newSession('S1', 1000, WS)], new Map([['feature:checkout-v2', { firstSeen: 100, plan: PLAN }], ['repo:/w/orders-api', { firstSeen: 200, plan: null }]]), 5);
    store.save([], new Map([['feature:checkout-v2', { firstSeen: 300, plan: PLAN }], ['repo:/w/orders-api', null], ['repo:/w/search-svc', { firstSeen: 400, plan: null }]]), 6);
    const floors = store.loadFloors();
    expect(floors).toEqual(new Map([['feature:checkout-v2', { firstSeen: 300, plan: PLAN }], ['repo:/w/search-svc', { firstSeen: 400, plan: null }]]));
    expect(parseSeating(floors.get('feature:checkout-v2')!.plan!)).toEqual(SITTING);
    expect(store.loadSessions().map((s) => s.id)).toEqual(['S1']);
    store.close();
  });

  it('replaces a floor\'s stored seating, and clears it when saved without one', async () => {
    const store = await Store.open(':memory:');
    store.save([], new Map([['feature:checkout-v2', { firstSeen: 100, plan: JSON.stringify(emptySeating()) }]]), 5);
    store.save([], new Map([['feature:checkout-v2', { firstSeen: 100, plan: PLAN }]]), 6);
    expect(store.loadFloors().get('feature:checkout-v2')).toEqual({ firstSeen: 100, plan: PLAN });
    store.save([], new Map([['feature:checkout-v2', { firstSeen: 100, plan: null }]]), 7);
    expect(store.loadFloors().get('feature:checkout-v2')).toEqual({ firstSeen: 100, plan: null });
    store.close();
  });

  it('adds the seating column to a database made before floors kept it, keeping its rows', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'shq-store-')), 'before.db');
    const { DatabaseSync } = await import('node:sqlite');
    const before = new DatabaseSync(path);
    before.exec(BEFORE_PLANS);
    before.prepare('INSERT INTO sessions (id, json, updated_at) VALUES (?, ?, ?)').run('S1', JSON.stringify(newSession('S1', 1000, WS)), 5);
    before.prepare('INSERT INTO floors (key, first_seen) VALUES (?, ?)').run('feature:checkout-v2', 100);
    before.prepare('INSERT INTO floors (key, first_seen) VALUES (?, ?)').run('repo:/w/orders-api', 200);
    before.close();

    const store = await Store.open(path);
    expect(store.loadFloors()).toEqual(new Map([['feature:checkout-v2', { firstSeen: 100, plan: null }], ['repo:/w/orders-api', { firstSeen: 200, plan: null }]]));
    expect(store.loadSessions()).toEqual([newSession('S1', 1000, WS)]);
    store.save([], new Map([['feature:checkout-v2', { firstSeen: 100, plan: PLAN }]]), 6);
    store.close();
    // Opened again, it finds the column there and leaves it.
    const again = await Store.open(path);
    expect(again.loadFloors()).toEqual(new Map([['feature:checkout-v2', { firstSeen: 100, plan: PLAN }], ['repo:/w/orders-api', { firstSeen: 200, plan: null }]]));
    again.close();
  });

  it('writes nothing of a save that fails', async () => {
    const store = await Store.open(':memory:');
    expect(() => store.save([newSession('S1', 1000, WS)], new Map([['repo:/w/orders-api', { firstSeen: Number.NaN, plan: null }]]), 5)).toThrow('NOT NULL');
    expect(store.loadSessions()).toEqual([]);
    expect(store.loadFloors()).toEqual(new Map());
    store.close();
  });

  it('keeps an ordered event log and prunes old events', async () => {
    const store = await Store.open(':memory:');
    store.appendEvent(ev('prompt', 1, { text: 'a' }));
    store.appendEvent(ev('prompt', 2, { text: 'b' }));
    store.appendEvent(ev('prompt', 3, { text: 'c' }));
    expect(store.recentEvents('S1', 2).map((e) => e.ts)).toEqual([2, 3]);
    expect(store.prune(3)).toBe(2);
    expect(store.recentEvents('S1').map((e) => e.ts)).toEqual([3]);
    store.close();
  });

  it('prunes sessions that ended before the cutoff, by when they ended, and keeps every other row', async () => {
    const store = await Store.open(':memory:');
    const s = (id: string) => newSession(id, 1000, WS);
    store.saveSessions(
      [
        { ...s('OLD'), state: 'ended', stateSince: 100 },
        { ...s('NEW'), state: 'ended', stateSince: 900 },
        { ...s('DORMANT'), state: 'dormant', stateSince: 100 },
        { ...s('CODEX'), agentKind: 'codex', state: 'done', stateSince: 100 },
      ],
      // Saved after the cutoff: the age is when the session ended, not when its row was last written.
      2000,
    );
    expect(store.pruneEndedSessions(500)).toBe(1);
    expect(store.loadSessions().map((x) => x.id)).toEqual(['CODEX', 'DORMANT', 'NEW']);
    expect(store.pruneEndedSessions(500)).toBe(0);
    store.close();
  });

  it('keeps a session row that does not read back when pruning', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'shq-store-')), 'test.db');
    const store = await Store.open(path);
    store.saveSessions([{ ...newSession('OLD', 1000, WS), state: 'ended', stateSince: 100 }], 5);
    store.close();
    const { DatabaseSync } = await import('node:sqlite');
    const raw = new DatabaseSync(path);
    raw.prepare("INSERT INTO sessions (id, json, updated_at) VALUES ('BAD', '{not json', 5), ('NUL', 'null', 5)").run();
    raw.close();
    const again = await Store.open(path);
    expect(again.pruneEndedSessions(500)).toBe(1);
    again.close();
    const check = new DatabaseSync(path);
    const left = check.prepare('SELECT id FROM sessions ORDER BY id').all() as unknown as { id: string }[];
    check.close();
    expect(left.map((r) => r.id)).toEqual(['BAD', 'NUL']);
  });

  it('waits for another connection to finish writing instead of failing', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'shq-store-')), 'test.db');
    const store = await Store.open(path);
    // node:sqlite is synchronous: the lock is held by another thread, which releases it while this one waits.
    const holder = new Worker(
      `const { DatabaseSync } = require('node:sqlite');
      const { parentPort, workerData } = require('node:worker_threads');
      const db = new DatabaseSync(workerData);
      db.exec('BEGIN IMMEDIATE');
      parentPort.postMessage('locked');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
      db.exec('COMMIT');
      db.close();`,
      { eval: true, workerData: path, stderr: true },
    );
    await once(holder, 'message');
    store.saveSessions([newSession('S1', 1000, WS)], 5);
    await once(holder, 'exit');
    expect(store.loadSessions().map((s) => s.id)).toEqual(['S1']);
    store.close();
  });

  it('persists to a file across reopen', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'shq-store-')), 'test.db');
    const a = await Store.open(path);
    a.saveSessions([newSession('S1', 1000, WS)], 5);
    a.close();
    const b = await Store.open(path);
    expect(b.loadSessions().map((s) => s.id)).toEqual(['S1']);
    b.close();
  });
});

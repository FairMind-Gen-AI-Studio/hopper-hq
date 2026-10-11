import { describe, expect, it } from 'vitest';
import { once } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { newSession } from '../src/core/reducer.js';
import type { Session } from '../src/core/types.js';
import { Store } from '../src/store/store.js';
import { ev, WS } from './helpers/events.js';

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

  it('remembers when each floor was first seen, keeping the first time recorded', async () => {
    const store = await Store.open(':memory:');
    expect(store.loadFloors()).toEqual(new Map());
    store.recordFloors([['feature:checkout-v2', 100], ['repo:/w/orders-api', 200]]);
    store.recordFloors([['feature:checkout-v2', 50], ['repo:/w/search-svc', 300]]);
    store.recordFloors([]);
    expect(store.loadFloors()).toEqual(new Map([['feature:checkout-v2', 100], ['repo:/w/orders-api', 200], ['repo:/w/search-svc', 300]]));
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

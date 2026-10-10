import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newSession } from '../src/core/reducer.js';
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

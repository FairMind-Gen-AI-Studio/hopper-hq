import { describe, expect, it } from 'vitest';
import { PHASE, RUN_STATUS, STATES, STATE_ORDER, floorLabel, floorMeta, needYou, plural, raisedBy, runCounts, runSpan, sessionsOf, waitText } from '../../lib/words';
import { NOW, makeScene } from '../helpers/fixtures';

describe('words', () => {
  it('names and explains every state a desk can show, needs-you first', () => {
    expect([...STATE_ORDER].sort()).toEqual(Object.keys(STATES).sort());
    expect(STATE_ORDER[0]).toBe('needs_you');
    expect(STATES.done.label).toBe('Done, to review');
    for (const s of STATE_ORDER) expect(STATES[s].description).toMatch(/\.$/);
  });

  it('counts in words', () => {
    expect(plural(1, 'floor', 'floors')).toBe('1 floor');
    expect(plural(0, 'floor', 'floors')).toBe('0 floors');
    expect(plural(3, 'session', 'sessions')).toBe('3 sessions');
    expect(`1 ${needYou(1)}, 2 ${needYou(2)}, 0 ${needYou(0)}`).toBe('1 needs you, 2 need you, 0 need you');
  });

  it('says what a session waits for, and which subagent asked', () => {
    const reason = { kind: 'permission' as const, text: 'Bash', detail: 'rm -rf dist', agent: null };
    expect(waitText(reason)).toBe('Permission: Bash (rm -rf dist)');
    expect(waitText({ ...reason, kind: 'question', text: 'Which database?', detail: null })).toBe('Question: Which database?');
    expect(waitText(null)).toBe('Needs you');
    expect(raisedBy(reason)).toBeNull();
    expect(raisedBy(null)).toBeNull();
    expect(raisedBy({ ...reason, agent: { id: 'a1', type: 'Explore' } })).toBe('raised by Explore');
    expect(raisedBy({ ...reason, agent: { id: 'a1', type: null } })).toBe('raised by a subagent');
  });

  it('describes each floor, with the counts that matter', () => {
    const [checkout, search, orders, docs] = makeScene().floors;
    const metas = (f: typeof checkout) => floorMeta(f!).map((m) => (m.tone ? `${m.tone}:${m.text}` : m.text));
    expect(metas(checkout)).toEqual(['3 repos · 4 sessions', 'needs:● 1 needs you', 'done:● 1 done', 'meeting:● 1 in a meeting']);
    expect(metas(search)).toEqual(['2 repos · 2 sessions', 'nosignal:● 1 no signal']);
    expect(metas(orders)).toEqual(['Department · 5 sessions', 'needs:● 1 needs you', 'done:● 1 done']);
    expect(metas(docs)).toEqual(['2 repos · 2 sessions', 'shutters down']);
    // A screen reader hears every count the label shows.
    expect(floorLabel(checkout!)).toBe('Floor 4, checkout-v2: 4 sessions, 1 needs you, 1 done, 1 in a meeting');
    expect(floorLabel(search!)).toBe('Floor 3, search-ranking: 2 sessions, 1 no signal');
    expect(floorLabel(docs!)).toBe('Floor 1, docs-refresh: 2 sessions, shutters down');
    expect(floorLabel({ ...orders!, counts: { needs_you: 2 } })).toBe('Floor 2, orders-api: 2 sessions, 2 need you');
    expect(floorMeta({ ...orders!, counts: { needs_you: 2 } })[1]!.text).toBe('● 2 need you');
  });

  it('counts a floor\'s sessions from its counts, those waiting for a desk too, and not from its windows', () => {
    const [checkout] = makeScene().floors;
    expect(checkout!.windows).toHaveLength(16);
    expect(sessionsOf(checkout!)).toBe(4);
    // Two sessions wait for a desk: no window is theirs, and the floor counts them.
    const crowded = { ...checkout!, counts: { ...checkout!.counts, working: 3 } };
    expect([sessionsOf(crowded), floorMeta(crowded)[0]!.text]).toEqual([6, '3 repos · 6 sessions']);
    expect(sessionsOf({ counts: {} })).toBe(0);
  });

  it('says how a workflow run stands, how long it has gone on, and where each phase is', () => {
    const run = { startedAt: NOW - 9 * 60_000, endedAt: NOW - 30_000 };
    expect(runSpan({ ...run, status: 'running', endedAt: null }, NOW)).toBe('Running for 9m');
    expect(runSpan({ ...run, status: 'completed' }, NOW)).toBe('Completed in 8m');
    expect(runSpan({ ...run, status: 'failed' }, NOW)).toBe('Failed after 8m');
    expect(runSpan({ ...run, status: 'killed' }, NOW)).toBe('Stopped after 8m');
    expect(runSpan({ ...run, status: 'killed', endedAt: null }, NOW)).toBe('Stopped');
    expect(RUN_STATUS).toEqual({ running: 'Running', completed: 'Completed', failed: 'Failed', killed: 'Stopped' });
    expect(runCounts({ running: 2, finished: 5 })).toBe('2 running · 5 done');
    expect(Object.values(PHASE).map((p) => `${p.mark} ${p.word}`)).toEqual(['✓ done', '● current', '○ upcoming']);
  });
});

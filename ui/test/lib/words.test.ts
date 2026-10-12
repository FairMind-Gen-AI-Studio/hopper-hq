import { describe, expect, it } from 'vitest';
import { STATES, STATE_ORDER, floorLabel, floorMeta, plural, raisedBy, waitText } from '../../lib/words';
import { makeScene } from '../helpers/fixtures';

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
    expect(floorLabel(checkout!)).toBe('Floor 4, checkout-v2: 4 sessions, 1 needs you, 1 done');
    expect(floorLabel(docs!)).toBe('Floor 1, docs-refresh: 2 sessions, shutters down');
    expect(floorLabel({ ...orders!, counts: { needs_you: 2 } })).toBe('Floor 2, orders-api: 5 sessions, 2 need you');
    expect(floorMeta({ ...orders!, counts: { needs_you: 2 } })[1]!.text).toBe('● 2 need you');
  });
});

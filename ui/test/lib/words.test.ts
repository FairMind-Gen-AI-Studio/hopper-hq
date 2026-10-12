import { describe, expect, it } from 'vitest';
import { STATES, STATE_ORDER, plural, raisedBy, waitText } from '../../lib/words';

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
});

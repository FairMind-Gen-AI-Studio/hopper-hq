import { describe, expect, it } from 'vitest';
import { motionFromSearch } from '../../lib/motion';

describe('motionFromSearch', () => {
  it('turns motion off only for motion=off in the query', () => {
    expect(motionFromSearch('?motion=off')).toBe(false);
    expect(motionFromSearch('?theme=dark&motion=off')).toBe(false);
    expect(motionFromSearch('')).toBe(true);
    expect(motionFromSearch('?motion=on')).toBe(true);
    expect(motionFromSearch('?motion=')).toBe(true);
    expect(motionFromSearch('?motion=OFF')).toBe(true);
    expect(motionFromSearch('?nomotion=off')).toBe(true);
  });
});

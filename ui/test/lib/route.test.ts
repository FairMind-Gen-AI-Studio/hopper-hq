import { describe, expect, it } from 'vitest';
import { parseHash, toHash } from '../../lib/route';

describe('hash routes', () => {
  it('reads the building from an empty or unknown hash', () => {
    for (const hash of ['', '#', '#/', '#/elevator', '#/floor/', '#/floor/a/desk/', '#/floor/a/b', '#/floor/a/desk/b/c', 'floor/a']) {
      expect(parseHash(hash), hash).toEqual({ floor: null, desk: null });
    }
  });

  it('reads a floor and a desk on it', () => {
    expect(parseHash('#/floor/feature%3Acheckout-v2')).toEqual({ floor: 'feature:checkout-v2', desk: null });
    expect(parseHash('#/floor/feature%3Acheckout-v2/desk/oa-c3')).toEqual({ floor: 'feature:checkout-v2', desk: 'oa-c3' });
  });

  it('round-trips keys and ids with colons, slashes, spaces, percent signs and hashes', () => {
    const routes = [
      { floor: 'repo:/Users/dev/code/orders-api', desk: null },
      { floor: 'repo:/tmp/a b/100%/#x', desk: 'id/with:odd #chars%' },
      { floor: 'feature:checkout-v2', desk: '6f1e2a0c-1b2c-4d5e-8f90-a1b2c3d4e5f6' },
    ];
    for (const r of routes) {
      const hash = toHash(r);
      expect(hash.slice(1), hash).not.toMatch(/[# ]/);
      expect(parseHash(hash)).toEqual(r);
    }
  });

  it('writes the building as #/, and ignores a desk without a floor', () => {
    expect(toHash({ floor: null, desk: null })).toBe('#/');
    expect(toHash({ floor: null, desk: 'oa-c3' })).toBe('#/');
    expect(toHash({ floor: 'feature:checkout-v2', desk: null })).toBe('#/floor/feature%3Acheckout-v2');
  });

  it('reads a malformed escape as the building instead of throwing', () => {
    expect(parseHash('#/floor/%E0%A4%A')).toEqual({ floor: null, desk: null });
    expect(parseHash('#/floor/ok/desk/%')).toEqual({ floor: null, desk: null });
  });
});

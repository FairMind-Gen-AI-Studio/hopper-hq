import { describe, expect, it } from 'vitest';
import { FEATURE_SLOTS, fnv1a32, REPO_SLOTS, slotOf } from '../../src/scene/palette.js';

describe('fnv1a32', () => {
  it('matches the published 32-bit FNV-1a vectors', () => {
    expect(fnv1a32('')).toBe(0x811c9dc5);
    expect(fnv1a32('a')).toBe(0xe40c292c);
    expect(fnv1a32('foobar')).toBe(0xbf9cf968);
  });
});

describe('slotOf', () => {
  it('gives every key the same slot every time, within range', () => {
    expect([REPO_SLOTS, FEATURE_SLOTS]).toEqual([8, 8]);
    for (const key of ['orders-api', 'storefront-web', 'checkout-v2', '', 'ünïcode', '\u{1F600}', 'x'.repeat(1000)]) {
      const slot = slotOf(key, REPO_SLOTS);
      expect(slotOf(key, REPO_SLOTS)).toBe(slot);
      expect(Number.isInteger(slot) && slot >= 0 && slot < REPO_SLOTS).toBe(true);
    }
  });

  it('pins the demo repos and features', () => {
    expect(['orders-api', 'payments-svc', 'search-svc', 'storefront-web'].map((r) => slotOf(r, REPO_SLOTS))).toEqual([1, 1, 6, 2]);
    expect(['checkout-v2', 'search-ranking'].map((f) => slotOf(f, FEATURE_SLOTS))).toEqual([4, 6]);
  });
});

/**
 * Colour slots: a repo colours its rug and its robots' bodies, a feature colours the robots' ties. Browser-safe.
 * The theme maps slot n to --repo-n / --feature-n, so the same repo or feature looks the same everywhere.
 */

export const REPO_SLOTS = 8;
export const FEATURE_SLOTS = 8;

/** 32-bit FNV-1a over UTF-16 code units. */
export function fnv1a32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * murmur3's 32-bit finalizer: every input bit reaches every output bit. FNV-1a alone mixes a key's last code units into its
 * high bits through one multiply only, and its low bits depend only on the low bits of each code unit.
 */
export function fmix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * A stable slot in 0..slots-1: the high bits of the mixed hash, so 'web' and 'Web', or 'api-v1' and 'api-v9', need not
 * share one. Repo slots are keyed by repo root (cwd outside git), feature slots by feature key.
 */
export function slotOf(key: string, slots: number): number {
  return Math.floor((fmix32(fnv1a32(key)) * slots) / 2 ** 32);
}

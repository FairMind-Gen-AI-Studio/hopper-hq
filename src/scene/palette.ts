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

/** A stable slot in 0..slots-1. Repo slots are keyed by repo name, feature slots by feature key. */
export function slotOf(key: string, slots: number): number {
  return fnv1a32(key) % slots;
}

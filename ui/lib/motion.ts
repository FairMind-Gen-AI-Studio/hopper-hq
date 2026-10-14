/**
 * Whether the 3D floor animates, from the page's query string (location.search): with ?motion=off robots jump to their
 * places and no ambient loop runs, for tests and screenshots (design §5.3).
 */
export function motionFromSearch(search: string): boolean {
  return new URLSearchParams(search).get('motion') !== 'off';
}

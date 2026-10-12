/**
 * Where the page is: the building, a floor, or a desk on a floor. It lives in the URL hash, so Back, Forward and
 * reload work, and a link can point at a desk: '#/floor/<floor key>[/desk/<session id>]', both URI-encoded.
 */
export interface Route {
  floor: string | null;
  desk: string | null;
}

const BUILDING: Route = { floor: null, desk: null };
const ROUTE = /^#?\/floor\/([^/]+)(?:\/desk\/([^/]+))?$/;

/** Anything that is not a floor or a desk route, including a malformed escape, is the building. */
export function parseHash(hash: string): Route {
  const m = ROUTE.exec(hash);
  if (!m) return { ...BUILDING };
  try {
    return { floor: decodeURIComponent(m[1]!), desk: m[2] === undefined ? null : decodeURIComponent(m[2]) };
  } catch {
    return { ...BUILDING };
  }
}

/** A desk needs its floor: without one, the route is the building. */
export function toHash(r: Route): string {
  if (!r.floor) return '#/';
  return '#/floor/' + encodeURIComponent(r.floor) + (r.desk ? '/desk/' + encodeURIComponent(r.desk) : '');
}

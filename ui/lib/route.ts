/**
 * Where the page is: the building, a floor, or a desk or a workflow run on a floor. It lives in the URL hash, so Back,
 * Forward and reload work, and a link can point at a desk or a run:
 * '#/floor/<floor key>[/desk/<session id> | /run/<run id>]', each part URI-encoded.
 */
export interface Route {
  floor: string | null;
  desk: string | null;
  run: string | null;
}

const BUILDING: Route = { floor: null, desk: null, run: null };
const ROUTE = /^#?\/floor\/([^/]+)(?:\/(desk|run)\/([^/]+))?$/;

/** Anything that is not a floor, desk or run route, including a malformed escape, is the building. */
export function parseHash(hash: string): Route {
  const m = ROUTE.exec(hash);
  if (!m) return { ...BUILDING };
  try {
    const floor = decodeURIComponent(m[1]!);
    const id = m[3] === undefined ? null : decodeURIComponent(m[3]);
    return { floor, desk: m[2] === 'desk' ? id : null, run: m[2] === 'run' ? id : null };
  } catch {
    return { ...BUILDING };
  }
}

/**
 * A desk or a run needs its floor: without one, the route is the building. A route names a desk or a run, never both:
 * given both, the desk wins. A desk or a run left out is none.
 */
export function toHash(r: { floor: string | null; desk?: string | null; run?: string | null }): string {
  if (!r.floor) return '#/';
  const at = r.desk ? '/desk/' + encodeURIComponent(r.desk) : r.run ? '/run/' + encodeURIComponent(r.run) : '';
  return '#/floor/' + encodeURIComponent(r.floor) + at;
}

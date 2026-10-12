/**
 * The two things the page asks of the daemon besides watching: focus a session's tmux pane, and mark a finished
 * session as seen. Same-origin requests with the sign-in cookie; the browser adds the Origin header the daemon checks.
 * Paths are absolute: the page lives under /ui/.
 */
import { cleanText, isSessionId } from '../../src/scene/text';

export type FocusResult = { ok: true; pane: string; simulated: boolean } | { ok: false; status: number; error: string };

/** What to do when the daemon answers 401: the browser's sign-in cookie is missing, expired, or another daemon's. */
export const SIGNED_OUT = 'Signed out: run scranton-hq ui again';

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Never rejects: a daemon that is down or answers something unexpected gives an error result to show. An id that is
 * not a session id (src/scene/text.ts) names no session, and is not sent.
 */
export async function focusSession(sessionId: string, fetchFn: Fetch = fetch): Promise<FocusResult> {
  if (!isSessionId(sessionId)) return { ok: false, status: 0, error: 'No such session' };
  let res: Response;
  try {
    res = await fetchFn('/api/focus', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    });
  } catch {
    return { ok: false, status: 0, error: 'The daemon is not answering' };
  }
  if (res.status === 401) return { ok: false, status: 401, error: SIGNED_OUT };
  const body = (await res.json().catch(() => null)) as { pane?: unknown; simulated?: unknown; error?: unknown } | null;
  if (res.ok && typeof body?.pane === 'string') return { ok: true, pane: cleanText(body.pane), simulated: body.simulated === true };
  const error = typeof body?.error === 'string' ? cleanText(body.error) : '';
  return { ok: false, status: res.status, error: error || `The daemon answered ${res.status}` };
}

/**
 * True when the daemon took it (204). The answer has no body to read; `signedOut` hears a 401. An id that is not a
 * session id is not sent: in the path, '..' would make it POST /api/seen, which marks every session seen.
 */
export async function markSeen(sessionId: string, fetchFn: Fetch = fetch, signedOut?: () => void): Promise<boolean> {
  if (!isSessionId(sessionId)) return false;
  try {
    const res = await fetchFn(`/api/sessions/${encodeURIComponent(sessionId)}/seen`, { method: 'POST', credentials: 'same-origin' });
    if (res.status === 401) signedOut?.();
    return res.ok;
  } catch {
    return false;
  }
}

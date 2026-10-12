/**
 * The two things the page asks of the daemon besides watching: focus a session's tmux pane, and mark a finished
 * session as seen. Same-origin requests with the sign-in cookie; the browser adds the Origin header the daemon checks.
 * Paths are absolute: the page lives under /ui/.
 */
import { cleanText } from '../../src/scene/text';

export type FocusResult = { ok: true; pane: string; simulated: boolean } | { ok: false; status: number; error: string };

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** Never rejects: a daemon that is down or answers something unexpected gives an error result to show. */
export async function focusSession(sessionId: string, fetchFn: Fetch = fetch): Promise<FocusResult> {
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
  const body = (await res.json().catch(() => null)) as { pane?: unknown; simulated?: unknown; error?: unknown } | null;
  if (res.ok && typeof body?.pane === 'string') return { ok: true, pane: cleanText(body.pane), simulated: body.simulated === true };
  const error = typeof body?.error === 'string' ? cleanText(body.error) : '';
  return { ok: false, status: res.status, error: error || `The daemon answered ${res.status}` };
}

/** True when the daemon took it (204). The answer has no body to read. */
export async function markSeen(sessionId: string, fetchFn: Fetch = fetch): Promise<boolean> {
  try {
    const res = await fetchFn(`/api/sessions/${encodeURIComponent(sessionId)}/seen`, { method: 'POST', credentials: 'same-origin' });
    return res.ok;
  } catch {
    return false;
  }
}

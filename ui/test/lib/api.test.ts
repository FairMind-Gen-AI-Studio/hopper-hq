import { describe, expect, it, vi } from 'vitest';
import { focusSession, markSeen } from '../../lib/api';

function answer(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body), { status });
}

describe('focusSession', () => {
  it('asks the daemon to focus a session by id, as JSON, with the cookie', async () => {
    const fetch = vi.fn(async () => answer(200, { pane: '%7', simulated: true }));
    expect(await focusSession('oa-c3', fetch)).toEqual({ ok: true, pane: '%7', simulated: true });
    expect(fetch).toHaveBeenCalledWith('/api/focus', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: '{"sessionId":"oa-c3"}',
    });
  });

  it('passes on what the daemon says when it cannot', async () => {
    const no = (status: number, error: string) => focusSession('x', async () => answer(status, { error }));
    expect(await no(409, 'No tmux client is attached')).toEqual({ ok: false, status: 409, error: 'No tmux client is attached' });
    expect(await no(502, 'tmux could not switch to the pane')).toEqual({ ok: false, status: 502, error: 'tmux could not switch to the pane' });
    expect(await no(404, 'No such session')).toEqual({ ok: false, status: 404, error: 'No such session' });
  });

  it('says what went wrong when the answer is not the daemon JSON', async () => {
    expect(await focusSession('x', async () => answer(500, 'Internal error'))).toEqual({ ok: false, status: 500, error: 'The daemon answered 500' });
    expect(await focusSession('x', async () => answer(200, { simulated: true }))).toEqual({ ok: false, status: 200, error: 'The daemon answered 200' });
    expect(await focusSession('x', async () => answer(401, { error: 42 }))).toEqual({ ok: false, status: 401, error: 'The daemon answered 401' });
  });

  it('never rejects: a daemon that does not answer is an error result', async () => {
    const down = async (): Promise<Response> => {
      throw new TypeError('Failed to fetch');
    };
    expect(await focusSession('x', down)).toEqual({ ok: false, status: 0, error: 'The daemon is not answering' });
  });

  it('cleans the error text before it is shown', async () => {
    const result = await focusSession('x', async () => answer(409, { error: 'No\u001b[31m client \u202Eattached' }));
    expect(result).toEqual({ ok: false, status: 409, error: 'No[31m client attached' });
  });
});

describe('markSeen', () => {
  it('posts to the session, its id escaped, with the cookie, and reads no body', async () => {
    const response = answer(204, undefined);
    const json = vi.spyOn(response, 'json');
    const fetch = vi.fn(async () => response);
    expect(await markSeen('a/b c', fetch)).toBe(true);
    expect(fetch).toHaveBeenCalledWith('/api/sessions/a%2Fb%20c/seen', { method: 'POST', credentials: 'same-origin' });
    expect(json).not.toHaveBeenCalled();
  });

  it('is false when the session is not done or the daemon does not answer', async () => {
    expect(await markSeen('x', async () => answer(404, { error: 'No finished session with that id' }))).toBe(false);
    expect(
      await markSeen('x', async () => {
        throw new TypeError('Failed to fetch');
      }),
    ).toBe(false);
  });
});

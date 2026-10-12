import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { basename } from 'node:path';
import { Collector } from '../../src/collector.js';
import { createApiServer } from '../../src/server/http.js';
import { bearer, call, close, listen } from '../helpers/http.js';

const TOKEN = 's'.repeat(48);
let server: Server;
let port: number;
let asked = 0;

beforeAll(async () => {
  const collector = new Collector({ resolveWorkspace: async (cwd) => ({ cwd, repoRoot: cwd, repoName: basename(cwd), worktree: false, branch: 'main' }), saveDelayMs: 0 });
  server = createApiServer({ collector, token: TOKEN, onShutdown: () => asked++ });
  port = await listen(server);
});
afterAll(() => close(server));

async function cookie(): Promise<string> {
  const minted = await call(port, { method: 'POST', path: '/api/ui/login-code', headers: bearer(TOKEN) });
  const url = new URL(minted.json.url as string);
  const login = await call(port, { path: url.pathname + url.search });
  return login.headers['set-cookie']![0]!.split(';')[0]!;
}

describe('POST /api/shutdown', () => {
  it('stops nothing for a browser or a request without the token', async () => {
    const origin = `http://127.0.0.1:${port}`;
    expect((await call(port, { method: 'POST', path: '/api/shutdown', headers: { cookie: await cookie(), origin } })).status).toBe(401);
    expect((await call(port, { method: 'POST', path: '/api/shutdown' })).status).toBe(401);
    expect((await call(port, { method: 'POST', path: '/api/shutdown', headers: bearer('x'.repeat(48)) })).status).toBe(401);
    expect((await call(port, { path: '/api/shutdown', headers: bearer(TOKEN) })).status).toBe(404);
    expect(asked).toBe(0);
  });

  it('answers the token with 202, then asks the daemon to stop', async () => {
    const r = await call(port, { method: 'POST', path: '/api/shutdown', headers: bearer(TOKEN) });
    expect(r.status).toBe(202);
    expect(r.text).toBe('');
    expect(asked).toBe(1);
  });
});

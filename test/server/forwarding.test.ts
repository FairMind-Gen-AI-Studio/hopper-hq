import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDaemon } from '../../src/daemon.js';
import { readDaemonFile } from '../../src/daemon-file.js';
import { bearer, call } from '../helpers/http.js';
import { isEvent, openSse } from '../helpers/sse.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const stop of cleanup.splice(0).reverse()) await stop();
});

/** A TCP forward preserves Host and Origin just as ssh -L does. */
async function setup(forwarded: boolean | number = true) {
  const dataDir = await mkdtemp(join(tmpdir(), 'shq-forward-'));
  cleanup.push(() => rm(dataDir, { recursive: true, force: true }));
  let remotePort = 0;
  const sockets = new Set<Socket>();
  const tunnel = createServer((client) => {
    const remote = connect(remotePort, '127.0.0.1');
    for (const socket of [client, remote]) {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => { client.destroy(); remote.destroy(); });
    }
    client.pipe(remote).pipe(client);
    client.on('close', () => remote.destroy());
    remote.on('close', () => client.destroy());
  });
  await new Promise<void>((resolve) => tunnel.listen(0, '127.0.0.1', resolve));
  const localPort = (tunnel.address() as { port: number }).port;
  cleanup.push(() => new Promise<void>((resolve) => {
    for (const socket of sockets) socket.destroy();
    tunnel.close(() => resolve());
  }));
  const daemon = await startDaemon({ port: 0, viaPort: typeof forwarded === 'number' ? forwarded : forwarded ? localPort : undefined, dataDir, watchFiles: false, log: () => {} });
  cleanup.push(() => daemon.stop());
  remotePort = daemon.port;
  const token = (await readDaemonFile(dataDir))!.token;
  return { daemon, localPort, token };
}

describe('SSH port forwarding', () => {
  it('signs in and follows live updates through another port', async () => {
    const { daemon, localPort, token } = await setup();
    expect(localPort).not.toBe(daemon.port);
    expect(new URL(daemon.loginUrl()).port).toBe(String(localPort));
    const minted = await call(daemon.port, { method: 'POST', path: '/api/ui/login-code', headers: bearer(token) });
    const url = new URL(minted.json.url);
    expect(url.port).toBe(String(localPort));
    const login = await call(localPort, { path: url.pathname + url.search });
    expect(login.status).toBe(303);
    const cookie = login.headers['set-cookie']![0]!.split(';')[0]!;
    expect(cookie).toMatch(new RegExp(`^shq_${localPort}=`));
    const headers = { cookie, origin: url.origin, 'sec-fetch-site': 'same-origin' };
    expect((await call(localPort, { path: '/api/scene', headers })).status).toBe(200);
    expect((await call(localPort, { method: 'POST', path: '/api/seen', headers })).status).toBe(200);
    expect((await call(localPort, { method: 'POST', path: '/api/ui/login-code', headers })).status).toBe(401);
    const stream = await openSse(localPort, '/api/events', headers);
    try {
      expect(stream.status).toBe(200);
      expect(JSON.parse((await stream.take(isEvent('scene'))).data!).attention.needsYou).toEqual([]);
      await daemon.collector.ingest({ type: 'waiting', sessionId: 'remote-session', ts: Date.now(), source: 'hook', cwd: '/w/remote', reason: { kind: 'permission', text: 'Bash' }, agentId: null });
      const update = JSON.parse((await stream.take(isEvent('scene'))).data!);
      expect(update.attention.needsYou[0].sessionId).toBe('remote-session');
    } finally {
      stream.close();
    }
    expect((await call(localPort, { path: url.pathname + url.search })).status).toBe(401);
    expect((await call(daemon.port, { path: '/api/scene', headers: { cookie } })).status).toBe(401);
    expect((await call(daemon.port, { path: '/api/health', headers: bearer(token) })).status).toBe(200);
    const direct = new URL((await call(daemon.port, { method: 'POST', path: '/api/ui/login-code', headers: bearer(token) })).json.url);
    const directLogin = await call(daemon.port, { path: direct.pathname + direct.search });
    expect(directLogin.headers['set-cookie']![0]).toMatch(new RegExp(`^shq_${daemon.port}=`));
    for (const host of [`localhost:${localPort}`, `127.0.0.1:${localPort}`]) {
      expect((await call(localPort, { path: '/api/health', headers: { ...bearer(token), host, origin: `http://${host}` } })).status).toBe(200);
    }
    for (const host of ['evil.example:7338', '127.0.0.1:1', 'localhost:1', '127.0.0.1', 'localhost']) {
      expect((await call(localPort, { path: '/api/scene', headers: { ...headers, host } })).status).toBe(403);
    }
    for (const origin of ['https://evil.example', 'null', 'http://127.0.0.1', 'http://localhost', 'http://127.0.0.1:1', `https://127.0.0.1:${localPort}`]) {
      expect((await call(localPort, { path: '/api/scene', headers: { ...headers, origin } })).status).toBe(403);
    }
    expect((await call(localPort, { method: 'POST', path: '/api/seen', headers: { ...headers, origin: `http://127.0.0.1:${daemon.port}` } })).status).toBe(403);
  });

  it('refuses forwarded hosts unless the port was configured', async () => {
    const { localPort, token } = await setup(false);
    const reply = await call(localPort, { path: '/api/health', headers: bearer(token) });
    expect(reply.status).toBe(403);
    expect(reply.json.error).toBe('Host not allowed');
  });

  it('accepts the default HTTP port when browsers omit it from Host and Origin', async () => {
    const { daemon, localPort, token } = await setup(80);
    const minted = await call(daemon.port, { method: 'POST', path: '/api/ui/login-code', headers: bearer(token) });
    const url = new URL(minted.json.url);
    expect(url.origin).toBe('http://127.0.0.1');
    // Simulate the browser's default-port headers without binding privileged port 80.
    for (const host of ['127.0.0.1', 'localhost']) {
      const fresh = new URL(daemon.loginUrl());
      const signedIn = await call(localPort, { path: fresh.pathname + fresh.search, headers: { host } });
      expect(signedIn.status).toBe(303);
      const cookie = signedIn.headers['set-cookie']![0]!.split(';')[0]!;
      expect(cookie).toMatch(/^shq_80=/);
      expect((await call(localPort, { method: 'POST', path: '/api/seen', headers: { host, cookie, origin: `http://${host}` } })).status).toBe(200);
      expect((await call(localPort, { method: 'POST', path: '/api/seen', headers: { host, cookie, origin: 'http://evil.example' } })).status).toBe(403);
    }
  });
});

import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { mapHookPayload } from '../adapters/claude-code/hooks.js';
import type { Collector } from '../collector.js';

const VERSION = (createRequire(import.meta.url)('../../package.json') as { version: string }).version;

export interface ApiOptions {
  collector: Collector;
  token: string;
  maxBodyBytes?: number;
  now?: () => number;
}

export function createApiServer(o: ApiOptions): Server {
  return createServer((req, res) => {
    handle(o, req, res).catch(() => send(res, 500, { error: 'Internal error' }));
  });
}

function send(res: ServerResponse, status: number, body?: unknown): void {
  if (res.headersSent) return;
  if (body === undefined) {
    res.writeHead(status).end();
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(JSON.stringify(body));
}

export function allowedHost(host: string | undefined, port: number): boolean {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

export function allowedOrigin(origin: string | undefined, port: number): boolean {
  return origin === undefined || origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

function tokenMatches(header: string | undefined, token: string): boolean {
  if (!header || !header.startsWith('Bearer ')) return false;
  const given = Buffer.from(header.slice('Bearer '.length));
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Resolves the body as text, or null when it exceeds `limit` bytes. */
function readBody(req: IncomingMessage, limit: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (c: Buffer) => {
      if (over) return;
      size += c.length;
      if (size > limit) {
        over = true;
        chunks.length = 0;
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(over ? null : Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handle(o: ApiOptions, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const port = req.socket.localPort ?? 0;
  if (!allowedHost(req.headers.host, port)) return send(res, 403, { error: 'Host not allowed' });
  if (!allowedOrigin(req.headers.origin, port)) return send(res, 403, { error: 'Origin not allowed' });
  if (!tokenMatches(req.headers.authorization, o.token)) return send(res, 401, { error: 'Missing or wrong token' });

  const method = req.method ?? 'GET';
  const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;

  if (method === 'GET' && path === '/api/health') return send(res, 200, { ok: true, version: VERSION });
  if (method === 'GET' && path === '/api/building') return send(res, 200, o.collector.snapshot());
  if (method === 'GET' && path === '/api/attention') return send(res, 200, o.collector.attentionSummary());

  if (method === 'POST' && path === '/api/hooks') {
    const raw = await readBody(req, o.maxBodyBytes ?? 1_000_000);
    if (raw === null) return send(res, 413, { error: 'Payload too large' });
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      return send(res, 400, { error: 'Invalid JSON' });
    }
    const now = (o.now ?? Date.now)();
    const items = Array.isArray(payload) ? payload : [payload];
    for (const item of items) for (const e of mapHookPayload(item, now)) void o.collector.ingest(e);
    return send(res, 204);
  }

  if (method === 'POST' && path === '/api/seen') return send(res, 200, { marked: o.collector.markAllSeen() });

  const seen = path.match(/^\/api\/sessions\/([^/]+)\/seen$/);
  if (method === 'POST' && seen) {
    return o.collector.markSeen(decodeURIComponent(seen[1]!)) ? send(res, 204) : send(res, 404, { error: 'No finished session with that id' });
  }

  return send(res, 404, { error: 'Not found' });
}

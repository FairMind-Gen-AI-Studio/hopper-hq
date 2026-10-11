import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { mapHookPayload } from '../adapters/claude-code/hooks.js';
import type { Collector } from '../collector.js';
import { API_HEADERS, setBaseHeaders } from './headers.js';

const VERSION = (createRequire(import.meta.url)('../../package.json') as { version: string }).version;

export interface ApiOptions {
  collector: Collector;
  token: string;
  maxBodyBytes?: number;
  now?: () => number;
}

type Deps = Required<ApiOptions>;

function withDefaults(o: ApiOptions): Deps {
  return {
    collector: o.collector,
    token: o.token,
    maxBodyBytes: o.maxBodyBytes ?? 1_000_000,
    now: o.now ?? Date.now,
  };
}

/** Who may call a route. */
export type AuthLevel = 'public' | 'bearer' | 'read' | 'write';

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  /** The port this request arrived on. */
  port: number;
  /** Groups captured by a pattern path. */
  params: string[];
}

interface Route {
  methods: readonly string[];
  /** An exact path, or a pattern whose groups become `params`. */
  path: string | RegExp;
  auth: AuthLevel;
  run(c: Ctx): void | Promise<void>;
}

const GET = ['GET'];
const POST = ['POST'];

function routes(d: Deps): Route[] {
  return [
    { methods: GET, path: '/api/health', auth: 'bearer', run: ({ res }) => send(res, 200, { ok: true, version: VERSION }) },
    { methods: GET, path: '/api/building', auth: 'bearer', run: ({ res }) => send(res, 200, d.collector.snapshot()) },
    { methods: GET, path: '/api/attention', auth: 'bearer', run: ({ res }) => send(res, 200, d.collector.attentionSummary()) },
    { methods: POST, path: '/api/hooks', auth: 'bearer', run: (c) => postHooks(d, c) },
    { methods: POST, path: '/api/seen', auth: 'write', run: ({ res }) => send(res, 200, { marked: d.collector.markAllSeen() }) },
    {
      methods: POST,
      path: /^\/api\/sessions\/([^/]+)\/seen$/,
      auth: 'write',
      run: ({ res, params }) =>
        d.collector.markSeen(decodeURIComponent(params[0]!)) ? send(res, 204) : send(res, 404, { error: 'No finished session with that id' }),
    },
  ];
}

function findRoute(table: Route[], method: string, path: string): { route: Route; params: string[] } | null {
  for (const route of table) {
    if (!route.methods.includes(method)) continue;
    if (typeof route.path === 'string') {
      if (route.path === path) return { route, params: [] };
      continue;
    }
    const m = route.path.exec(path);
    if (m) return { route, params: m.slice(1) };
  }
  return null;
}

export function createApiServer(o: ApiOptions): Server {
  const d = withDefaults(o);
  const table = routes(d);
  return createServer((req, res) => {
    setBaseHeaders(res);
    handle(d, table, req, res).catch(() => send(res, 500, { error: 'Internal error' }));
  });
}

function send(res: ServerResponse, status: number, body?: unknown): void {
  if (res.headersSent) return;
  if (body === undefined) {
    res.writeHead(status, API_HEADERS).end();
    return;
  }
  res.writeHead(status, { ...API_HEADERS, 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(body));
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

async function handle(d: Deps, table: Route[], req: IncomingMessage, res: ServerResponse): Promise<void> {
  const port = req.socket.localPort ?? 0;
  if (!allowedHost(req.headers.host, port)) return send(res, 403, { error: 'Host not allowed' });
  if (!allowedOrigin(req.headers.origin, port)) return send(res, 403, { error: 'Origin not allowed' });

  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const found = findRoute(table, req.method ?? 'GET', url.pathname);
  if (!found) return send(res, 404, { error: 'Not found' });
  if (found.route.auth !== 'public' && !tokenMatches(req.headers.authorization, d.token)) return send(res, 401, { error: 'Missing or wrong token' });
  await found.route.run({ req, res, url, port, params: found.params });
}

async function postHooks(d: Deps, { req, res }: Ctx): Promise<void> {
  const raw = await readBody(req, d.maxBodyBytes);
  if (raw === null) return send(res, 413, { error: 'Payload too large' });
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return send(res, 400, { error: 'Invalid JSON' });
  }
  const now = d.now();
  const items = Array.isArray(payload) ? payload : [payload];
  for (const item of items) for (const e of mapHookPayload(item, now)) void d.collector.ingest(e);
  return send(res, 204);
}

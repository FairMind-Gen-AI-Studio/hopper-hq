import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { mapHookPayload } from '../adapters/claude-code/hooks.js';
import type { Collector } from '../collector.js';
import { authorize, loginUrl, UiAuth, type AuthLevel } from './auth.js';
import { API_HEADERS, HTML_HEADERS, setBaseHeaders } from './headers.js';

const VERSION = (createRequire(import.meta.url)('../../package.json') as { version: string }).version;

export interface ApiOptions {
  collector: Collector;
  token: string;
  maxBodyBytes?: number;
  now?: () => number;
  /** Sign-in codes and cookies; share one with the daemon so it can mint codes itself. */
  auth?: UiAuth;
}

type Deps = Required<ApiOptions>;

function withDefaults(o: ApiOptions): Deps {
  return {
    collector: o.collector,
    token: o.token,
    maxBodyBytes: o.maxBodyBytes ?? 1_000_000,
    now: o.now ?? Date.now,
    auth: o.auth ?? new UiAuth({ token: o.token, now: o.now }),
  };
}

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
    { methods: GET, path: '/', auth: 'public', run: ({ res }) => redirect(res, 302, '/ui/') },
    { methods: GET, path: '/ui/login', auth: 'public', run: (c) => login(d, c) },
    { methods: GET, path: '/api/health', auth: 'bearer', run: ({ res }) => send(res, 200, { ok: true, version: VERSION }) },
    { methods: GET, path: '/api/building', auth: 'bearer', run: ({ res }) => send(res, 200, d.collector.snapshot()) },
    { methods: GET, path: '/api/attention', auth: 'bearer', run: ({ res }) => send(res, 200, d.collector.attentionSummary()) },
    { methods: POST, path: '/api/hooks', auth: 'bearer', run: (c) => postHooks(d, c) },
    { methods: POST, path: '/api/ui/login-code', auth: 'bearer', run: (c) => postLoginCode(d, c) },
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

function redirect(res: ServerResponse, status: 302 | 303, location: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { ...API_HEADERS, ...headers, location }).end();
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { ...HTML_HEADERS, 'content-type': 'text/html; charset=utf-8' }).end(html);
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
  const denied = authorize(found.route.auth, req, port, d.token, d.auth);
  if (denied) return send(res, denied.status, { error: denied.error });
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

function postLoginCode(d: Deps, { res, port }: Ctx): void {
  const { code, expiresAt } = d.auth.issueCode();
  send(res, 200, { url: loginUrl(port, code), expiresAt });
}

const EXPIRED_PAGE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>scranton-hq</title></head>
<body><p>This sign-in link has expired or was already used. Run <code>scranton-hq ui</code> again.</p></body>
</html>
`;

/** Spends a one-time code and signs the browser in. The redirect takes the code out of the address bar. */
function login(d: Deps, { res, url, port }: Ctx): void {
  if (!d.auth.redeemCode(url.searchParams.get('code') ?? '')) return sendHtml(res, 401, EXPIRED_PAGE);
  redirect(res, 303, '/ui/', { 'set-cookie': d.auth.cookie(port) });
}

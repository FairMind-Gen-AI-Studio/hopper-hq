import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { mapHookPayload } from '../adapters/claude-code/hooks.js';
import type { WatcherHealth } from '../adapters/claude-code/fs-adapter.js';
import type { Collector } from '../collector.js';
import { isSessionId, KEY_MAX } from '../scene/text.js';
import type { SummaryStatus } from '../summary/summarizer.js';
import { authorize, loginUrl, UiAuth, type AuthLevel } from './auth.js';
import { SceneHub } from './events.js';
import { simulatedFocusDriver, type FocusDriver } from './focus.js';
import { API_HEADERS, ASSET_HEADERS, HTML_HEADERS, setBaseHeaders } from './headers.js';
import type { UiBundle, UiFile } from './static.js';

const VERSION = (createRequire(import.meta.url)('../../package.json') as { version: string }).version;

export interface ApiOptions {
  collector: Collector;
  token: string;
  maxBodyBytes?: number;
  now?: () => number;
  /** Sign-in codes and cookies; share one with the daemon so it can mint codes itself. */
  auth?: UiAuth;
  /** The built browser UI; null answers 503 at /ui/. */
  ui?: UiBundle | null;
  /** Live views; the daemon passes its own so that it can close them on stop. */
  hub?: SceneHub;
  /** Switches tmux to a session's pane. Defaults to the simulated driver: nothing reaches tmux unless the daemon wires the real one. */
  focus?: FocusDriver;
  /** Called when the CLI asks the daemon to stop (`hopper-hq down`), once the answer is sent. Default: nothing stops. */
  onShutdown?: () => void;
  /** Reports on summaries at GET /api/summaries. Default: none, and that route answers 503. */
  summarizer?: { status(): Promise<SummaryStatus> } | null;
  /** The file watcher's last finished scan, shown at GET /api/health. Default: none, and the answer carries no watcher. */
  watcher?: (() => WatcherHealth | null) | null;
}

type Deps = Required<ApiOptions>;

function withDefaults(o: ApiOptions): Deps {
  return {
    collector: o.collector,
    token: o.token,
    maxBodyBytes: o.maxBodyBytes ?? 1_000_000,
    now: o.now ?? Date.now,
    auth: o.auth ?? new UiAuth({ token: o.token, now: o.now }),
    ui: o.ui ?? null,
    hub: o.hub ?? new SceneHub({ source: o.collector }),
    focus: o.focus ?? simulatedFocusDriver,
    onShutdown: o.onShutdown ?? (() => {}),
    summarizer: o.summarizer ?? null,
    watcher: o.watcher ?? null,
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
const GET_HEAD = ['GET', 'HEAD'];
const POST = ['POST'];

function routes(d: Deps): Route[] {
  return [
    { methods: GET, path: '/', auth: 'public', run: ({ res }) => redirect(res, 302, '/ui/') },
    { methods: GET, path: '/ui', auth: 'public', run: ({ res }) => redirect(res, 302, '/ui/') },
    { methods: GET_HEAD, path: '/ui/', auth: 'public', run: ({ res }) => serveIndex(d, res) },
    { methods: GET_HEAD, path: '/ui/index.html', auth: 'public', run: ({ res }) => serveIndex(d, res) },
    { methods: GET_HEAD, path: /^\/ui\/assets\//, auth: 'public', run: ({ res, url }) => serveAsset(d, res, url.pathname) },
    { methods: GET, path: '/ui/login', auth: 'public', run: (c) => login(d, c) },
    { methods: GET, path: '/api/health', auth: 'bearer', run: ({ res }) => send(res, 200, health(d)) },
    { methods: GET, path: '/api/building', auth: 'bearer', run: ({ res }) => send(res, 200, d.collector.snapshot()) },
    { methods: GET, path: '/api/attention', auth: 'bearer', run: ({ res }) => send(res, 200, d.collector.attentionSummary()) },
    { methods: GET, path: '/api/summaries', auth: 'bearer', run: ({ res }) => getSummaries(d, res) },
    { methods: POST, path: '/api/hooks', auth: 'bearer', run: (c) => postHooks(d, c) },
    { methods: POST, path: '/api/ui/login-code', auth: 'bearer', run: (c) => postLoginCode(d, c) },
    { methods: POST, path: '/api/shutdown', auth: 'bearer', run: ({ res }) => postShutdown(d, res) },
    { methods: GET, path: '/api/scene', auth: 'read', run: ({ res }) => send(res, 200, d.collector.scene()) },
    { methods: GET, path: '/api/floor', auth: 'read', run: (c) => getFloor(d, c) },
    { methods: GET, path: '/api/events', auth: 'read', run: (c) => getEvents(d, c) },
    { methods: POST, path: '/api/focus', auth: 'write', run: (c) => postFocus(d, c) },
    { methods: POST, path: '/api/seen', auth: 'write', run: ({ res }) => send(res, 200, { marked: d.collector.markAllSeen() }) },
    {
      methods: POST,
      path: /^\/api\/sessions\/([^/]+)\/seen$/,
      auth: 'write',
      run: ({ res, params }) => {
        const id = decoded(params[0]!);
        return isSessionId(id) && d.collector.markSeen(id) ? send(res, 204) : send(res, 404, { error: 'No finished session with that id' });
      },
    },
  ];
}

/** A percent-decoded path, or null when it is not valid percent-encoding. */
function decoded(path: string): string | null {
  try {
    return decodeURIComponent(path);
  } catch {
    return null;
  }
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

  // An absolute-form target ('GET http://… HTTP/1.1') can be any text.
  const target = req.url ?? '/';
  if (!URL.canParse(target, 'http://127.0.0.1')) return send(res, 400, { error: 'Bad request target' });
  const url = new URL(target, 'http://127.0.0.1');
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

async function getSummaries(d: Deps, res: ServerResponse): Promise<void> {
  if (!d.summarizer) return send(res, 503, { error: 'Summaries are not available' });
  send(res, 200, await d.summarizer.status());
}

/** Every floor key is cut to KEY_MAX code points, at most twice as many UTF-16 code units: nothing longer is a floor. */
const MAX_KEY = 2 * KEY_MAX;

function getFloor(d: Deps, { res, url }: Ctx): void {
  const key = url.searchParams.get('key');
  if (!key || key.length > MAX_KEY) return send(res, 400, { error: `Give a floor key of 1 to ${MAX_KEY} characters: /api/floor?key=...` });
  const floor = d.collector.floor(key);
  if (!floor) return send(res, 404, { error: 'No such floor' });
  send(res, 200, floor);
}

/**
 * Opens a live view: the scene, plus the floor named by `?floor=` (null while there is no such floor). Changing floor means
 * opening a new stream. A key longer than MAX_KEY is no such floor either, not an error: the key comes from the page's
 * address, and EventSource gives up on any status but 200.
 */
function getEvents(d: Deps, { res, url }: Ctx): void {
  if (!d.hub.attach(res, url.searchParams.get('floor') || null)) send(res, 503, { error: 'Too many live views' });
}

/** Switches the user's tmux client to a session's pane. The pane is looked up from the session, never taken from the request. */
async function postFocus(d: Deps, { req, res }: Ctx): Promise<void> {
  if (!/^application\/json(;|$)/i.test(req.headers['content-type'] ?? '')) return send(res, 415, { error: 'Send JSON' });
  const raw = await readBody(req, 1024);
  let sessionId: unknown;
  try {
    sessionId = (JSON.parse(raw ?? '') as { sessionId?: unknown } | null)?.sessionId;
  } catch {
    sessionId = undefined;
  }
  if (!isSessionId(sessionId)) return send(res, 400, { error: 'Send {"sessionId": "<id>"}, at most 1 KB' });
  const v = d.collector.view(sessionId);
  if (!v) return send(res, 404, { error: 'No such session' });
  if (v.effectiveState === 'ended') return send(res, 409, { error: 'The session has ended' });
  if (v.location !== 'local') return send(res, 409, { error: 'The session does not run on this machine' });
  if (!v.tmuxPane) return send(res, 409, { error: 'The session is not in a tmux pane' });
  const outcome = await d.focus.focus(v.tmuxPane, v.tmuxSession);
  if (outcome.ok) return send(res, 200, { pane: v.tmuxPane, simulated: d.focus.simulated });
  if (outcome.reason === 'tmux_failed') return send(res, 502, { error: 'tmux could not switch to the pane' });
  if (outcome.reason === 'other_session') return send(res, 409, { error: 'The pane is on another tmux server or session' });
  send(res, 409, { error: outcome.reason === 'no_client' ? 'No tmux client is attached' : 'The session is not in a tmux pane' });
}

/** Answers first: stopping closes every connection, this one included. */
function postShutdown(d: Deps, res: ServerResponse): void {
  res.once('finish', () => d.onShutdown());
  send(res, 202);
}

function postLoginCode(d: Deps, { res, port }: Ctx): void {
  const { code, expiresAt } = d.auth.issueCode();
  send(res, 200, { url: loginUrl(port, code), expiresAt });
}

const EXPIRED_PAGE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>hopper-hq</title></head>
<body><p>This sign-in link has expired or was already used. Run <code>hopper-hq ui</code> again.</p></body>
</html>
`;

/**
 * Spends a one-time code and signs the browser in. The redirect takes the code out of the address bar.
 * A browser already signed in goes on to the UI whatever its link: a reload, the history, a link opened twice.
 */
function login(d: Deps, { req, res, url, port }: Ctx): void {
  if (d.auth.redeemCode(url.searchParams.get('code') ?? '')) return redirect(res, 303, '/ui/', { 'set-cookie': d.auth.cookie(port) });
  if (d.auth.hasCookie(req.headers.cookie, port)) return redirect(res, 303, '/ui/');
  sendHtml(res, 401, EXPIRED_PAGE);
}

function sendFile(res: ServerResponse, file: UiFile, headers: Readonly<Record<string, string>>): void {
  res.writeHead(200, { ...headers, 'content-type': file.type, 'content-length': String(file.body.length) }).end(file.body);
}

function serveIndex(d: Deps, res: ServerResponse): void {
  const index = d.ui?.get('/ui/index.html');
  if (index) return sendFile(res, index, HTML_HEADERS);
  res.writeHead(503, { ...API_HEADERS, 'content-type': 'text/plain; charset=utf-8' }).end('The UI is not built. Run: npm run build\n');
}

function serveAsset(d: Deps, res: ServerResponse, pathname: string): void {
  const path = decoded(pathname);
  const file = path === null ? undefined : d.ui?.get(path);
  if (!file) return send(res, 404, { error: 'Not found' });
  sendFile(res, file, ASSET_HEADERS);
}

/** A watcher whose last scan is older than this is stalled: scans run every second and a hung one is given up on after 30s. */
export const WATCHER_STALL_MS = 60_000;

function health(d: Deps): { ok: true; version: string; watcher?: { lastScanAt: number; ageMs: number; stalled: boolean } } {
  const w = d.watcher?.();
  if (!w) return { ok: true, version: VERSION };
  const ageMs = Math.max(0, d.now() - w.lastScanAt);
  return { ok: true, version: VERSION, watcher: { lastScanAt: w.lastScanAt, ageMs, stalled: ageMs > WATCHER_STALL_MS } };
}

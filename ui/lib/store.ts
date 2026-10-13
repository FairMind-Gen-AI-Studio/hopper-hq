/**
 * The page's view of the daemon: the building scene and the watched floor, kept live by one EventSource on
 * GET /api/events. Implements the Svelte store contract without importing Svelte (outline §2.12).
 *
 * The stream opens on the first subscriber or the first watched floor, whichever comes first, and reopens with
 * ?floor= when the watched floor changes. A page holds one stream at most: the old one is closed before a new one
 * opens (a browser allows about six connections per host, and each EventSource keeps one). When the stream fails:
 * - while the browser reconnects by itself (readyState CONNECTING: the daemon stopped or restarted), the page shows
 *   retrying until the stream opens again;
 * - when the browser gives up (CLOSED: an answer other than 200, such as 401 or 503 at the client limit), it never
 *   retries by itself. GET /api/scene tells why: 401 means signed out, and the store stops; anything else means
 *   retrying, and the stream reopens after RETRY_MS, doubling on each failure up to RETRY_MAX_MS, and back to
 *   RETRY_MS once a stream opens.
 *
 * Every tab of the browser shares those six connections, and `scranton-hq ui` opens a new tab each time. So a page
 * hidden for HIDDEN_GRACE_MS (another tab in front, the window minimised) closes its stream and stops retrying, and
 * opens the stream again as soon as it is shown. The daemon sends the scene on connect, so the page is current at once.
 */
import { SCENE_VERSION, type BuildingScene, type FloorDetail } from '../../src/scene/types';

/** 'outdated': the daemon sends another version of the scene than this page draws; only a reload helps. */
export type Connection = 'connecting' | 'live' | 'retrying' | 'signed_out' | 'outdated';

export interface ClientState {
  connection: Connection;
  scene: BuildingScene | null;
  floorKey: string | null;
  /** undefined = loading, null = no such floor. */
  floor: FloorDetail | null | undefined;
}

export interface EventSourceLike {
  addEventListener(type: string, fn: (e: { data: string }) => void): void;
  close(): void;
  readonly readyState: number;
  onerror: (() => void) | null;
  onopen: (() => void) | null;
}

/** Whether the page is hidden, and news of each change. */
export interface PageVisibility {
  hidden(): boolean;
  /** Calls `fn` each time the page is hidden or shown; the answer stops it. */
  onChange(fn: () => void): () => void;
}

export interface StoreDeps {
  openStream(url: string): EventSourceLike;
  /** Status of GET /api/scene. */
  probe(): Promise<number>;
  /** Without it, the page counts as always shown. */
  visibility?: PageVisibility;
}

export interface ClientStore {
  subscribe(run: (s: ClientState) => void): () => void;
  get(): ClientState;
  /** Reopens the stream with ?floor= (or without, for null). */
  watchFloor(key: string | null): void;
  close(): void;
}

export const RETRY_MS = 3000;
export const RETRY_MAX_MS = 30_000;
/**
 * How long a hidden page keeps its stream. A look at the terminal keeps it; a tab left behind frees its connection well
 * within the minute a sign-in link lasts, so a new tab's sign-in never waits for one.
 */
export const HIDDEN_GRACE_MS = 15_000;
const CLOSED = 2;

function parse(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return undefined;
  }
}

function isScene(x: unknown): x is BuildingScene {
  const s = x as BuildingScene | null;
  return typeof s === 'object' && s !== null && s.version === SCENE_VERSION && Array.isArray(s.floors) &&
    Array.isArray(s.attention?.needsYou) && Array.isArray(s.attention?.done);
}

function isFloor(x: unknown): x is FloorDetail {
  const f = x as FloorDetail | null;
  return typeof f === 'object' && f !== null && f.version === SCENE_VERSION && typeof f.key === 'string' && Array.isArray(f.islands);
}

/** A scene or a floor of a version this page does not draw: the daemon was updated, or went back, since it loaded. */
function otherVersion(x: unknown): boolean {
  const version = typeof x === 'object' && x !== null ? (x as { version?: unknown }).version : undefined;
  return typeof version === 'number' && version !== SCENE_VERSION;
}

export function createClientStore(deps: StoreDeps): ClientStore {
  let state: ClientState = { connection: 'connecting', scene: null, floorKey: null, floor: undefined };
  const subscribers = new Set<(s: ClientState) => void>();
  let stream: EventSourceLike | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let started = false;
  let closed = false;
  /** Failed attempts in a row: the next retry waits RETRY_MS * 2^failures, at most RETRY_MAX_MS. */
  let failures = 0;
  /** The page has been hidden long enough: no stream and no retry until it is shown. */
  let paused = false;
  let hiding: ReturnType<typeof setTimeout> | null = null;
  /** The daemon speaks another version of the scene: the stream stays closed, and the page asks for a reload. */
  let outdated = false;

  function set(patch: Partial<ClientState>): void {
    const next = { ...state, ...patch };
    if ((Object.keys(next) as (keyof ClientState)[]).every((k) => Object.is(next[k], state[k]))) return;
    state = next;
    for (const run of [...subscribers]) run(state);
  }

  function stopRetry(): void {
    if (retry !== null) clearTimeout(retry);
    retry = null;
  }

  function open(): void {
    stopRetry();
    // Close first: two streams must never hold two of the browser's connections at once.
    stream?.close();
    stream = null;
    started = true;
    if (paused || outdated) return;
    const key = state.floorKey;
    const es = deps.openStream('/api/events' + (key === null ? '' : '?floor=' + encodeURIComponent(key)));
    stream = es;
    const current = () => !closed && stream === es;
    es.onopen = () => {
      if (!current()) return;
      failures = 0;
      set({ connection: 'live' });
    };
    es.addEventListener('scene', (e) => {
      const scene = parse(e.data);
      if (!current()) return;
      if (otherVersion(scene)) outdate();
      else if (isScene(scene)) set({ scene, connection: 'live' });
    });
    es.addEventListener('floor', (e) => {
      const floor = parse(e.data);
      if (!current() || state.floorKey !== key) return;
      if (otherVersion(floor)) outdate();
      else if (floor === null) set({ floor: null, connection: 'live' });
      else if (isFloor(floor) && floor.key === key) set({ floor, connection: 'live' });
    });
    es.onerror = () => {
      if (!current()) return;
      if (es.readyState !== CLOSED) {
        set({ connection: 'retrying' });
        return;
      }
      es.close();
      stream = null;
      const gaveUp = () => !closed && !paused && stream === null && retry === null;
      deps.probe().then(
        (status) => {
          if (!gaveUp()) return;
          if (status === 401) set({ connection: 'signed_out' });
          else scheduleRetry();
        },
        () => {
          if (gaveUp()) scheduleRetry();
        },
      );
    };
  }

  /** What the page shows stays as it is; nothing opens the stream again. */
  function outdate(): void {
    outdated = true;
    stopRetry();
    stream?.close();
    stream = null;
    set({ connection: 'outdated' });
  }

  function scheduleRetry(): void {
    set({ connection: 'retrying' });
    const delay = Math.min(RETRY_MAX_MS, RETRY_MS * 2 ** failures);
    failures++;
    retry = setTimeout(() => {
      retry = null;
      if (!closed) open();
    }, delay);
  }

  /** The page has stayed hidden: free its connection until it is shown. What it shows stays as it is. */
  function pause(): void {
    hiding = null;
    paused = true;
    stopRetry();
    stream?.close();
    stream = null;
  }

  function onVisibility(): void {
    if (closed) return;
    if (deps.visibility!.hidden()) {
      if (!paused && hiding === null) hiding = setTimeout(pause, HIDDEN_GRACE_MS);
      return;
    }
    if (hiding !== null) clearTimeout(hiding);
    hiding = null;
    if (!paused) return;
    paused = false;
    // Signed out stays signed out: only a new sign-in link helps.
    if (started && state.connection !== 'signed_out') open();
  }

  const stopWatching = deps.visibility?.onChange(onVisibility);
  if (deps.visibility) onVisibility();

  return {
    subscribe(run) {
      subscribers.add(run);
      run(state);
      if (!started && !closed) open();
      return () => void subscribers.delete(run);
    },
    get: () => state,
    watchFloor(key) {
      if (closed || (started && key === state.floorKey)) return;
      set({ floorKey: key, floor: undefined });
      open();
    },
    close() {
      closed = true;
      stopRetry();
      if (hiding !== null) clearTimeout(hiding);
      hiding = null;
      stopWatching?.();
      stream?.close();
      stream = null;
      subscribers.clear();
    },
  };
}

/** A browser EventSource seen through EventSourceLike, whose handlers take no argument. The cookie goes with it (same origin). */
class BrowserStream implements EventSourceLike {
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;
  private readonly es: EventSource;

  constructor(url: string) {
    this.es = new EventSource(url);
    this.es.onerror = () => this.onerror?.();
    this.es.onopen = () => this.onopen?.();
  }

  get readyState(): number {
    return this.es.readyState;
  }

  addEventListener(type: string, fn: (e: { data: string }) => void): void {
    this.es.addEventListener(type, (e) => fn(e));
  }

  close(): void {
    this.es.close();
  }
}

/** The real browser: an EventSource, a probe of GET /api/scene, and the document's visibility. */
export function browserStoreDeps(): StoreDeps {
  return {
    openStream: (url) => new BrowserStream(url),
    probe: () => fetch('/api/scene', { credentials: 'same-origin' }).then((r) => r.status),
    visibility: {
      hidden: () => document.visibilityState === 'hidden',
      onChange(fn) {
        document.addEventListener('visibilitychange', fn);
        return () => document.removeEventListener('visibilitychange', fn);
      },
    },
  };
}

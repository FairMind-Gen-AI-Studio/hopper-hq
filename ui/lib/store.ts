/**
 * The page's view of the daemon: the building scene and the watched floor, kept live by one EventSource on
 * GET /api/events. Implements the Svelte store contract without importing Svelte (outline §2.12).
 *
 * The stream opens on the first subscriber or the first watched floor, whichever comes first, and reopens with
 * ?floor= when the watched floor changes. When it fails:
 * - while the browser reconnects by itself (readyState CONNECTING: the daemon stopped or restarted), the page shows
 *   retrying until the stream opens again;
 * - when the browser gives up (CLOSED), GET /api/scene tells why: 401 means signed out, and the store stops; anything
 *   else means retrying, and the stream reopens after RETRY_MS.
 */
import { SCENE_VERSION, type BuildingScene, type FloorDetail } from '../../src/scene/types';

export type Connection = 'connecting' | 'live' | 'retrying' | 'signed_out';

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

export interface StoreDeps {
  openStream(url: string): EventSourceLike;
  /** Status of GET /api/scene. */
  probe(): Promise<number>;
}

export interface ClientStore {
  subscribe(run: (s: ClientState) => void): () => void;
  get(): ClientState;
  /** Reopens the stream with ?floor= (or without, for null). */
  watchFloor(key: string | null): void;
  close(): void;
}

export const RETRY_MS = 3000;
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

export function createClientStore(deps: StoreDeps): ClientStore {
  let state: ClientState = { connection: 'connecting', scene: null, floorKey: null, floor: undefined };
  const subscribers = new Set<(s: ClientState) => void>();
  let stream: EventSourceLike | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let started = false;
  let closed = false;

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
    stream?.close();
    started = true;
    const key = state.floorKey;
    const es = deps.openStream('/api/events' + (key === null ? '' : '?floor=' + encodeURIComponent(key)));
    stream = es;
    const current = () => !closed && stream === es;
    es.onopen = () => {
      if (current()) set({ connection: 'live' });
    };
    es.addEventListener('scene', (e) => {
      const scene = parse(e.data);
      if (current() && isScene(scene)) set({ scene, connection: 'live' });
    });
    es.addEventListener('floor', (e) => {
      const floor = parse(e.data);
      if (!current() || state.floorKey !== key) return;
      if (floor === null) set({ floor: null, connection: 'live' });
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
      const gaveUp = () => !closed && stream === null && retry === null;
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

  function scheduleRetry(): void {
    set({ connection: 'retrying' });
    retry = setTimeout(() => {
      retry = null;
      if (!closed) open();
    }, RETRY_MS);
  }

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

/** The real browser: an EventSource, and a probe of GET /api/scene. */
export function browserStoreDeps(): StoreDeps {
  return {
    openStream: (url) => new BrowserStream(url),
    probe: () => fetch('/api/scene', { credentials: 'same-origin' }).then((r) => r.status),
  };
}

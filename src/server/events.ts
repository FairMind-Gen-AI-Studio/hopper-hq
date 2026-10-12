import type { ServerResponse } from 'node:http';
import type { BuildingScene, FloorDetail } from '../scene/types.js';

/** What the hub reads. The Collector is one. */
export interface SceneSource {
  /** The scene and each of `floors` in detail (null when there is no such floor), all at one moment. */
  render(floors: readonly string[]): { scene: BuildingScene; floors: ReadonlyMap<string, FloorDetail | null> };
  onChange(fn: () => void): () => void;
}

export interface SceneHubOptions {
  source: SceneSource;
  /** Live views at once (default 16). */
  maxClients?: number;
  /** Delay between a change and the flush it schedules (default 250 ms). */
  coalesceMs?: number;
  /** Flush period for states that change with time: done -> idle, no_signal, dormant (default 15 s). */
  tickMs?: number;
  /** Comment period that keeps idle connections open (default 25 s). */
  heartbeatMs?: number;
  /** Output a client may leave unread before it is dropped (default 1 MiB). Every event carries full state: a client that reconnects has lost nothing. */
  maxBufferedBytes?: number;
  /** Where a scene that cannot be built is reported (default stderr). */
  log?: (line: string) => void;
}

export const SSE_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-store',
  'x-accel-buffering': 'no',
};

interface Client {
  res: ServerResponse;
  /** The floor this client watches, or null. */
  floor: string | null;
  /** The last payloads sent, as serialized. */
  scene: string | null;
  detail: string | null;
}

/**
 * Pushes the building scene to every browser, and to each browser the floor it watches, as server-sent events.
 * Changes are coalesced: one flush builds the scene once and each watched floor once, whatever the number of
 * clients, and a client gets an event only when its payload differs from the last one it received.
 */
export class SceneHub {
  private readonly clients = new Set<Client>();
  private readonly o: Required<SceneHubOptions>;
  private readonly unsubscribe: () => void;
  private pending: NodeJS.Timeout | null = null;
  private tick: NodeJS.Timeout | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(o: SceneHubOptions) {
    this.o = {
      source: o.source,
      maxClients: o.maxClients ?? 16,
      coalesceMs: o.coalesceMs ?? 250,
      tickMs: o.tickMs ?? 15_000,
      heartbeatMs: o.heartbeatMs ?? 25_000,
      maxBufferedBytes: o.maxBufferedBytes ?? 1024 * 1024,
      log: o.log ?? ((line) => process.stderr.write(line + '\n')),
    };
    this.unsubscribe = o.source.onChange(() => this.schedule());
  }

  get size(): number {
    return this.clients.size;
  }

  /**
   * Starts a stream on `res`. False when the hub is full or closed: the caller answers 503.
   * The payloads are built first: when the scene code throws, the error reaches the caller and nothing is registered.
   */
  attach(res: ServerResponse, floor: string | null): boolean {
    if (this.closed || this.clients.size >= this.o.maxClients) return false;
    const view = this.o.source.render(floor === null ? [] : [floor]);
    const scene = JSON.stringify(view.scene);
    const detail = floor === null ? null : JSON.stringify(view.floors.get(floor) ?? null);
    const client: Client = { res, floor, scene: null, detail: null };
    this.clients.add(client);
    res.on('close', () => this.detach(client));
    res.writeHead(200, SSE_HEADERS);
    this.write(client, 'retry: 3000\n\n');
    this.send(client, scene, detail);
    this.startTimers();
    return true;
  }

  /** Builds the scene and the watched floors now, and sends each client what changed for it. */
  flush(): void {
    if (this.pending) clearTimeout(this.pending);
    this.pending = null;
    if (this.clients.size === 0) return;
    let scene: string;
    const floors = new Map<string, string>();
    try {
      const keys = [...new Set([...this.clients].flatMap((c) => (c.floor === null ? [] : [c.floor])))];
      const view = this.o.source.render(keys);
      scene = JSON.stringify(view.scene);
      for (const key of keys) floors.set(key, JSON.stringify(view.floors.get(key) ?? null));
    } catch (err) {
      // Flushes run from timers, where a throw would take the daemon down. Clients keep what they have; the next change or tick tries again.
      this.o.log(`scranton-hq could not build the live view: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    for (const c of this.clients) this.send(c, scene, c.floor === null ? null : floors.get(c.floor)!);
  }

  /** Ends every stream and stops listening. Later attaches are refused. */
  close(): void {
    this.closed = true;
    this.unsubscribe();
    this.stopTimers();
    const clients = [...this.clients];
    this.clients.clear();
    for (const c of clients) c.res.end();
  }

  private send(c: Client, scene: string, detail: string | null): void {
    if (scene !== c.scene) {
      if (!this.write(c, `event: scene\ndata: ${scene}\n\n`)) return;
      c.scene = scene;
    }
    if (detail !== null && detail !== c.detail) {
      if (!this.write(c, `event: floor\ndata: ${detail}\n\n`)) return;
      c.detail = detail;
    }
  }

  /** Writes to a client, unless it has stopped reading: then it is dropped, and the answer is false. */
  private write(c: Client, chunk: string): boolean {
    if (c.res.writableLength > this.o.maxBufferedBytes) {
      this.detach(c);
      c.res.destroy();
      return false;
    }
    c.res.write(chunk);
    return true;
  }

  private schedule(): void {
    if (this.pending || this.clients.size === 0) return;
    this.pending = setTimeout(() => this.flush(), this.o.coalesceMs);
  }

  private detach(c: Client): void {
    if (this.clients.delete(c) && this.clients.size === 0) this.stopTimers();
  }

  private startTimers(): void {
    if (this.tick) return;
    this.tick = setInterval(() => this.flush(), this.o.tickMs);
    this.heartbeat = setInterval(() => {
      for (const c of this.clients) this.write(c, ': ping\n\n');
    }, this.o.heartbeatMs);
  }

  private stopTimers(): void {
    if (this.pending) clearTimeout(this.pending);
    if (this.tick) clearInterval(this.tick);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.pending = this.tick = this.heartbeat = null;
  }
}

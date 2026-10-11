import type { ServerResponse } from 'node:http';
import type { BuildingScene, FloorDetail } from '../scene/types.js';

/** What the hub reads. The Collector is one. */
export interface SceneSource {
  scene(): BuildingScene;
  floor(key: string): FloorDetail | null;
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
    };
    this.unsubscribe = o.source.onChange(() => this.schedule());
  }

  get size(): number {
    return this.clients.size;
  }

  /** Starts a stream on `res`. False when the hub is full or closed: the caller answers 503. */
  attach(res: ServerResponse, floor: string | null): boolean {
    if (this.closed || this.clients.size >= this.o.maxClients) return false;
    const client: Client = { res, floor, scene: null, detail: null };
    this.clients.add(client);
    res.on('close', () => this.detach(client));
    res.writeHead(200, SSE_HEADERS);
    res.write('retry: 3000\n\n');
    this.send(client, JSON.stringify(this.o.source.scene()), floor === null ? null : JSON.stringify(this.o.source.floor(floor)));
    this.startTimers();
    return true;
  }

  /** Builds the scene and the watched floors now, and sends each client what changed for it. */
  flush(): void {
    if (this.pending) clearTimeout(this.pending);
    this.pending = null;
    if (this.clients.size === 0) return;
    const scene = JSON.stringify(this.o.source.scene());
    const floors = new Map<string, string>();
    for (const c of this.clients) {
      if (c.floor !== null && !floors.has(c.floor)) floors.set(c.floor, JSON.stringify(this.o.source.floor(c.floor)));
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
      c.res.write(`event: scene\ndata: ${scene}\n\n`);
      c.scene = scene;
    }
    if (detail !== null && detail !== c.detail) {
      c.res.write(`event: floor\ndata: ${detail}\n\n`);
      c.detail = detail;
    }
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
      for (const c of this.clients) c.res.write(': ping\n\n');
    }, this.o.heartbeatMs);
  }

  private stopTimers(): void {
    if (this.pending) clearTimeout(this.pending);
    if (this.tick) clearInterval(this.tick);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.pending = this.tick = this.heartbeat = null;
  }
}

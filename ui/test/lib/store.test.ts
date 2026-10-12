import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browserStoreDeps, createClientStore, type ClientState, type EventSourceLike } from '../../lib/store';
import { CHECKOUT, ORDERS, makeFloor, makeScene } from '../helpers/fixtures';

/** An EventSource the test drives: open it, send it events, fail it. */
class FakeStream implements EventSourceLike {
  readyState = 0;
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;
  private listeners = new Map<string, Array<(e: { data: string }) => void>>();
  constructor(readonly url: string) {}
  addEventListener(type: string, fn: (e: { data: string }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close(): void {
    this.readyState = 2;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  send(type: string, data: unknown): void {
    for (const fn of this.listeners.get(type) ?? []) fn({ data: typeof data === 'string' ? data : JSON.stringify(data) });
  }
  /** The browser reconnects by itself (readyState CONNECTING), or gives up (CLOSED, e.g. on a 401). */
  fail(readyState: 0 | 2): void {
    this.readyState = readyState;
    this.onerror?.();
  }
}

function setup(probeStatus: number | Error = 200) {
  const streams: FakeStream[] = [];
  const probe = vi.fn(() => (probeStatus instanceof Error ? Promise.reject(probeStatus) : Promise.resolve(probeStatus)));
  const store = createClientStore({
    openStream: (url) => {
      const s = new FakeStream(url);
      streams.push(s);
      return s;
    },
    probe,
  });
  const states: ClientState[] = [];
  const last = () => streams[streams.length - 1]!;
  return { store, streams, probe, states, last, watch: () => store.subscribe((s) => states.push(s)) };
}

/** Lets the probe's answer arrive, without moving the clock. */
const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('client store', () => {
  it('opens one stream when first subscribed, and goes live when it opens', () => {
    const { store, streams, watch, last } = setup();
    expect(streams).toHaveLength(0);
    expect(store.get()).toEqual({ connection: 'connecting', scene: null, floorKey: null, floor: undefined });
    watch();
    watch();
    expect(streams.map((s) => s.url)).toEqual(['/api/events']);
    last().open();
    expect(store.get().connection).toBe('live');
  });

  it('gives a new subscriber the current state at once, and stops telling one that left', () => {
    const { store, states, last } = setup();
    const stop = store.subscribe((s) => states.push(s));
    expect(states).toHaveLength(1);
    last().open();
    expect(states).toHaveLength(2);
    stop();
    last().send('scene', makeScene());
    expect(states).toHaveLength(2);
  });

  it('keeps the scene the stream sends', () => {
    const { store, watch, last } = setup();
    watch();
    const scene = makeScene();
    last().send('scene', scene);
    expect(store.get()).toMatchObject({ connection: 'live', scene });
  });

  it('ignores events that are not JSON or not this version of the scene', () => {
    const { store, watch, last } = setup();
    watch();
    last().send('scene', '{not json');
    last().send('scene', { ...makeScene(), version: 2 });
    last().send('scene', { version: 1, floors: 'no' });
    last().send('floor', makeFloor(CHECKOUT));
    expect(store.get().scene).toBeNull();
    expect(store.get().floor).toBeUndefined();
  });

  it('opens the stream on the watched floor when watched before anything subscribes', () => {
    const { store, streams, watch } = setup();
    store.watchFloor(ORDERS);
    watch();
    expect(streams.map((s) => s.url)).toEqual(['/api/events?floor=repo%3A%2FUsers%2Fdev%2Fcode%2Forders-api']);
  });

  it('reopens on another floor, which loads until its first floor event', () => {
    const { store, streams, watch, last } = setup();
    watch();
    const first = last();
    first.open();
    store.watchFloor(CHECKOUT);
    expect(first.readyState).toBe(2);
    expect(streams.map((s) => s.url)).toEqual(['/api/events', '/api/events?floor=feature%3Acheckout-v2']);
    expect(store.get()).toMatchObject({ connection: 'live', floorKey: CHECKOUT, floor: undefined });
    last().send('floor', makeFloor(ORDERS));
    expect(store.get().floor).toBeUndefined();
    const floor = makeFloor(CHECKOUT);
    last().send('floor', floor);
    expect(store.get().floor).toEqual(floor);
    last().send('floor', null);
    expect(store.get().floor).toBeNull();
  });

  it('does nothing when the floor does not change, and leaves the floor with null', () => {
    const { store, streams, watch } = setup();
    store.watchFloor(CHECKOUT);
    watch();
    store.watchFloor(CHECKOUT);
    expect(streams).toHaveLength(1);
    store.watchFloor(null);
    expect(streams.map((s) => s.url)).toEqual(['/api/events?floor=feature%3Acheckout-v2', '/api/events']);
    expect(store.get()).toMatchObject({ floorKey: null, floor: undefined });
  });

  it('ignores events from a stream it has closed', () => {
    const { store, streams, watch } = setup();
    watch();
    store.watchFloor(CHECKOUT);
    streams[0]!.send('scene', makeScene());
    streams[0]!.fail(2);
    expect(store.get().scene).toBeNull();
    expect(store.get().connection).toBe('connecting');
  });

  it('shows retrying while the browser reconnects by itself, and live again when it does', () => {
    const { store, probe, streams, watch, last } = setup();
    watch();
    last().open();
    last().fail(0);
    expect(store.get().connection).toBe('retrying');
    expect(probe).not.toHaveBeenCalled();
    last().open();
    expect(store.get().connection).toBe('live');
    expect(streams).toHaveLength(1);
  });

  it('is signed out when the stream closes and the daemon answers 401, and does not retry', async () => {
    const { store, probe, streams, watch, last } = setup(401);
    watch();
    last().fail(2);
    await settle();
    expect(store.get().connection).toBe('signed_out');
    expect(probe).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(streams).toHaveLength(1);
  });

  it('retries 3 seconds after the stream closes for any other reason', async () => {
    const { store, streams, watch, last } = setup(503);
    watch();
    last().fail(2);
    await settle();
    expect(store.get().connection).toBe('retrying');
    vi.advanceTimersByTime(2999);
    expect(streams).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(streams).toHaveLength(2);
    expect(streams[0]!.readyState).toBe(2);
    last().open();
    expect(store.get().connection).toBe('live');
  });

  it('retries when the daemon cannot even be probed', async () => {
    const { store, streams, watch, last } = setup(new TypeError('Failed to fetch'));
    watch();
    last().fail(2);
    await settle();
    expect(store.get().connection).toBe('retrying');
    vi.advanceTimersByTime(3000);
    expect(streams).toHaveLength(2);
  });

  it('stops for good when closed', async () => {
    const { store, states, streams, watch, last } = setup(503);
    watch();
    last().fail(2);
    await settle();
    expect(store.get().connection).toBe('retrying');
    const seen = states.length;
    store.close();
    vi.advanceTimersByTime(10_000);
    expect(streams).toHaveLength(1);
    store.watchFloor(CHECKOUT);
    expect(streams).toHaveLength(1);
    expect(states).toHaveLength(seen);
  });
});

describe('browser wiring', () => {
  it('wraps a real EventSource and probes GET /api/scene with the cookie', async () => {
    class StubSource extends EventTarget {
      static last: StubSource;
      readyState = 0;
      onerror: ((e: Event) => void) | null = null;
      onopen: ((e: Event) => void) | null = null;
      closed = false;
      constructor(readonly url: string) {
        super();
        StubSource.last = this;
      }
      close() {
        this.closed = true;
        this.readyState = 2;
      }
    }
    const fetch = vi.fn(async () => new Response(null, { status: 401 }));
    vi.stubGlobal('EventSource', StubSource);
    vi.stubGlobal('fetch', fetch);
    const deps = browserStoreDeps();
    const stream = deps.openStream('/api/events?floor=x');
    const seen: string[] = [];
    stream.onopen = () => seen.push('open');
    stream.onerror = () => seen.push(`error ${stream.readyState}`);
    stream.addEventListener('scene', (e) => seen.push(`scene ${e.data}`));
    const source = StubSource.last;
    expect(source.url).toBe('/api/events?floor=x');
    source.onopen?.(new Event('open'));
    source.dispatchEvent(new MessageEvent('scene', { data: '{"version":1}' }));
    source.readyState = 2;
    source.onerror?.(new Event('error'));
    stream.close();
    expect(seen).toEqual(['open', 'scene {"version":1}', 'error 2']);
    expect(source.closed).toBe(true);
    expect(await deps.probe()).toBe(401);
    expect(fetch).toHaveBeenCalledWith('/api/scene', { credentials: 'same-origin' });
  });
});

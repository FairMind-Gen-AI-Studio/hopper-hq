import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'svelte';
import App from '../App.svelte';
import { THEME_KEY } from '../lib/theme';
import { toHash, type Route } from '../lib/route';
import { WebGLUnavailableError } from '../renderer/index';
import { CHECKOUT, NOW, ORDERS, makeFloor, makeScene } from './helpers/fixtures';
import { fakeRenderer } from './helpers/fake-renderer';
import { fakeStore, type FakeStore } from './helpers/fake-store';
import { cleanup, click, render, text } from './helpers/render';

function memoryStorage() {
  const data = new Map<string, string>();
  return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) };
}

function go(r: Route): void {
  location.hash = toHash(r);
  window.dispatchEvent(new HashChangeEvent('hashchange'));
  flushSync();
}

function app(store: FakeStore = fakeStore({ scene: makeScene() }), extra: Record<string, unknown> = {}) {
  const storage = memoryStorage();
  const renderer = fakeRenderer();
  const target = render(App, { store, storage, prefersDark: false, renderer: renderer.load, ...extra });
  const crumbs = () => [...target.querySelectorAll('.crumbs > :not(.sep)')].map(text).join(' / ');
  return { target, store, storage, crumbs, renderer };
}

beforeEach(() => {
  location.hash = '';
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  document.documentElement.removeAttribute('data-theme');
});

/** Lets an awaited fake API answer, then updates the DOM. */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  flushSync();
}

describe('App shell', () => {
  it('opens on the building, watching no floor, with the tmux counter of the scene', () => {
    const { target, store, crumbs } = app();
    expect(store.watched).toEqual([null]);
    expect(crumbs()).toBe('Building');
    expect(text(target.querySelector('.tmux .n'))).toBe('◉2');
    expect(text(target.querySelector('.tmux .d'))).toBe('✓2');
    expect(text(target.querySelector('.tmux .visually-hidden'))).toBe('2 need you, 2 done');
  });

  it('opens on the floor in the address, watching it from the start', () => {
    location.hash = toHash({ floor: CHECKOUT, desk: 'oa-c3' });
    const { store, crumbs } = app();
    expect(store.watched).toEqual([CHECKOUT]);
    expect(crumbs()).toBe('Building / 4 · checkout-v2 / orders-api-c3');
  });

  it('follows the address: breadcrumbs, the watched floor, and the way back up', () => {
    const { target, store, crumbs } = app();
    go({ floor: CHECKOUT, desk: null });
    expect(crumbs()).toBe('Building / 4 · checkout-v2');
    expect(store.watched).toEqual([null, CHECKOUT]);
    go({ floor: CHECKOUT, desk: 'sw-b2' });
    expect(crumbs()).toBe('Building / 4 · checkout-v2 / storefront-web-b2');
    expect(target.querySelector('.crumbs [aria-current="page"]')?.textContent).toBe('storefront-web-b2');
    click([...target.querySelectorAll('.crumbs button')].find((b) => b.textContent === '4 · checkout-v2'));
    expect(location.hash).toBe(toHash({ floor: CHECKOUT, desk: null }));
    expect(crumbs()).toBe('Building / 4 · checkout-v2');
    click([...target.querySelectorAll('.crumbs button')].find((b) => b.textContent === 'Building'));
    expect(location.hash).toBe('#/');
    expect(crumbs()).toBe('Building');
    expect(store.watched).toEqual([null, CHECKOUT, null]);
  });

  it('goes up one level with Esc: desk, floor, building', () => {
    const { crumbs } = app();
    go({ floor: CHECKOUT, desk: 'oa-c3' });
    const esc = () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      flushSync();
    };
    esc();
    expect(crumbs()).toBe('Building / 4 · checkout-v2');
    esc();
    expect(crumbs()).toBe('Building');
    esc();
    expect(crumbs()).toBe('Building');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', metaKey: true }));
    expect(location.hash).toBe('#/');
  });

  it('names a floor and a desk it cannot find plainly', () => {
    location.hash = toHash({ floor: 'feature:gone', desk: 'nobody' });
    const { crumbs } = app();
    expect(crumbs()).toBe('Building / Floor / Desk');
  });

  it('tells a signed-out browser how to sign in again, and a cut-off one that it retries', () => {
    const store = fakeStore({ connection: 'signed_out' });
    const { target } = app(store);
    const notice = target.querySelector('[role="alert"]');
    expect(text(notice)).toBe('You are signed out. Run scranton-hq ui in a terminal: it opens a new sign-in link.');
    expect(notice?.querySelector('code')?.textContent).toBe('scranton-hq ui');
    store.set({ connection: 'retrying' });
    flushSync();
    expect(target.querySelector('[role="alert"]')).toBeNull();
    expect(text(target.querySelector('.notice'))).toMatch(/^Lost contact with the daemon\. Retrying…/);
    store.set({ connection: 'connecting' });
    flushSync();
    expect(text(target.querySelector('.notice'))).toBe('Connecting to the daemon…');
    store.set({ connection: 'live', scene: makeScene() });
    flushSync();
    expect(target.querySelector('.notice')).toBeNull();
  });

  it('cycles the theme system, day, night, and remembers the choice', () => {
    const { target, storage } = app(undefined, { prefersDark: true });
    const button = target.querySelector<HTMLButtonElement>('button.theme')!;
    const root = document.documentElement;
    expect(text(button)).toBe('Theme: System (night)');
    expect(root.hasAttribute('data-theme')).toBe(false);
    click(button);
    expect(text(button)).toBe('Theme: Day');
    expect(root.getAttribute('data-theme')).toBe('light');
    expect(storage.data.get(THEME_KEY)).toBe('day');
    click(button);
    expect(root.getAttribute('data-theme')).toBe('dark');
    expect(button.getAttribute('aria-label')).toBe('Theme: Night. Switch to System.');
    click(button);
    expect(root.hasAttribute('data-theme')).toBe(false);
    expect(storage.data.has(THEME_KEY)).toBe(false);
  });

  it('starts from the remembered theme', () => {
    const storage = memoryStorage();
    storage.setItem(THEME_KEY, 'night');
    render(App, { store: fakeStore(), storage, prefersDark: false });
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('shows a hostile name as text', () => {
    const scene = makeScene();
    scene.floors[0]!.name = '<img src=x onerror=alert(1)>';
    location.hash = toHash({ floor: CHECKOUT, desk: null });
    const { target, crumbs } = app(fakeStore({ scene }));
    expect(crumbs()).toBe('Building / 4 · <img src=x onerror=alert(1)>');
    expect(target.querySelector('img')).toBeNull();
  });

  it('closes the live store when the page goes away', () => {
    const { store } = app();
    cleanup();
    expect(store.closed).toBe(true);
  });

  it('lets go of its stream when the page is hidden, and starts afresh when it comes back from the cache', () => {
    const { store } = app();
    const reload = vi.spyOn(location, 'reload').mockImplementation(() => {});
    // happy-dom's PageTransitionEvent is a plain Event: give it `persisted` by hand.
    const page = (type: string, persisted: boolean) => Object.defineProperty(new Event(type), 'persisted', { value: persisted });
    window.dispatchEvent(page('pagehide', true));
    expect(store.closed).toBe(true);
    window.dispatchEvent(page('pageshow', false));
    expect(reload).not.toHaveBeenCalled();
    window.dispatchEvent(page('pageshow', true));
    expect(reload).toHaveBeenCalledTimes(1);
    reload.mockRestore();
  });

  it('opens the desk of an attention chip', () => {
    const { target, store, crumbs } = app();
    click([...target.querySelectorAll('.attention button.open')].find((b) => b.querySelector('.who')?.textContent === 'orders-api-g7'));
    expect(location.hash).toBe(toHash({ floor: ORDERS, desk: 'oa-g7' }));
    expect(crumbs()).toBe('Building / 2 · orders-api / orders-api-g7');
    expect(store.watched).toEqual([null, ORDERS]);
  });

  it('switches tmux from Go, and says what happened', async () => {
    const focusSession = vi.fn(async () => ({ ok: true as const, pane: '%7', simulated: true }));
    const { target } = app(undefined, { api: { focusSession, markSeen: vi.fn() } });
    click(target.querySelector('.attention button.go'));
    await settle();
    expect(focusSession).toHaveBeenCalledWith('oa-c3');
    expect(text(target.querySelector('.toast span'))).toBe('Demo: would switch tmux to %7');
  });

  it('shows why tmux could not switch', async () => {
    const focusSession = vi.fn(async () => ({ ok: false as const, status: 409, error: 'No tmux client is attached' }));
    const { target } = app(undefined, { api: { focusSession, markSeen: vi.fn() } });
    click(target.querySelector('.attention button.go'));
    await settle();
    const toast = target.querySelector('.toast')!;
    expect(text(toast.querySelector('span'))).toBe('No tmux client is attached');
    expect(toast.classList.contains('error')).toBe(true);
  });

  it('keeps the waiting times ticking', () => {
    vi.useFakeTimers();
    let clock = NOW;
    const { target } = app(undefined, { now: () => clock });
    const time = () => text(target.querySelector('.attention .time'));
    expect(time()).toBe('12m');
    clock += 60_000;
    vi.advanceTimersByTime(1000);
    flushSync();
    expect(time()).toBe('13m');
  });

  it('shows no attention bar before the first scene', () => {
    const { target } = app(fakeStore({ connection: 'connecting' }));
    expect(target.querySelector('.attention')).toBeNull();
  });

  it('goes inside a floor, or straight to a desk, from the façade', () => {
    const { target, crumbs } = app();
    const floor = (n: number) => target.querySelectorAll('.stage g.floor')[n]!;
    expect(text(target.querySelector('.stage .hint'))).toBe('Click a floor to go inside, or a window to open its desk.');
    floor(3).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    flushSync();
    expect(crumbs()).toBe('Building / 4 · checkout-v2');
    expect(target.querySelector('.stage svg.facade')).toBeNull();
    expect(target.querySelector('.stage .floor-stage canvas')).not.toBeNull();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    flushSync();
    expect(target.querySelector('.stage .floor-stage')).toBeNull();
    target.querySelector('.stage polygon[data-desk="oa-g7"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    flushSync();
    expect(location.hash).toBe(toHash({ floor: ORDERS, desk: 'oa-g7' }));
  });

  it('redraws the façade as the scene changes, down to an empty building', () => {
    const store = fakeStore({ scene: makeScene() });
    const { target } = app(store);
    const scene = makeScene();
    scene.floors = scene.floors.slice(0, 2);
    store.set({ scene });
    flushSync();
    expect(target.querySelectorAll('.stage g.floor')).toHaveLength(2);
    store.set({ scene: { ...scene, floors: [] } });
    flushSync();
    expect(target.querySelectorAll('.stage g.floor')).toHaveLength(0);
    expect(target.querySelector('.stage svg')).not.toBeNull();
    expect(text(target.querySelector('.stage .hint'))).toBe('No sessions yet.');
  });

  it('shows the panel of the level: directory, floor, desk', () => {
    const { target, crumbs } = app();
    const panel = () => target.querySelector('aside.panel')!;
    expect(text(panel().querySelector('.p-title'))).toBe('The building');
    click(panel().querySelectorAll('.dir-btn')[0]);
    expect(crumbs()).toBe('Building / 4 · checkout-v2');
    expect(text(panel().querySelector('.p-title'))).toBe('checkout-v2');
    click([...panel().querySelectorAll('.row-btn')].find((b) => text(b.querySelector('.r-name')) === 'storefront-web-b2'));
    expect(location.hash).toBe(toHash({ floor: CHECKOUT, desk: 'sw-b2' }));
    expect(text(panel().querySelector('h2'))).toBe('storefront-web-b2');
    click(panel().querySelector('.back'));
    expect(crumbs()).toBe('Building / 4 · checkout-v2');
  });

  it('marks a done session as seen, and says so', async () => {
    const markSeen = vi.fn(async () => true);
    location.hash = toHash({ floor: CHECKOUT, desk: 'sw-b2' });
    const { target } = app(undefined, { api: { focusSession: vi.fn(), markSeen } });
    click([...target.querySelectorAll('aside .actions button')].find((b) => text(b) === 'Mark as seen'));
    await settle();
    expect(markSeen).toHaveBeenCalledWith('sw-b2');
    expect(text(target.querySelector('.toast span'))).toBe('Marked as seen.');
  });

  it('says when marking as seen did not take', async () => {
    const markSeen = vi.fn(async () => false);
    location.hash = toHash({ floor: CHECKOUT, desk: 'sw-b2' });
    const { target } = app(undefined, { api: { focusSession: vi.fn(), markSeen } });
    click([...target.querySelectorAll('aside .actions button')].find((b) => text(b) === 'Mark as seen'));
    await settle();
    expect(target.querySelector('.toast')!.classList.contains('error')).toBe(true);
    expect(text(target.querySelector('.toast span'))).toBe('It is no longer waiting for review.');
  });

  it('switches tmux from the desk panel', async () => {
    const focusSession = vi.fn(async () => ({ ok: true as const, pane: '%4', simulated: false }));
    location.hash = toHash({ floor: CHECKOUT, desk: 'sw-a1' });
    const { target } = app(undefined, { api: { focusSession, markSeen: vi.fn() } });
    click(target.querySelector('aside .actions button.primary'));
    await settle();
    expect(focusSession).toHaveBeenCalledWith('sw-a1');
    expect(text(target.querySelector('.toast span'))).toBe('Switched tmux to %4');
  });

  it('keeps the floor open when the desk in the address has left it', () => {
    location.hash = toHash({ floor: CHECKOUT, desk: 'left-already' });
    const { target } = app();
    expect(text(target.querySelector('aside .p-title'))).toBe('checkout-v2');
    expect(text(target.querySelector('aside .gone'))).toBe('That session has left this floor.');
  });

  it('says when the floor in the address is gone, and goes back to the building', () => {
    location.hash = toHash({ floor: 'feature:gone', desk: null });
    const { target, crumbs } = app();
    expect(text(target.querySelector('aside .p-text'))).toBe('This floor is empty now: its sessions have ended or moved to another floor.');
    expect(text(target.querySelector('.stage .hint'))).toBe('This floor is empty now.');
    expect(target.querySelector('.stage .floor-stage')).toBeNull();
    click(target.querySelector('aside .back'));
    expect(crumbs()).toBe('Building');
  });
});

describe('App floor in 3D', () => {
  it('draws the open floor and passes it every update, without moving the selection', async () => {
    location.hash = toHash({ floor: CHECKOUT, desk: null });
    const { store, renderer } = app();
    await settle();
    expect(renderer.views).toHaveLength(1);
    const view = renderer.views[0]!;
    expect(view.calls).toEqual([`floor ${CHECKOUT} 4`, 'select - pan']);
    const floor = makeFloor(CHECKOUT)!;
    floor.islands = floor.islands.slice(1);
    store.set({ floor });
    flushSync();
    expect(view.calls).toEqual([`floor ${CHECKOUT} 4`, 'select - pan', `floor ${CHECKOUT} 3`]);
  });

  it('pans to the desk the address or the panel picks, and routes a click on a desk without moving the camera', async () => {
    location.hash = toHash({ floor: CHECKOUT, desk: null });
    const { target, renderer, crumbs } = app();
    await settle();
    const view = renderer.views[0]!;
    const selects = () => view.calls.filter((c) => c.startsWith('select'));
    go({ floor: CHECKOUT, desk: 'sw-b2' });
    expect(selects()).toEqual(['select - pan', 'select sw-b2 pan']);
    view.emit('select', 'oa-c3');
    flushSync();
    expect(location.hash).toBe(toHash({ floor: CHECKOUT, desk: 'oa-c3' }));
    expect(crumbs()).toBe('Building / 4 · checkout-v2 / orders-api-c3');
    expect(text(target.querySelector('aside h2'))).toBe('orders-api-c3');
    view.emit('select', null);
    flushSync();
    expect(location.hash).toBe(toHash({ floor: CHECKOUT, desk: null }));
    click([...target.querySelectorAll('aside .row-btn')].find((b) => text(b.querySelector('.r-name')) === 'storefront-web-a1'));
    expect(selects()).toEqual(['select - pan', 'select sw-b2 pan', 'select oa-c3', 'select -', 'select sw-a1 pan']);
    expect(renderer.views).toHaveLength(1);
  });

  it('switches tmux to a desk activated in 3D', async () => {
    const focusSession = vi.fn(async () => ({ ok: true as const, pane: '%4', simulated: true }));
    location.hash = toHash({ floor: CHECKOUT, desk: null });
    const { target, renderer } = app(undefined, { api: { focusSession, markSeen: vi.fn() } });
    await settle();
    renderer.views[0]!.emit('activate', 'sw-a1');
    await settle();
    expect(focusSession).toHaveBeenCalledWith('sw-a1');
    expect(text(target.querySelector('.toast span'))).toBe('Demo: would switch tmux to %4');
  });

  it('repaints the floor in the theme the page has just switched to', async () => {
    location.hash = toHash({ floor: CHECKOUT, desk: null });
    const { target, renderer } = app();
    await settle();
    const view = renderer.views[0]!;
    const themes = () => view.calls.filter((c) => c.startsWith('theme'));
    const button = target.querySelector<HTMLButtonElement>('button.theme')!;
    click(button); // system (day here) -> day: the colours stay
    expect(themes()).toEqual([]);
    click(button); // -> night
    expect(themes()).toEqual(['theme dark']);
    click(button); // -> system, day here
    expect(themes()).toEqual(['theme dark', 'theme system']);
  });

  it('opens a fresh view on each floor, and frees it on the way out', async () => {
    location.hash = toHash({ floor: CHECKOUT, desk: null });
    const { target, renderer } = app();
    await settle();
    const first = renderer.views[0]!;
    click([...target.querySelectorAll('.attention button.open')].find((b) => b.querySelector('.who')?.textContent === 'orders-api-g7'));
    await settle();
    expect(first.calls.at(-1)).toBe('dispose');
    expect(renderer.views).toHaveLength(2);
    const second = renderer.views[1]!;
    expect(second.host.canvas).not.toBe(first.host.canvas);
    expect(second.calls).toEqual([`floor ${ORDERS} 5`, 'select oa-g7 pan']);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    flushSync();
    expect(second.calls.at(-1)).toBe('dispose');
    expect(target.querySelector('.stage svg.facade')).not.toBeNull();
  });

  it('keeps the floor reachable from the panel when the browser has no WebGL', async () => {
    location.hash = toHash({ floor: CHECKOUT, desk: null });
    const { target } = app(undefined, { renderer: fakeRenderer({ fail: new WebGLUnavailableError() }).load });
    await settle();
    expect(text(target.querySelector('.stage .no-webgl'))).toBe('This browser cannot draw the floor in 3D. Its desks are listed in the panel.');
    click([...target.querySelectorAll('aside .row-btn')].find((b) => text(b.querySelector('.r-name')) === 'orders-api-c3'));
    expect(location.hash).toBe(toHash({ floor: CHECKOUT, desk: 'oa-c3' }));
  });
});

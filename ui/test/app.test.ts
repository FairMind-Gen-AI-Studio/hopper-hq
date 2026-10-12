import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'svelte';
import App from '../App.svelte';
import { THEME_KEY } from '../lib/theme';
import { toHash, type Route } from '../lib/route';
import { CHECKOUT, NOW, ORDERS, makeScene } from './helpers/fixtures';
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
  const target = render(App, { store, storage, prefersDark: false, ...extra });
  const crumbs = () => [...target.querySelectorAll('.crumbs > :not(.sep)')].map(text).join(' / ');
  return { target, store, storage, crumbs };
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
});

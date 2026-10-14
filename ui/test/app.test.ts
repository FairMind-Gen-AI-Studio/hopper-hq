import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'svelte';
import App from '../App.svelte';
import type { FocusResult } from '../lib/api';
import { occupantsOf } from '../lib/occupants';
import { THEME_KEY } from '../lib/theme';
import { toHash } from '../lib/route';
import { WebGLUnavailableError } from '../renderer/index';
import { CHECKOUT, NOW, ORDERS, makeFloor, makeScene } from './helpers/fixtures';
import { fakeRenderer } from './helpers/fake-renderer';
import { fakeStore, type FakeStore } from './helpers/fake-store';
import { DONE_RUN, RUN, checkoutWithRoom } from './helpers/rooms';
import { cleanup, click, render, text } from './helpers/render';

function memoryStorage() {
  const data = new Map<string, string>();
  return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) };
}

function go(r: Parameters<typeof toHash>[0]): void {
  location.hash = toHash(r);
  window.dispatchEvent(new HashChangeEvent('hashchange'));
  flushSync();
}

/** A store whose checkout floor has the payments desk's run in a room; `change` alters each floor it gives. */
function roomStore(change: (floor: NonNullable<ReturnType<typeof makeFloor>>) => void = () => {}): FakeStore {
  return fakeStore({ scene: makeScene() }, (key) => {
    const floor = key === CHECKOUT ? checkoutWithRoom() : makeFloor(key);
    if (floor) change(floor);
    return floor;
  });
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

  it('counts one session that needs you in the singular', () => {
    const scene = makeScene();
    scene.attention.needsYou = scene.attention.needsYou.slice(0, 1);
    const { target } = app(fakeStore({ scene }));
    expect(text(target.querySelector('.tmux .visually-hidden'))).toBe('1 needs you, 2 done');
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
    expect(text(notice)).toBe('You are signed out. Run hopper-hq ui in a terminal: it opens a new sign-in link.');
    expect(notice?.querySelector('code')?.textContent).toBe('hopper-hq ui');
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

  it('asks for a reload once the daemon speaks another version of the building', () => {
    const store = fakeStore({ connection: 'outdated', scene: makeScene() });
    const { target } = app(store);
    expect(text(target.querySelector('[role="alert"]'))).toBe('The building was updated. Reload the page to see it.');
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

  it('offers a reload when it cannot draw what the daemon sent, and keeps its toasts', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const reload = vi.spyOn(location, 'reload').mockImplementation(() => {});
    try {
      const store = fakeStore({ scene: makeScene() });
      const { target } = app(store);
      const scene = makeScene();
      // Two entries for one session: Svelte cannot key the list by session.
      scene.attention.done.push(scene.attention.done[0]!);
      store.set({ scene });
      flushSync();
      const alert = target.querySelector('[role="alert"]');
      expect(text(alert)).toBe('The page could not show what the daemon sent. Reload');
      expect(target.querySelector('.topbar, .attention, main')).toBeNull();
      expect(target.querySelector('.toasts')).not.toBeNull();
      expect(errors).toHaveBeenCalled();
      click(alert?.querySelector('button'));
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      reload.mockRestore();
      errors.mockRestore();
    }
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
    expect(markSeen).toHaveBeenCalledWith('sw-b2', undefined, expect.any(Function));
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

  it('says how to sign in again when Go or Mark as seen finds the browser signed out', async () => {
    const focusSession = vi.fn(async () => ({ ok: false as const, status: 401, error: 'Signed out: run hopper-hq ui again' }));
    const markSeen = vi.fn(async (_id: string, _fetch?: unknown, signedOut?: () => void) => {
      signedOut?.();
      return false;
    });
    location.hash = toHash({ floor: CHECKOUT, desk: 'sw-b2' });
    const { target } = app(undefined, { api: { focusSession, markSeen } });
    click(target.querySelector('aside .actions button.primary'));
    await settle();
    click([...target.querySelectorAll('aside .actions button')].find((b) => text(b) === 'Mark as seen'));
    await settle();
    const toasts = [...target.querySelectorAll('.toast')];
    expect(toasts.map((t) => text(t.querySelector('span')))).toEqual(['Signed out: run hopper-hq ui again', 'Signed out: run hopper-hq ui again']);
    expect(toasts.every((t) => t.classList.contains('error'))).toBe(true);
  });

  it('sends one Go and one Mark as seen per session while the first is still out', async () => {
    const answers: Array<() => void> = [];
    const focusSession = vi.fn((_id: string) => new Promise<FocusResult>((r) => answers.push(() => r({ ok: true, pane: '%5', simulated: true }))));
    const markSeen = vi.fn((_id: string) => new Promise<boolean>((r) => answers.push(() => r(true))));
    location.hash = toHash({ floor: CHECKOUT, desk: 'sw-b2' });
    const { target } = app(undefined, { api: { focusSession, markSeen } });
    const go = target.querySelector('aside .actions button.primary');
    const seen = [...target.querySelectorAll('aside .actions button')].find((b) => text(b) === 'Mark as seen');
    for (const button of [go, go, seen, seen, target.querySelector('.attention button.go')]) click(button);
    expect(focusSession.mock.calls.map(([id]) => id)).toEqual(['sw-b2', 'oa-c3']);
    expect(markSeen).toHaveBeenCalledTimes(1);
    for (const answer of answers.splice(0)) answer();
    await settle();
    click(go);
    click(seen);
    expect(focusSession).toHaveBeenCalledTimes(3);
    expect(markSeen).toHaveBeenCalledTimes(2);
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

  it('opens a run from the desk panel of its host', () => {
    location.hash = toHash({ floor: CHECKOUT, desk: 'ps-d4' });
    const { target } = app(roomStore());
    click([...target.querySelectorAll('aside section button')].find((b) => text(b) === 'checkout-verify'));
    expect(location.hash).toBe(toHash({ floor: CHECKOUT, run: RUN }));
  });

  it('opens a run in its own panel, names it in the breadcrumbs, and goes back to its floor with Esc', async () => {
    location.hash = toHash({ floor: CHECKOUT, desk: null });
    const { target, crumbs } = app(roomStore());
    go({ floor: CHECKOUT, run: RUN });
    expect(crumbs()).toBe('Building / 4 · checkout-v2 / checkout-verify');
    expect(text(target.querySelector('aside h2'))).toBe('checkout-verify');
    expect(text(target.querySelector('aside .pill'))).toBe('Running');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    flushSync();
    expect(location.hash).toBe(toHash({ floor: CHECKOUT, desk: null }));
    expect(crumbs()).toBe('Building / 4 · checkout-v2');
    click(target.querySelector('aside section.meetings .row-btn'));
    // The row it clicked has gone: focus goes to the run's heading.
    await settle();
    expect(document.activeElement).toBe(target.querySelector('aside h2'));
    expect(text(document.activeElement)).toBe('checkout-verify');
    click(target.querySelector('aside dd button.host'));
    expect(location.hash).toBe(toHash({ floor: CHECKOUT, desk: 'ps-d4' }));
    expect(crumbs()).toBe('Building / 4 · checkout-v2 / payments-svc-d4');
  });

  it('names a finished run from its host desk, and a run it cannot find plainly', () => {
    location.hash = toHash({ floor: CHECKOUT, run: DONE_RUN });
    const { target, crumbs } = app(roomStore());
    expect(crumbs()).toBe('Building / 4 · checkout-v2 / nightly-smoke');
    expect(text(target.querySelector('aside .p-note'))).toBe('This run has finished, and its room has closed.');
    go({ floor: CHECKOUT, run: 'wf_gone' });
    expect(crumbs()).toBe('Building / 4 · checkout-v2 / wf_gone');
    expect(text(target.querySelector('aside .p-text'))).toBe('This run is no longer on this floor.');
    go({ floor: 'feature:gone', run: 'wf_gone' });
    expect(crumbs()).toBe('Building / Floor / Run');
  });

  it("switches tmux to a run's host from the run panel, once while the first request is out", async () => {
    const answers: Array<() => void> = [];
    const focusSession = vi.fn((_id: string) => new Promise<FocusResult>((r) => answers.push(() => r({ ok: true, pane: '%9', simulated: true }))));
    location.hash = toHash({ floor: CHECKOUT, run: RUN });
    const { target } = app(roomStore(), { api: { focusSession, markSeen: vi.fn() } });
    const go = target.querySelector('aside .actions button.primary');
    expect(text(go)).toBe('Go to pane %9');
    click(go);
    click(go);
    expect(focusSession.mock.calls).toEqual([['ps-d4']]);
    for (const answer of answers.splice(0)) answer();
    await settle();
    expect(text(target.querySelector('.toast span'))).toBe('Demo: would switch tmux to %9');
  });

  it('names a desk from the attention bar and shows its floor loading, until the floor arrives', () => {
    location.hash = toHash({ floor: ORDERS, desk: 'oa-g7' });
    const store = fakeStore({ scene: makeScene() }, () => undefined);
    const { target, crumbs } = app(store);
    expect(crumbs()).toBe('Building / 2 · orders-api / orders-api-g7');
    expect(text(target.querySelector('aside .p-title'))).toBe('orders-api');
    expect(text(target.querySelector('aside .p-note'))).toBe('Loading the floor…');
    expect(target.querySelector('.stage .floor-stage')).toBeNull();
    store.set({ floor: makeFloor(ORDERS) });
    flushSync();
    expect(text(target.querySelector('aside h2'))).toBe('orders-api-g7');
    expect(target.querySelector('.stage .floor-stage')).not.toBeNull();
  });

  it('keeps the floor open when the desk in the address has left it', () => {
    location.hash = toHash({ floor: CHECKOUT, desk: 'left-already' });
    const { target } = app();
    expect(text(target.querySelector('aside .p-title'))).toBe('checkout-v2');
    expect(text(target.querySelector('aside .gone'))).toBe('That session has left this floor.');
  });

  it('opens the panel of a session that waits for a desk, from the address and from the floor panel', () => {
    const store = roomStore((floor) => {
      const sw = occupantsOf(floor).find((o) => o.sessionId === 'sw-b2');
      if (sw) floor.unseated.push({ ...sw, sessionId: 'sw-w9', name: 'storefront-web-w9', at: { kind: 'gone' } });
    });
    location.hash = toHash({ floor: CHECKOUT, desk: 'sw-w9' });
    const { target, crumbs } = app(store);
    expect([text(target.querySelector('aside h2')), crumbs()]).toEqual(['storefront-web-w9', 'Building / 4 · checkout-v2 / storefront-web-w9']);
    click(target.querySelector('aside .back'));
    const row = [...target.querySelectorAll('aside .row-btn')].find((b) => text(b.querySelector('.r-name')) === 'storefront-web-w9')!;
    expect(text(row.querySelector('.r-state'))).toBe('Done, to review · no desk');
    click(row);
    expect(location.hash).toBe(toHash({ floor: CHECKOUT, desk: 'sw-w9' }));
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

describe('App focus', () => {
  const active = () => document.activeElement;
  const heading = (target: HTMLElement) => target.querySelector('aside h2');

  /** Focuses a button, clicks it, and waits for the move. */
  async function press(el: Element | null | undefined): Promise<void> {
    (el as HTMLElement).focus();
    click(el);
    await settle();
  }

  it('moves focus to the new panel heading on every move, so that it never falls to the page', async () => {
    const { target } = app();
    expect(active()).toBe(document.body);
    await press(target.querySelector('.dir-btn'));
    expect(active()).toBe(heading(target));
    expect(text(active())).toBe('checkout-v2');
    expect(active()?.getAttribute('tabindex')).toBe('-1');
    await press([...target.querySelectorAll('aside .row-btn')].find((b) => text(b.querySelector('.r-name')) === 'storefront-web-b2'));
    expect(text(active())).toBe('storefront-web-b2');
    expect(active()?.getAttribute('tabindex')).toBe('-1');
    await press(target.querySelector('aside .back'));
    expect(text(active())).toBe('checkout-v2');
    await press([...target.querySelectorAll('.crumbs button')].find((b) => text(b) === 'Building'));
    expect(text(active())).toBe('The building');
    expect(active()?.getAttribute('tabindex')).toBe('-1');
  });

  it('moves focus the same way on Esc and on Back or Forward', async () => {
    location.hash = toHash({ floor: CHECKOUT, desk: 'sw-b2' });
    const { target } = app();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await settle();
    expect(active()).toBe(heading(target));
    expect(text(active())).toBe('checkout-v2');
    go({ floor: ORDERS, desk: 'oa-g7' });
    await settle();
    expect(text(active())).toBe('orders-api-g7');
  });

  it('leaves focus in the 3D floor when a desk is picked there', async () => {
    location.hash = toHash({ floor: CHECKOUT, desk: null });
    const { renderer } = app();
    await settle();
    const view = renderer.views[0]!;
    view.host.canvas.tabIndex = 0;
    view.host.canvas.focus();
    view.emit('select', { kind: 'desk', id: 'oa-c3' });
    await settle();
    expect(location.hash).toBe(toHash({ floor: CHECKOUT, desk: 'oa-c3' }));
    expect(active()).toBe(view.host.canvas);
  });

  it('keeps focus on Go when the room of the run in the panel closes', () => {
    location.hash = toHash({ floor: CHECKOUT, run: RUN });
    const { target, store } = app(roomStore());
    const go = target.querySelector<HTMLElement>('aside .actions button.primary')!;
    go.focus();
    const floor = checkoutWithRoom();
    floor.rooms = [];
    const host = occupantsOf(floor).find((d) => d.sessionId === 'ps-d4')!;
    host.runs[0] = { ...host.runs[0]!, status: 'completed', endedAt: NOW };
    store.set({ floor });
    flushSync();
    expect(text(target.querySelector('aside .p-note'))).toBe('This run has finished, and its room has closed.');
    expect(active()).toBe(go);
  });

  it('keeps focus in the page when a live update takes the focused button away', () => {
    location.hash = toHash({ floor: CHECKOUT, desk: 'sw-b2' });
    const { target, store } = app();
    ([...target.querySelectorAll('aside .actions button')].find((b) => text(b) === 'Mark as seen') as HTMLElement).focus();
    const floor = makeFloor(CHECKOUT)!;
    occupantsOf(floor).find((d) => d.sessionId === 'sw-b2')!.state = 'idle';
    store.set({ floor });
    flushSync();
    expect(active()).toBe(heading(target));
    expect(text(active())).toBe('storefront-web-b2');
  });

  it('moves focus to the chip now in the place of an answered one, else to the panel heading', () => {
    const { target, store } = app();
    const who = () => text(active()?.querySelector('.who'));
    target.querySelector<HTMLElement>('.attention .needs button.open')!.focus();
    expect(who()).toBe('orders-api-c3');
    const scene = makeScene();
    scene.attention.needsYou = scene.attention.needsYou.slice(1);
    store.set({ scene });
    flushSync();
    expect(who()).toBe('orders-api-g7');
    store.set({ scene: { ...scene, attention: { ...scene.attention, needsYou: [] } } });
    flushSync();
    expect(active()).toBe(heading(target));
    expect(text(active())).toBe('The building');
  });

  it('never takes focus from an element still in the page, nor from the page itself', async () => {
    const { target, store } = app();
    const floor = target.querySelector<SVGGElement>('.stage g.floor')!;
    floor.focus();
    store.set({ scene: makeScene() });
    flushSync();
    expect(active()).toBe(floor);
    floor.blur();
    store.set({ scene: makeScene() });
    flushSync();
    expect(active()).toBe(document.body);
    // An element the user left for the page stays left when a later update takes it away.
    const open = target.querySelector<HTMLElement>('.attention .needs button.open')!;
    open.focus();
    open.blur();
    await Promise.resolve();
    const scene = makeScene();
    scene.attention.needsYou = scene.attention.needsYou.slice(1);
    store.set({ scene });
    flushSync();
    expect(open.isConnected).toBe(false);
    expect(active()).toBe(document.body);
  });

  it('keeps the focused chip to recover when the browser window loses focus and the element stays the active one', async () => {
    const { target, store } = app();
    const who = () => text(active()?.querySelector('.who'));
    const open = target.querySelector<HTMLElement>('.attention .needs button.open')!;
    open.focus();
    // A window switch blurs the element and fires focusout, but it stays the document's active element.
    open.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
    await Promise.resolve();
    expect(active()).toBe(open);
    const scene = makeScene();
    scene.attention.needsYou = scene.attention.needsYou.slice(1);
    store.set({ scene });
    flushSync();
    expect(open.isConnected).toBe(false);
    expect(active()).not.toBe(document.body);
    expect(who()).toBe('orders-api-g7');
  });

  it('keeps the focused chip to recover when its removal fires the focusout that Chrome fires for it', async () => {
    const { target, store } = app();
    const open = target.querySelector<HTMLElement>('.attention .needs button.open')!;
    open.focus();
    const next = target.querySelectorAll<HTMLElement>('.attention .needs li.chip button.open')[1]!;
    // The chip is taken away while it has focus; focus falls to the page and the focusout comes with the removal.
    open.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
    open.remove();
    expect(active()).toBe(document.body);
    await Promise.resolve();
    // The element is gone, so it is not the user leaving it for the page: the next update still recovers it.
    store.set({ scene: makeScene() });
    flushSync();
    expect(active()).toBe(next);
  });

  it('does not pull focus back to a chip the user left for the page', async () => {
    const { target, store } = app();
    const chip = target.querySelector<HTMLElement>('.attention .needs button.open')!;
    chip.focus();
    chip.blur();
    await Promise.resolve();
    expect(active()).toBe(document.body);
    const scene = makeScene();
    scene.attention.needsYou = scene.attention.needsYou.slice(1);
    store.set({ scene });
    flushSync();
    expect(chip.isConnected).toBe(false);
    expect(active()).toBe(document.body);
  });
});

describe('App floor in 3D', () => {
  it('draws the open floor and passes it every update, without moving the selection', async () => {
    location.hash = toHash({ floor: CHECKOUT, desk: null });
    const { store, renderer } = app();
    await settle();
    expect(renderer.views).toHaveLength(1);
    const view = renderer.views[0]!;
    expect(view.calls).toEqual([`floor ${CHECKOUT} 4 snap`, 'select - pan']);
    const floor = makeFloor(CHECKOUT)!;
    floor.pods = floor.pods.slice(1);
    store.set({ floor });
    flushSync();
    expect(view.calls).toEqual([`floor ${CHECKOUT} 4 snap`, 'select - pan', `floor ${CHECKOUT} 3`]);
  });

  it('gives the view the first floor of each stream as first sight, and the floors after it to walk to', async () => {
    location.hash = toHash({ floor: CHECKOUT, desk: null });
    const { store, renderer } = app();
    await settle();
    const view = renderer.views[0]!;
    const floors = () => view.calls.filter((c) => c.startsWith('floor'));
    const fewer = () => {
      const floor = makeFloor(CHECKOUT)!;
      floor.pods = floor.pods.slice(1);
      return floor;
    };
    store.set({ floor: fewer() });
    flushSync();
    // A new stream opens: its epoch comes first, and changes nothing on its own; then its floor, which is first sight.
    store.set({ epoch: 1 });
    flushSync();
    expect(floors()).toEqual([`floor ${CHECKOUT} 4 snap`, `floor ${CHECKOUT} 3`]);
    store.set({ floor: makeFloor(CHECKOUT)! });
    flushSync();
    store.set({ floor: fewer() });
    flushSync();
    expect(floors()).toEqual([`floor ${CHECKOUT} 4 snap`, `floor ${CHECKOUT} 3`, `floor ${CHECKOUT} 4 snap`, `floor ${CHECKOUT} 3`]);
  });

  it('pans to the desk the address or the panel picks, and routes a click on a desk without moving the camera', async () => {
    location.hash = toHash({ floor: CHECKOUT, desk: null });
    const { target, renderer, crumbs } = app();
    await settle();
    const view = renderer.views[0]!;
    const selects = () => view.calls.filter((c) => c.startsWith('select'));
    go({ floor: CHECKOUT, desk: 'sw-b2' });
    expect(selects()).toEqual(['select - pan', 'select desk sw-b2 pan']);
    view.emit('select', { kind: 'desk', id: 'oa-c3' });
    flushSync();
    expect(location.hash).toBe(toHash({ floor: CHECKOUT, desk: 'oa-c3' }));
    expect(crumbs()).toBe('Building / 4 · checkout-v2 / orders-api-c3');
    expect(text(target.querySelector('aside h2'))).toBe('orders-api-c3');
    view.emit('select', null);
    flushSync();
    expect(location.hash).toBe(toHash({ floor: CHECKOUT, desk: null }));
    click([...target.querySelectorAll('aside .row-btn')].find((b) => text(b.querySelector('.r-name')) === 'storefront-web-a1'));
    expect(selects()).toEqual(['select - pan', 'select desk sw-b2 pan', 'select desk oa-c3', 'select -', 'select desk sw-a1 pan']);
    expect(renderer.views).toHaveLength(1);
  });

  it('routes a room picked in 3D to its run, goes to its host when it is activated, and pans to a room the panel picks', async () => {
    const focusSession = vi.fn(async () => ({ ok: true as const, pane: '%9', simulated: true }));
    location.hash = toHash({ floor: CHECKOUT, desk: 'sw-b2' });
    const { target, renderer, crumbs } = app(roomStore(), { api: { focusSession, markSeen: vi.fn() } });
    await settle();
    const view = renderer.views[0]!;
    const selects = () => view.calls.filter((c) => c.startsWith('select'));
    view.host.canvas.tabIndex = 0;
    view.host.canvas.focus();
    view.emit('select', { kind: 'room', id: RUN });
    await settle();
    expect(location.hash).toBe(toHash({ floor: CHECKOUT, run: RUN }));
    expect(crumbs()).toBe('Building / 4 · checkout-v2 / checkout-verify');
    expect(document.activeElement).toBe(view.host.canvas);
    view.emit('activate', { kind: 'room', id: RUN });
    await settle();
    expect(focusSession).toHaveBeenCalledWith('ps-d4');
    expect(text(target.querySelector('.toast span'))).toBe('Demo: would switch tmux to %9');
    go({ floor: CHECKOUT, desk: null });
    click(target.querySelector('aside section.meetings .row-btn'));
    expect(selects()).toEqual(['select desk sw-b2 pan', `select room ${RUN}`, 'select - pan', `select room ${RUN} pan`]);
  });

  it('switches tmux to a desk activated in 3D', async () => {
    const focusSession = vi.fn(async () => ({ ok: true as const, pane: '%4', simulated: true }));
    location.hash = toHash({ floor: CHECKOUT, desk: null });
    const { target, renderer } = app(undefined, { api: { focusSession, markSeen: vi.fn() } });
    await settle();
    renderer.views[0]!.emit('activate', { kind: 'desk', id: 'sw-a1' });
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
    expect(second.calls).toEqual([`floor ${ORDERS} 5 snap`, 'select desk oa-g7 pan']);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    flushSync();
    expect(second.calls.at(-1)).toBe('dispose');
    expect(target.querySelector('.stage svg.facade')).not.toBeNull();
  });

  it('offers a reload when the 3D view cannot load, and keeps the floor reachable from the panel', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      location.hash = toHash({ floor: CHECKOUT, desk: null });
      const { target } = app(undefined, { renderer: () => Promise.reject(new TypeError('Failed to fetch dynamically imported module')) });
      await settle();
      expect(text(target.querySelector('.stage .load-failed p'))).toBe('The 3D view could not load; the daemon may have been updated. Reload the page.');
      expect(target.querySelector('.stage .no-webgl')).toBeNull();
      click([...target.querySelectorAll('aside .row-btn')].find((b) => text(b.querySelector('.r-name')) === 'orders-api-c3'));
      expect(location.hash).toBe(toHash({ floor: CHECKOUT, desk: 'oa-c3' }));
    } finally {
      logged.mockRestore();
    }
  });

  it('opens a run from the meeting rooms of the floor panel, the way around a floor without WebGL', async () => {
    location.hash = toHash({ floor: CHECKOUT, desk: null });
    const store = fakeStore({ scene: makeScene() }, (key) => (key === CHECKOUT ? checkoutWithRoom() : makeFloor(key)));
    const { target } = app(store, { renderer: fakeRenderer({ fail: new WebGLUnavailableError() }).load });
    await settle();
    click(target.querySelector('aside section.meetings .row-btn'));
    expect(location.hash).toBe(toHash({ floor: CHECKOUT, run: RUN }));
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

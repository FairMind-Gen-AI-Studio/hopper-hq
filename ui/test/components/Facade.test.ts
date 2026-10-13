import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'svelte';
import Facade from '../../components/Facade.svelte';
import { CHECKOUT, DOCS, ORDERS, makeScene } from '../helpers/fixtures';
import { cleanup, render, text } from '../helpers/render';

afterEach(cleanup);

function facade(floors = makeScene().floors, selected: string | null = null) {
  const onFloor = vi.fn();
  const onDesk = vi.fn();
  const target = render(Facade, { floors, selected, onFloor, onDesk });
  const floor = (n: number) => target.querySelectorAll('g.floor')[n]!;
  return { target, onFloor, onDesk, floor };
}

describe('Facade', () => {
  it('draws one floor button per floor, bottom-up, each named for a screen reader', () => {
    const { target } = facade();
    expect([...target.querySelectorAll('g.floor')].map((g) => g.getAttribute('aria-label'))).toEqual([
      'Floor 1, docs-refresh: 2 sessions, shutters down',
      'Floor 2, orders-api: 5 sessions, 1 needs you, 1 done',
      'Floor 3, search-ranking: 2 sessions, 1 no signal',
      'Floor 4, checkout-v2: 4 sessions, 1 needs you, 1 done, 1 in a meeting',
    ]);
    for (const g of target.querySelectorAll('g.floor')) {
      expect(g.getAttribute('role')).toBe('button');
      expect(g.getAttribute('tabindex')).toBe('0');
    }
  });

  it('colours each window by the state at its desk, leaves a free desk\'s window dark, and lowers the shutters on a dormant floor', () => {
    const { target, floor } = facade();
    const win = (id: string) => target.querySelector(`polygon[data-desk="${id}"]`)!;
    expect(target.querySelectorAll('polygon[data-desk]')).toHaveLength(13);
    // 16 desks on the checkout floor, 8 on each other floor; 13 sessions sit at them.
    const free = [...target.querySelectorAll('polygon.st-free')];
    expect(free).toHaveLength(16 + 3 * 8 - 13);
    expect(free.every((w) => !w.hasAttribute('data-desk') && !w.classList.contains('lit') && w.querySelector('title') === null)).toBe(true);
    expect(win('oa-c3').getAttribute('class')).toMatch(/\bst-needs_you\b/);
    expect(win('oa-c3').classList.contains('lit')).toBe(true);
    expect(win('ss-e5').classList.contains('st-no_signal')).toBe(true);
    expect(win('oa-j0').classList.contains('st-idle')).toBe(true);
    expect(win('oa-j0').classList.contains('lit')).toBe(false);
    expect(text(win('oa-c3').querySelector('title'))).toBe('Needs you');
    expect(floor(0).classList.contains('shut')).toBe(true);
    expect(floor(0).querySelectorAll('line.slat')).toHaveLength(48);
    expect(floor(1).classList.contains('shut')).toBe(false);
  });

  it('labels each floor with its number, name and counts', () => {
    const { floor } = facade();
    const top = floor(3);
    expect(text(top.querySelector('.t-num'))).toBe('4');
    expect(text(top.querySelector('.t-name'))).toBe('checkout-v2');
    const tone = (t: Element) => [...t.classList].find((c) => c.startsWith('c-')) ?? '';
    expect([...top.querySelectorAll('.t-meta tspan')].map((t) => `${tone(t)}|${t.textContent}`)).toEqual([
      '|3 repos · 4 sessions',
      'c-needs|● 1 needs you',
      'c-done|● 1 done',
      'c-meeting|● 1 in a meeting',
    ]);
  });

  it('never draws the building below 80% of its size, where its text gets too small to read: the stage scrolls instead', () => {
    const many = makeScene().floors.map((f) => ({ ...f, windows: Array.from({ length: 40 }, (_, i) => ({ sessionId: `${f.key}-${i}`, state: 'working' as const })) }));
    for (const floors of [makeScene().floors, many]) {
      const { target } = facade(floors);
      const svg = target.querySelector<SVGSVGElement>('svg.facade')!;
      const [, , width, height] = svg.getAttribute('viewBox')!.split(' ').map(Number);
      expect(svg.style.minWidth).toBe(`${Math.round(width! * 0.8)}px`);
      expect(svg.style.minHeight).toBe(`${Math.round(height! * 0.8)}px`);
      cleanup();
    }
  });

  it('ends a long floor name with an ellipsis, and shows it whole on hover', () => {
    const floors = makeScene().floors;
    floors[0]!.name = 'jira-1234-add-idempotency-keys-to-orders';
    const { floor } = facade(floors);
    expect(text(floor(3).querySelector('.t-name'))).toBe('jira-1234-add-idempotency-k…');
    expect(floor(3).querySelector(':scope > title')?.textContent).toBe('jira-1234-add-idempotency-keys-to-orders');
    expect(floor(3).getAttribute('aria-label')).toMatch(/^Floor 4, jira-1234-add-idempotency-keys-to-orders: /);
    expect(text(floor(2).querySelector('.t-name'))).toBe('search-ranking');
    expect(floor(2).querySelector(':scope > title')?.textContent).toBe('search-ranking');
  });

  it('goes inside a floor on click, Enter or Space, and to a desk from its window', () => {
    const { target, floor, onFloor, onDesk } = facade();
    floor(1).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    flushSync();
    expect(onFloor).toHaveBeenLastCalledWith(ORDERS);
    floor(3).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(onFloor).toHaveBeenLastCalledWith(CHECKOUT);
    floor(0).dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    expect(onFloor).toHaveBeenLastCalledWith(DOCS);
    floor(0).dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    expect(onFloor).toHaveBeenCalledTimes(3);
    target.querySelector('polygon[data-desk="sw-b2"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onDesk).toHaveBeenCalledWith(CHECKOUT, 'sw-b2');
    expect(onFloor).toHaveBeenCalledTimes(3);
  });

  it('outlines the open floor', () => {
    const { floor } = facade(undefined, CHECKOUT);
    expect(floor(3).classList.contains('selected')).toBe(true);
    expect(floor(1).classList.contains('selected')).toBe(false);
  });

  it('shows a hostile floor name as text', () => {
    const floors = makeScene().floors;
    floors[0]!.name = '<img src=x onerror=alert(1)>';
    const { target, floor } = facade(floors);
    expect(text(floor(3).querySelector('.t-name'))).toBe('<img src=x onerror=alert(1)>');
    expect(target.querySelector('img')).toBeNull();
  });
});

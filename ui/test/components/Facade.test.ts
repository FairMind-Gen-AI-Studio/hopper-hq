import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'svelte';
import type { ActiveLine } from '../../../src/scene/types';
import Facade from '../../components/Facade.svelte';
import source from '../../components/Facade.svelte?raw';
import { CHECKOUT, DOCS, ORDERS, makeScene } from '../helpers/fixtures';
import { cleanup, render, text } from '../helpers/render';

afterEach(cleanup);

function facade(floors = makeScene().floors, selected: string | null = null, activeLines: ActiveLine[] = []) {
  const onFloor = vi.fn();
  const onDesk = vi.fn();
  const target = render(Facade, { floors, activeLines, selected, onFloor, onDesk });
  const floor = (n: number) => target.querySelectorAll('g.floor')[n]!;
  return { target, onFloor, onDesk, floor };
}

describe('Facade', () => {
  it('draws one floor button per floor, bottom-up, each named for a screen reader', () => {
    const { target } = facade();
    expect([...target.querySelectorAll('g.floor')].map((g) => g.getAttribute('aria-label'))).toEqual([
      'Floor 1, docs-refresh (docs-site, storefront-web): 2 sessions, shutters down',
      'Floor 2, orders-api: 5 sessions, 1 needs you, 1 done',
      'Floor 3, search-ranking (search-svc, storefront-web): 2 sessions, 1 no signal',
      'Floor 4, checkout-v2 (orders-api, payments-svc, storefront-web): 4 sessions, 1 needs you, 1 done, 1 in a meeting',
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
    expect(floor(0).querySelectorAll('line.slat')).toHaveLength(24);
    expect(floor(1).classList.contains('shut')).toBe(false);
  });

  it("frames a free desk's window, and draws nothing past a floor's plan but its wall", () => {
    const { floor } = facade();
    // The orders floor has 8 desks on a building 16 windows wide: 8 windows and its side strip, no more.
    expect(floor(1).querySelectorAll('polygon.sfill')).toHaveLength(8 + 1);
    expect(floor(1).querySelectorAll('polygon.st-empty')).toHaveLength(1);
    expect(floor(1).querySelectorAll('polygon.st-free')).toHaveLength(3);
    const free = source.slice(source.indexOf('\n  .sfill.st-free {'), source.indexOf('}', source.indexOf('\n  .sfill.st-free {')));
    expect(free).toMatch(/stroke: var\(--win-frame\);/);
  });

  it('labels each floor with its number, name and counts', () => {
    const { floor } = facade();
    const top = floor(3);
    expect(text(top.querySelector('.t-num'))).toBe('4');
    expect(text(top.querySelector('.t-name'))).toBe('checkout-v2');
    const tone = (t: Element) => [...t.classList].find((c) => c.startsWith('c-')) ?? '';
    expect([...top.querySelectorAll('.t-meta tspan')].map((t) => `${tone(t)}|${t.textContent}`)).toEqual([
      '|orders-api, payments-svc +1 · 4 sessions',
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
    expect(floor(3).getAttribute('aria-label')).toMatch(/^Floor 4, jira-1234-add-idempotency-keys-to-orders \(.*\): /);
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

  it('lights one antenna stub per active line, dark where no server is active, and never lights the mast without a Fairmind line', () => {
    const activeLines: ActiveLine[] = [
      { slot: 2, fairmind: false, count: 1, server: 'Notion', family: null, tool: 'call', caller: 'api-a' },
      { slot: 5, fairmind: false, count: 1, server: 'Wordpress', family: null, tool: 'call', caller: 'api-a' },
    ];
    const { target } = facade(undefined, null, activeLines);
    const lit = [...target.querySelectorAll('.stub.lit')].map((s) => s.getAttribute('class'));
    expect(lit).toHaveLength(2);
    expect(lit.every((c) => /\bstub-(2|5)\b/.test(c!))).toBe(true);
    expect(target.querySelectorAll('.stub')).toHaveLength(8);
    expect(target.querySelector('.mast')!.classList.contains('lit')).toBe(false);
  });

  it('lights the mast Fairmind teal when a Fairmind line is active, and shows a +N badge only on the busiest line past one', () => {
    const activeLines: ActiveLine[] = [
      { slot: 1, fairmind: false, count: 3, server: 'Slack', family: null, tool: 'call', caller: 'api-a' },
      { slot: 4, fairmind: true, count: 1, server: 'fairmind', family: 'Studio', tool: 'call', caller: 'api-a' },
    ];
    const { target } = facade(undefined, null, activeLines);
    expect(target.querySelector('.mast')!.classList.contains('lit')).toBe(true);
    expect(text(target.querySelector('.stub-badge'))).toBe('+3');
    expect(target.querySelectorAll('.stub-badge')).toHaveLength(1);
  });

  it("never lights a Fairmind line's own hashed stub — the mast is its only sign, not a generic coloured antenna too", () => {
    const activeLines: ActiveLine[] = [{ slot: 4, fairmind: true, count: 1, server: 'fairmind', family: 'Brain', tool: 'call', caller: 'api-a' }];
    const { target } = facade(undefined, null, activeLines);
    expect(target.querySelectorAll('.stub.lit')).toHaveLength(0);
    expect(target.querySelectorAll('.sign')).toHaveLength(0);
    expect(target.querySelector('.mast')!.classList.contains('lit')).toBe(true);
  });

  it('traces a known-server glyph on a lit stub for one of the eight named servers, colour- and case-insensitively', () => {
    const activeLines: ActiveLine[] = [{ slot: 3, fairmind: false, count: 1, server: 'GoogleSheets', family: null, tool: 'call', caller: 'api-a' }];
    const { target } = facade(undefined, null, activeLines);
    const sign = target.querySelector('.sign-3')!;
    expect(sign.querySelector('.sign-glyph')).not.toBeNull();
    expect(sign.querySelector('.sign-letter')).toBeNull();
  });

  it("falls back to the line colour and the server's first letter past the eight known glyphs", () => {
    const activeLines: ActiveLine[] = [{ slot: 6, fairmind: false, count: 1, server: 'Wordpress', family: null, tool: 'call', caller: 'api-a' }];
    const { target } = facade(undefined, null, activeLines);
    const sign = target.querySelector('.sign-6')!;
    expect(sign.querySelector('.sign-glyph')).toBeNull();
    expect(text(sign.querySelector('.sign-letter'))).toBe('W');
  });


  it('keeps every stub dark and the mast unlit while no server is active', () => {
    const { target } = facade();
    expect(target.querySelectorAll('.stub.lit')).toHaveLength(0);
    expect(target.querySelector('.mast')!.classList.contains('lit')).toBe(false);
    expect(target.querySelectorAll('.stub-badge')).toHaveLength(0);
  });

  describe('the mast sign (hq-mcp-switchboard proposal.md §5 Phase 3; ActiveLine.family, SCENE_VERSION 9)', () => {
    it('draws no mast sign while no Fairmind line is active', () => {
      const { target } = facade();
      expect(target.querySelectorAll('.mast-sign')).toHaveLength(0);
    });

    for (const [family, letter] of [['Studio', 'S'], ['General', 'G'], ['Brain', 'B'], ['Insights', 'I'], ['Code', 'C']] as const) {
      it(`signs the mast '${letter}' for a Fairmind line of the ${family} family`, () => {
        const activeLines: ActiveLine[] = [{ slot: 4, fairmind: true, count: 1, server: 'fairmind', family, tool: 'call', caller: 'api-a' }];
        const { target } = facade(undefined, null, activeLines);
        expect(target.querySelectorAll('.mast-sign')).toHaveLength(1);
        expect(text(target.querySelector('.mast-sign-letter'))).toBe(letter);
      });
    }

    it("signs the mast 'FM' — the house's own default — for a Fairmind line with no family", () => {
      const activeLines: ActiveLine[] = [{ slot: 4, fairmind: true, count: 1, server: 'fairmind', family: null, tool: 'call', caller: 'api-a' }];
      const { target } = facade(undefined, null, activeLines);
      expect(text(target.querySelector('.mast-sign-letter'))).toBe('FM');
    });

    it('draws the sign big enough to read at the building\'s default view, and gives it a soft halo in both fixed brand colours (round-2 enlargement)', () => {
      const activeLines: ActiveLine[] = [{ slot: 4, fairmind: true, count: 1, server: 'fairmind', family: 'Brain', tool: 'call', caller: 'api-a' }];
      const { target } = facade(undefined, null, activeLines);
      // r=9/font-size 10px (round 1) read as a speck next to a floor's own r=11 label circle; both grew past it.
      expect(Number(target.querySelector('.mast-sign-bg')!.getAttribute('r'))).toBeGreaterThan(11);
      const letterSize = source.slice(source.indexOf('\n  .mast-sign-letter {'), source.indexOf('}', source.indexOf('\n  .mast-sign-letter {')));
      expect(letterSize).toMatch(/font-size: 1[2-9]px;/);
      // The halo: a static filter (no keyframe/transition), so it needs no ?motion=off gate of its own — it never
      // moves — and it is never re-declared in the dark theme's own block, so it glows the same by day and by
      // night, the same "fixed, outside the theme" discipline --fairmind-teal/--fairmind-gold already keep.
      const mastSign = source.slice(source.indexOf('\n  .mast-sign {'), source.indexOf('}', source.indexOf('\n  .mast-sign {')));
      expect(mastSign).toMatch(/filter: drop-shadow\([^)]*var\(--fairmind-gold\)\) drop-shadow\([^)]*var\(--fairmind-teal\)\);/);
    });
  });

  describe('making the antennas self-explanatory (hq-mcp-switchboard Phase 4 — user feedback 2026-10-19, "ora sono antenne ma non si capisce a cosa servono")', () => {
    const line = (extra: Partial<ActiveLine> = {}): ActiveLine => ({
      slot: 2,
      fairmind: false,
      count: 1,
      server: 'Notion',
      family: null,
      tool: 'search',
      caller: 'api-feat4',
      ...extra,
    });

    it("always mounts the rooftop's own name plaque, faint while idle and brought up once any line is live (requirement 2)", () => {
      const { target } = facade();
      const plaque = target.querySelector('.plaque')!;
      expect(plaque.classList.contains('plaque-active')).toBe(false);
      expect(text(target.querySelector('.plaque-title'))).toBe('MCP');
      expect(text(target.querySelector('.plaque-sub'))).toBe('Switchboard');
      expect(target.querySelector('.plaque-post')).not.toBeNull();

      const { target: lit } = facade(undefined, null, [line()]);
      expect(lit.querySelector('.plaque')!.classList.contains('plaque-active')).toBe(true);
    });

    it('labels a lit stub with a readable tag: the server name, or the brand (with its family) for the Fairmind line, plus a count past one (requirement 1)', () => {
      const { target } = facade(undefined, null, [line({ slot: 3, server: 'Slack', count: 4 })]);
      expect(text(target.querySelector('.tag-name'))).toBe('Slack ×4');
      expect(target.querySelector('.tag-leader')).not.toBeNull();

      const { target: fm } = facade(undefined, null, [{ slot: 0, fairmind: true, count: 1, server: 'fairmind', family: 'Brain', tool: 'Brain_record_decision', caller: 'address-desk' }]);
      expect(text(fm.querySelector('.tag-name'))).toBe('FairMind · Brain');
    });

    it("renders the tag with the server's own friendly name, not its raw canonical token (\"friendly server names\" follow-up)", () => {
      const { target } = facade(undefined, null, [line({ slot: 3, server: 'Google_Calendar' })]);
      expect(text(target.querySelector('.tag-name'))).toBe('Google Calendar');
    });

    it('shows at most TAG_MAX tags and collapses the rest into one "+k" summary, never silently dropping a line', () => {
      const lines: ActiveLine[] = Array.from({ length: 8 }, (_, slot) => line({ slot, server: `Server${slot}`, count: slot + 1 }));
      const { target } = facade(undefined, null, lines);
      expect(target.querySelectorAll('.tag-name').length).toBeLessThanOrEqual(4);
      expect(text(target.querySelector('.tag-overflow'))).toMatch(/^\+\d+ more$/);
    });

    it('wraps every lit antenna (stub or mast) in a keyboard-focusable target naming server, tool and caller — never an input — in its aria-label (requirement 3)', () => {
      const { target } = facade(undefined, null, [line({ slot: 5, server: 'ClickUp', tool: 'get_task', caller: 'ps-d4', count: 2 })]);
      const antenna = [...target.querySelectorAll('.antenna')].find((g) => !g.classList.contains('antenna-mast'))!;
      expect(antenna.getAttribute('tabindex')).toBe('0');
      expect(antenna.getAttribute('aria-label')).toBe('ClickUp · get_task · called by ps-d4 · +1 more call');
      expect(text(antenna.querySelector('.call-tip'))).toBe('ClickUp · get_task · called by ps-d4 · +1 more call');
    });

    it("wraps the mast too, once a Fairmind line is live, naming its own family", () => {
      const { target } = facade(undefined, null, [{ slot: 0, fairmind: true, count: 1, server: 'fairmind', family: 'Studio', tool: 'Studio_get_task', caller: 'address-desk' }]);
      const mast = target.querySelector('.antenna-mast')!;
      expect(mast.getAttribute('tabindex')).toBe('0');
      expect(mast.getAttribute('aria-label')).toBe('FairMind · Studio · Studio_get_task · called by address-desk');
    });

    it('draws no antenna wrapper, tag or tooltip while no line is live', () => {
      const { target } = facade();
      expect(target.querySelectorAll('.antenna')).toHaveLength(0);
      expect(target.querySelectorAll('.tag-name')).toHaveLength(0);
      expect(target.querySelectorAll('.call-tip')).toHaveLength(0);
    });

    it('reveals the tooltip on hover or keyboard focus alone, never by default (keyboard accessibility)', () => {
      const block = source.slice(source.indexOf('\n  .call-tip {'), source.indexOf('}', source.indexOf('\n  .call-tip {')));
      expect(block).toMatch(/opacity:\s*0;/);
      const reveal = source.slice(source.indexOf('.antenna:hover .call-tip'), source.indexOf('{', source.indexOf('.antenna:hover .call-tip')));
      expect(reveal).toContain('.antenna:hover .call-tip');
      expect(reveal).toContain('.antenna:focus-visible .call-tip');
    });
  });
});

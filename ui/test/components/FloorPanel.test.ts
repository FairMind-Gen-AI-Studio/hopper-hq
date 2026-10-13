import { afterEach, describe, expect, it, vi } from 'vitest';
import FloorPanel from '../../components/FloorPanel.svelte';
import source from '../../components/FloorPanel.svelte?raw';
import type { FloorDetail } from '../../../src/scene/types';
import { CHECKOUT, DOCS, NOW, ORDERS, makeFloor, makeScene } from '../helpers/fixtures';
import { cleanup, click, render, text } from '../helpers/render';
import { RUN, checkoutWithRoom } from '../helpers/rooms';

afterEach(cleanup);

const summaryOf = (key: string) => makeScene().floors.find((f) => f.key === key);

function panel(key: string, floor: FloorDetail | null | undefined = makeFloor(key), selected: string | null = null, now = NOW) {
  const onDesk = vi.fn();
  const onBack = vi.fn();
  const onRun = vi.fn();
  const target = render(FloorPanel, { summary: summaryOf(key), floor, selected, now, onDesk, onBack, onRun });
  const islands = () => [...target.querySelectorAll('section.island')];
  /** The meeting rooms' rows: name, counts and phase. */
  const rooms = () =>
    [...target.querySelectorAll('section.meetings .row-btn')].map((r) => `${text(r.querySelector('.r-name'))} | ${text(r.querySelector('.r-state'))} | ${text(r.querySelector('.r-task'))}`);
  return { target, onDesk, onBack, onRun, islands, rooms };
}

const MIN = 60_000;

describe('FloorPanel', () => {
  it('heads the panel with the floor number, kind and size', () => {
    const feature = panel(CHECKOUT).target;
    expect(text(feature.querySelector('.eyebrow'))).toBe('Floor 4 · Feature');
    expect(text(feature.querySelector('.p-title'))).toBe('checkout-v2');
    expect(text(feature.querySelector('.p-sub'))).toBe('3 repos on this feature · 4 sessions');
    cleanup();
    const department = panel(ORDERS).target;
    expect(text(department.querySelector('.eyebrow'))).toBe('Floor 2 · Department');
    expect(text(department.querySelector('.p-sub'))).toBe('Sessions with no feature branch · 5 sessions');
  });

  it('gives each island its placard: repo colour, repo, branch, worktree and path', () => {
    const { islands } = panel(CHECKOUT);
    const floor = makeFloor(CHECKOUT)!;
    expect(islands().map((s) => text(s.querySelector('.island-head')))).toEqual([
      'orders-api feat/checkout-v2 · worktree',
      'payments-svc feat/checkout-v2',
      'storefront-web feat/checkout-v2',
    ]);
    expect(islands().map((s) => text(s.querySelector('.path')))).toEqual(floor.islands.map((i) => i.path));
    expect(islands()[0]!.querySelector('.swatch')!.classList.contains(`repo-${floor.islands[0]!.color}`)).toBe(true);
  });

  it('lists each desk with its state and task, and opens it on click', () => {
    const { islands, onDesk } = panel(CHECKOUT);
    const rows = islands()[2]!.querySelectorAll('.row-btn');
    expect([...rows].map((r) => `${text(r.querySelector('.r-name'))} | ${text(r.querySelector('.r-state'))} | ${text(r.querySelector('.r-task'))}`)).toEqual([
      'storefront-web-a1 | Working | Build the address step of the new checkout',
      'storefront-web-b2 | Done, to review | Rewrite checkout copy and empty states',
    ]);
    expect(rows[1]!.classList.contains('sw-done')).toBe(true);
    click(rows[1]);
    expect(onDesk).toHaveBeenCalledWith('sw-b2');
  });

  it('marks no row for a desk the route points at on this floor: that desk has a panel of its own', () => {
    const { target } = panel(CHECKOUT, makeFloor(CHECKOUT), 'ps-d4');
    expect(target.querySelector('[aria-current], .sel')).toBeNull();
    expect(target.querySelector('.gone')).toBeNull();
  });

  it('says when the desk the route points at has left the floor', () => {
    const { target } = panel(CHECKOUT, makeFloor(CHECKOUT), 'gone-1');
    expect(text(target.querySelector('.gone'))).toBe('That session has left this floor.');
  });

  it('names a task-less desk plainly, and a floor with its shutters down', () => {
    const floor = makeFloor(DOCS)!;
    floor.islands[0]!.desks[0]!.title = null;
    const { target } = panel(DOCS, floor);
    expect(text(target.querySelector('.r-task'))).toBe('No task yet');
    expect(text(target.querySelector('.p-text'))).toBe('Shutters down: everyone on this floor has been idle for days.');
  });

  it('shows the floor loading, from its summary', () => {
    const target = render(FloorPanel, { summary: summaryOf(CHECKOUT), floor: undefined, selected: null, now: NOW, onDesk: vi.fn(), onBack: vi.fn(), onRun: vi.fn() });
    expect(text(target.querySelector('.p-title'))).toBe('checkout-v2');
    expect(text(target.querySelector('.p-sub'))).toBe('3 repos on this feature · 4 sessions');
    expect(text(target.querySelector('.p-note'))).toBe('Loading the floor…');
    expect(target.querySelectorAll('section.island')).toHaveLength(0);
  });

  it('says when the floor is gone, and offers the way back', () => {
    const onBack = vi.fn();
    const target = render(FloorPanel, { summary: undefined, floor: null, selected: null, now: NOW, onDesk: vi.fn(), onBack, onRun: vi.fn() });
    expect(text(target.querySelector('.p-title'))).toBe('Not in the building');
    expect(text(target.querySelector('.p-text'))).toBe('This floor is empty now: its sessions have ended or moved to another floor.');
    click(target.querySelector('.back'));
    expect(onBack).toHaveBeenCalled();
  });

  it('shows hostile names, branches and paths as text', () => {
    const floor = makeFloor(CHECKOUT)!;
    floor.islands[0]!.branch = '<script>alert(1)</script>';
    floor.islands[0]!.path = '<img src=x onerror=alert(1)>';
    floor.islands[0]!.desks[0]!.name = '<b>bold</b>';
    const { target, islands } = panel(CHECKOUT, floor);
    expect(text(islands()[0]!.querySelector('.br'))).toBe('<script>alert(1)</script> · worktree');
    expect(text(islands()[0]!.querySelector('.path'))).toBe('<img src=x onerror=alert(1)>');
    expect(text(islands()[0]!.querySelector('.r-name'))).toBe('<b>bold</b>');
    expect(target.querySelector('img, script, b')).toBeNull();
  });

  it('gives each desk row the line of where it stands, with its age, and says when a prompt came after it', () => {
    const floor = makeFloor(CHECKOUT)!;
    const [a1, b2] = floor.islands[2]!.desks;
    a1!.summary = { text: 'Builds the address step while two helpers check the form', at: NOW - 3 * MIN, stale: true };
    b2!.summary = { text: 'Copy is rewritten and ready for review', at: NOW - 2 * MIN, stale: false };
    const { islands } = panel(CHECKOUT, floor);
    const lines = [...islands()[2]!.querySelectorAll('.row-btn')].map((r) => r.querySelector('.r-sum'));
    expect(lines.map((l) => text(l))).toEqual([
      'Builds the address step while two helpers check the form · 3m ago (older than the last prompt)',
      'Copy is rewritten and ready for review · 2m ago',
    ]);
    expect(lines.map((l) => l!.classList.contains('stale'))).toEqual([true, false]);
    expect(islands()[0]!.querySelector('.r-sum')).toBeNull();
  });

  it("lists the floor's meeting rooms after its islands, and opens one", () => {
    const { target, rooms, onRun } = panel(CHECKOUT, checkoutWithRoom());
    const section = target.querySelector('section.meetings')!;
    expect(text(section.querySelector('h3'))).toBe('Meeting rooms');
    expect([...target.querySelectorAll('section')].at(-1)).toBe(section);
    expect(rooms()).toEqual(['checkout-verify | 2 running · 1 done | Phase: Build']);
    click(section.querySelector('.row-btn'));
    expect(onRun).toHaveBeenCalledWith(RUN);
    cleanup();
    expect(panel(CHECKOUT).target.querySelector('section.meetings')).toBeNull();
  });

  it('breaks a long name anywhere rather than widen the panel: happy-dom lays nothing out, so the rule says it', () => {
    expect(source).toMatch(/\n  \.r-name \{[^}]*overflow-wrap: anywhere;/);
  });

  it('names a room without a name or a phase plainly, keeps two hosts of one run apart, and counts the runs without a room', () => {
    const floor = checkoutWithRoom();
    const room = floor.rooms[0]!;
    floor.rooms.push({ ...room, hostSessionId: 'sw-a1', name: null, phases: [], counts: { running: 1, finished: 0 } });
    floor.rooms.push({ ...room, runId: 'wf_0000aaaa-002', name: '<b>bold</b>', phases: [{ title: 'Plan', state: 'upcoming' }] });
    floor.roomsMore = 2;
    const { target, rooms } = panel(CHECKOUT, floor);
    expect(rooms()).toEqual(['checkout-verify | 2 running · 1 done | Phase: Build', `${RUN} | 1 running · 0 done | No phase yet`, '<b>bold</b> | 2 running · 1 done | No phase yet']);
    expect(text(target.querySelector('section.meetings .p-note'))).toBe('+2 runs without a room');
    expect(target.querySelector('b')).toBeNull();
    floor.rooms = [];
    floor.roomsMore = 1;
    cleanup();
    expect(text(panel(CHECKOUT, floor).target.querySelector('section.meetings .p-note'))).toBe('+1 run without a room');
  });
});

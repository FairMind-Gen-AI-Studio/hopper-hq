import { afterEach, describe, expect, it, vi } from 'vitest';
import FloorPanel from '../../components/FloorPanel.svelte';
import source from '../../components/FloorPanel.svelte?raw';
import type { FloorDetail, Occupant } from '../../../src/scene/types';
import { occupantsOf } from '../../lib/occupants';
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
  const groups = () => [...target.querySelectorAll('section.checkout')];
  /** A group's rows: name, state and task. */
  const rows = (group: Element) =>
    [...group.querySelectorAll('.row-btn')].map((r) => `${text(r.querySelector('.r-name'))} | ${text(r.querySelector('.r-state'))} | ${text(r.querySelector('.r-task'))}`);
  /** The meeting rooms' rows: name, counts and phase. */
  const rooms = () =>
    [...target.querySelectorAll('section.meetings .row-btn')].map((r) => `${text(r.querySelector('.r-name'))} | ${text(r.querySelector('.r-state'))} | ${text(r.querySelector('.r-task'))}`);
  return { target, onDesk, onBack, onRun, groups, rows, rooms };
}

const MIN = 60_000;

/** The session of a floor by id. */
const sessionOf = (floor: FloorDetail, id: string): Occupant => occupantsOf(floor).find((o) => o.sessionId === id)!;

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

  it('gives each checkout its group, ordered by repo, branch and path: repo colour, repo, branch, worktree and path', () => {
    const { groups } = panel(CHECKOUT);
    const floor = makeFloor(CHECKOUT)!;
    expect(groups().map((s) => text(s.querySelector('.checkout-head')))).toEqual([
      'orders-api feat/checkout-v2 · worktree',
      'payments-svc feat/checkout-v2',
      'storefront-web feat/checkout-v2',
    ]);
    expect(groups().map((s) => text(s.querySelector('.path')))).toEqual(['oa-c3', 'ps-d4', 'sw-a1'].map((id) => sessionOf(floor, id).checkout.path));
    expect(groups()[0]!.querySelector('.swatch')!.classList.contains(`repo-${sessionOf(floor, 'oa-c3').robot!.body}`)).toBe(true);
  });

  it('lists each session with its state and task, and opens it on click', () => {
    const { groups, rows, onDesk } = panel(CHECKOUT);
    expect(rows(groups()[2]!)).toEqual([
      'storefront-web-a1 | Working | Build the address step of the new checkout',
      'storefront-web-b2 | Done, to review | Rewrite checkout copy and empty states',
    ]);
    const buttons = groups()[2]!.querySelectorAll('.row-btn');
    expect(buttons[1]!.classList.contains('sw-done')).toBe(true);
    click(buttons[1]);
    expect(onDesk).toHaveBeenCalledWith('sw-b2');
  });

  it('keeps a checkout that spans two pods in one group, in desk order, and two checkouts that share a pod apart', () => {
    const department = panel(ORDERS);
    expect(department.groups()).toHaveLength(1);
    expect(department.rows(department.groups()[0]!).map((r) => r.split(' | ')[0])).toEqual(['orders-api-g7', 'orders-api-h8', 'orders-api-i9', 'orders-api-j0', 'orders-api-k1']);
    cleanup();
    const floor = makeFloor(CHECKOUT)!;
    // payments-svc-d4 sits in the pod of orders-api-c3.
    floor.pods[0]!.desks[1]!.occupant = floor.pods[1]!.desks[0]!.occupant;
    floor.pods[1]!.desks[0]!.occupant = null;
    const { groups } = panel(CHECKOUT, floor);
    expect(groups().map((g) => text(g.querySelector('.repo')))).toEqual(['orders-api', 'payments-svc', 'storefront-web']);
  });

  it('lists a session waiting for a desk in its checkout\'s group, after those at a desk, and says it has no desk', () => {
    const floor = makeFloor(CHECKOUT)!;
    floor.unseated.push({ ...sessionOf(floor, 'sw-a1'), sessionId: 'sw-w9', name: 'storefront-web-w9', title: 'Wait for a desk', at: { kind: 'gone' } });
    const { target, groups, rows, onDesk } = panel(CHECKOUT, floor, 'sw-w9');
    expect(rows(groups()[2]!)).toEqual([
      'storefront-web-a1 | Working | Build the address step of the new checkout',
      'storefront-web-b2 | Done, to review | Rewrite checkout copy and empty states',
      'storefront-web-w9 | Working · no desk | Wait for a desk',
    ]);
    expect(text(target.querySelector('.p-sub'))).toBe('3 repos on this feature · 5 sessions');
    expect(target.querySelector('.gone')).toBeNull();
    click(groups()[2]!.querySelectorAll('.row-btn')[2]);
    expect(onDesk).toHaveBeenCalledWith('sw-w9');
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
    sessionOf(floor, 'ds-m3').title = null;
    const { target } = panel(DOCS, floor);
    expect(text(target.querySelector('.r-task'))).toBe('No task yet');
    expect(text(target.querySelector('.p-text'))).toBe('Shutters down: everyone on this floor has been idle for days.');
  });

  it('shows the floor loading, from its summary', () => {
    const target = render(FloorPanel, { summary: summaryOf(CHECKOUT), floor: undefined, selected: null, now: NOW, onDesk: vi.fn(), onBack: vi.fn(), onRun: vi.fn() });
    expect(text(target.querySelector('.p-title'))).toBe('checkout-v2');
    expect(text(target.querySelector('.p-sub'))).toBe('3 repos on this feature · 4 sessions');
    expect(text(target.querySelector('.p-note'))).toBe('Loading the floor…');
    expect(target.querySelectorAll('section.checkout')).toHaveLength(0);
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
    const hostile = sessionOf(floor, 'oa-c3');
    hostile.checkout = { ...hostile.checkout, branch: '<script>alert(1)</script>', path: '<img src=x onerror=alert(1)>' };
    hostile.name = '<b>bold</b>';
    const { target, groups } = panel(CHECKOUT, floor);
    expect(text(groups()[0]!.querySelector('.br'))).toBe('<script>alert(1)</script> · worktree');
    expect(text(groups()[0]!.querySelector('.path'))).toBe('<img src=x onerror=alert(1)>');
    expect(text(groups()[0]!.querySelector('.r-name'))).toBe('<b>bold</b>');
    expect(target.querySelector('img, script, b')).toBeNull();
  });

  it('gives each desk row the line of where it stands, with its age, and says when a prompt came after it', () => {
    const floor = makeFloor(CHECKOUT)!;
    sessionOf(floor, 'sw-a1').summary = { text: 'Builds the address step while two helpers check the form', at: NOW - 3 * MIN, stale: true };
    sessionOf(floor, 'sw-b2').summary = { text: 'Copy is rewritten and ready for review', at: NOW - 2 * MIN, stale: false };
    const { groups } = panel(CHECKOUT, floor);
    const lines = [...groups()[2]!.querySelectorAll('.row-btn')].map((r) => r.querySelector('.r-sum'));
    expect(lines.map((l) => text(l))).toEqual([
      'Builds the address step while two helpers check the form · 3m ago (older than the last prompt)',
      'Copy is rewritten and ready for review · 2m ago',
    ]);
    expect(lines.map((l) => l!.classList.contains('stale'))).toEqual([true, false]);
    expect(groups()[0]!.querySelector('.r-sum')).toBeNull();
  });

  it("lists the floor's meeting rooms after its checkouts, and opens one", () => {
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

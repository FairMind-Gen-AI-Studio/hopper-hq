import { afterEach, describe, expect, it, vi } from 'vitest';
import FloorPanel from '../../components/FloorPanel.svelte';
import type { FloorDetail } from '../../../src/scene/types';
import { CHECKOUT, DOCS, ORDERS, makeFloor, makeScene } from '../helpers/fixtures';
import { cleanup, click, render, text } from '../helpers/render';

afterEach(cleanup);

const summaryOf = (key: string) => makeScene().floors.find((f) => f.key === key);

function panel(key: string, floor: FloorDetail | null | undefined = makeFloor(key), selected: string | null = null) {
  const onDesk = vi.fn();
  const onBack = vi.fn();
  const target = render(FloorPanel, { summary: summaryOf(key), floor, selected, onDesk, onBack });
  const islands = () => [...target.querySelectorAll('section.island')];
  return { target, onDesk, onBack, islands };
}

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

  it('marks the desk the route points at', () => {
    const { target } = panel(CHECKOUT, makeFloor(CHECKOUT), 'ps-d4');
    const current = target.querySelector('[aria-current="true"]')!;
    expect(text(current.querySelector('.r-name'))).toBe('payments-svc-d4');
    expect(current.classList.contains('sel')).toBe(true);
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
    const target = render(FloorPanel, { summary: summaryOf(CHECKOUT), floor: undefined, selected: null, onDesk: vi.fn(), onBack: vi.fn() });
    expect(text(target.querySelector('.p-title'))).toBe('checkout-v2');
    expect(text(target.querySelector('.p-sub'))).toBe('3 repos on this feature · 4 sessions');
    expect(text(target.querySelector('.p-note'))).toBe('Loading the floor…');
    expect(target.querySelectorAll('section.island')).toHaveLength(0);
  });

  it('says when the floor is gone, and offers the way back', () => {
    const onBack = vi.fn();
    const target = render(FloorPanel, { summary: undefined, floor: null, selected: null, onDesk: vi.fn(), onBack });
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
});

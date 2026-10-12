import { afterEach, describe, expect, it, vi } from 'vitest';
import BuildingPanel from '../../components/BuildingPanel.svelte';
import { ORDERS, makeScene } from '../helpers/fixtures';
import { cleanup, click, render, text } from '../helpers/render';

afterEach(cleanup);

function panel(floors = makeScene().floors) {
  const onFloor = vi.fn();
  const target = render(BuildingPanel, { floors, onFloor });
  const rows = () => [...target.querySelectorAll('.directory .dir-btn')];
  return { target, onFloor, rows };
}

describe('BuildingPanel', () => {
  it('lists the floors in the order of the scene, top to bottom', () => {
    const { target, rows } = panel();
    expect(text(target.querySelector('.p-sub'))).toBe('4 floors · 13 sessions');
    expect(rows().map((r) => `${text(r.querySelector('.fl-num'))} ${text(r.querySelector('.fl-name'))}`)).toEqual([
      '4 checkout-v2',
      '3 search-ranking',
      '2 orders-api',
      '1 docs-refresh',
    ]);
  });

  it('shows what each floor is, its repos and its counts', () => {
    const { rows } = panel();
    expect(rows().map((r) => text(r.querySelector('.fl-meta')))).toEqual([
      '3 repos · 4 sessions · orders-api, payments-svc, storefront-web',
      '2 repos · 2 sessions · search-svc, storefront-web',
      'Department · 5 sessions',
      '2 repos · 2 sessions · docs-site, storefront-web',
    ]);
    expect(rows().map((r) => text(r.querySelector('.fl-counts')))).toEqual(['◉1 need you ✓1 done', '', '◉1 need you ✓1 done', 'shut']);
  });

  it('goes to a floor', () => {
    const { rows, onFloor } = panel();
    click(rows()[2]);
    expect(onFloor).toHaveBeenCalledWith(ORDERS);
  });

  it('explains every state, needs-you first', () => {
    const { target } = panel();
    const items = [...target.querySelectorAll('.legend li')];
    expect(items.map((li) => text(li.querySelector('.ln')))).toEqual(['Needs you', 'Done, to review', 'Working', 'In a meeting', 'No signal', 'Idle', 'Dormant']);
    expect(items[0]!.classList.contains('sw-needs_you')).toBe(true);
  });

  it('says how sessions move into an empty building', () => {
    const { target } = panel([]);
    expect(text(target.querySelector('.p-sub'))).toBe('0 floors · 0 sessions');
    expect(target.querySelector('.directory')).toBeNull();
    expect(text(target.querySelector('.p-note'))).toMatch(/^No sessions yet\./);
  });

  it('shows a hostile floor name as text', () => {
    const floors = makeScene().floors;
    floors[0]!.name = '<img src=x onerror=alert(1)>';
    const { target, rows } = panel(floors);
    expect(text(rows()[0]!.querySelector('.fl-name'))).toBe('<img src=x onerror=alert(1)>');
    expect(target.querySelector('img')).toBeNull();
  });
});

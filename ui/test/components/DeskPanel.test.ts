import { afterEach, describe, expect, it, vi } from 'vitest';
import DeskPanel from '../../components/DeskPanel.svelte';
import type { Desk, Island } from '../../../src/scene/types';
import { CHECKOUT, NOW, ORDERS, SEARCH, makeFloor } from '../helpers/fixtures';
import { cleanup, click, render, text } from '../helpers/render';

afterEach(cleanup);

function find(key: string, id: string): { desk: Desk; island: Island; floor: NonNullable<ReturnType<typeof makeFloor>> } {
  const floor = makeFloor(key)!;
  for (const island of floor.islands) {
    const desk = island.desks.find((d) => d.sessionId === id);
    if (desk) return { desk, island, floor };
  }
  throw new Error(`no desk ${id}`);
}

function panel(key: string, id: string, now = NOW, change: (d: Desk) => void = () => {}) {
  const { desk, island, floor } = find(key, id);
  change(desk);
  const onBack = vi.fn();
  const onGo = vi.fn();
  const onSeen = vi.fn();
  const target = render(DeskPanel, { desk, island, floor, now, onBack, onGo, onSeen });
  const facts = () => Object.fromEntries([...target.querySelectorAll('dt')].map((dt) => [text(dt), text(dt.nextElementSibling)]));
  const button = (label: string) => [...target.querySelectorAll('.actions button')].find((b) => text(b).startsWith(label)) as HTMLButtonElement | undefined;
  return { target, onBack, onGo, onSeen, facts, button };
}

describe('DeskPanel', () => {
  it('heads the panel with the session, its state, its repo and its pane', () => {
    const { target } = panel(CHECKOUT, 'oa-c3');
    expect(text(target.querySelector('.back'))).toBe('← Floor 4 · checkout-v2');
    expect(text(target.querySelector('.eyebrow'))).toBe('orders-api · tmux pane %7');
    expect(text(target.querySelector('h2'))).toBe('orders-api-c3');
    expect(text(target.querySelector('.pill'))).toBe('Needs you');
    expect(text(target.querySelector('.p-text'))).toBe('Add idempotency keys to POST /orders');
  });

  it('says what it waits for and who raised it', () => {
    expect(panel(CHECKOUT, 'oa-c3').facts()['Waiting for']).toBe('Permission: Bash (rm -rf dist && npm run build)');
    cleanup();
    expect(panel(ORDERS, 'oa-g7').facts()['Waiting for']).toBe('Question: Should the retry queue use Redis or Postgres? · raised by Explore');
  });

  it('says how long a silent command has been running, by the clock', () => {
    expect(panel(SEARCH, 'ss-e5').facts()['Running']).toBe('Bash: npm test for 14m, no new output');
    cleanup();
    expect(panel(SEARCH, 'ss-e5', NOW + 60_000).facts()['Running']).toBe('Bash: npm test for 15m, no new output');
  });

  it('lists the facts: since, last action, subagents, repo, branch, folder and pane', () => {
    const { facts } = panel(CHECKOUT, 'sw-a1');
    expect(facts()).toEqual({
      Since: '40s ago',
      'Last action': 'Edit src/checkout/AddressStep.tsx · 40s ago',
      Subagents: '2 running',
      Repo: 'storefront-web',
      Branch: 'feat/checkout-v2',
      Folder: '/Users/dev/code/storefront-web',
      Pane: '%4',
    });
    cleanup();
    expect(panel(CHECKOUT, 'oa-c3').facts()['Branch']).toBe('feat/checkout-v2 · worktree');
  });

  it('goes to the pane, and marks a done session as seen', () => {
    const { button, onGo, onSeen } = panel(CHECKOUT, 'sw-b2');
    expect(button('Go to pane')!.disabled).toBe(false);
    expect(text(button('Go to pane'))).toBe('Go to pane %5');
    click(button('Go to pane'));
    expect(onGo).toHaveBeenCalledWith('sw-b2');
    click(button('Mark as seen'));
    expect(onSeen).toHaveBeenCalledWith('sw-b2');
  });

  it('ignores the second click of a double-click, aimed at the desk row this panel has just replaced', () => {
    const { target, button, onBack, onGo, onSeen } = panel(CHECKOUT, 'sw-b2');
    const press = (el: Element | null | undefined, detail: number) => el!.dispatchEvent(new MouseEvent('click', { bubbles: true, detail }));
    for (const el of [target.querySelector('.back'), button('Go to pane'), button('Mark as seen')]) press(el, 2);
    expect(onBack).not.toHaveBeenCalled();
    expect(onGo).not.toHaveBeenCalled();
    expect(onSeen).not.toHaveBeenCalled();
    // A single click acts, and so does a key press, whose click has detail 0.
    press(button('Go to pane'), 1);
    press(button('Go to pane'), 0);
    expect(onGo).toHaveBeenCalledTimes(2);
  });

  it('offers Mark as seen only when the session is done', () => {
    expect(panel(CHECKOUT, 'sw-a1').button('Mark as seen')).toBeUndefined();
  });

  it('turns Go off for a remote session, and says why', () => {
    const { target, button, onGo, facts } = panel(ORDERS, 'oa-k1');
    expect(text(target.querySelector('.eyebrow'))).toBe('orders-api · remote');
    expect(text(target.querySelector('.tag'))).toBe('remote');
    expect(button('Go to pane')!.disabled).toBe(true);
    click(button('Go to pane'));
    expect(onGo).not.toHaveBeenCalled();
    expect(text(target.querySelector('.actions + .p-note'))).toBe('It runs in the cloud: there is no tmux pane to go to.');
    expect(facts()['Pane']).toBe('none');
  });

  it('turns Go off for a local session outside tmux', () => {
    const { target, button } = panel(CHECKOUT, 'sw-a1', NOW, (d) => {
      d.pane = null;
      d.focusable = false;
    });
    expect(text(target.querySelector('.eyebrow'))).toBe('storefront-web · not in tmux');
    expect(button('Go to pane')!.disabled).toBe(true);
    expect(text(target.querySelector('.actions + .p-note'))).toBe('It does not run in a tmux pane, so there is nowhere to go.');
  });

  it('goes back to the floor', () => {
    const { target, onBack } = panel(CHECKOUT, 'sw-a1');
    click(target.querySelector('.back'));
    expect(onBack).toHaveBeenCalled();
  });

  it('shows a hostile title and reason as text', () => {
    const { target } = panel(CHECKOUT, 'oa-c3', NOW, (d) => {
      d.title = '<img src=x onerror=alert(1)>';
      d.reason = { kind: 'permission', text: '<script>x</script>', detail: null, agent: null };
    });
    expect(text(target.querySelector('.p-text'))).toBe('<img src=x onerror=alert(1)>');
    expect(text(target.querySelector('.warn'))).toBe('Permission: <script>x</script>');
    expect(target.querySelector('img, script')).toBeNull();
  });
});

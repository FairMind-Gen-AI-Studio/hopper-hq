import { afterEach, describe, expect, it, vi } from 'vitest';
import AttentionBar from '../../components/AttentionBar.svelte';
import { NOW, makeScene } from '../helpers/fixtures';
import { cleanup, click, render, text } from '../helpers/render';

afterEach(cleanup);

function bar(attention = makeScene().attention, now = NOW) {
  const onOpen = vi.fn();
  const onGo = vi.fn();
  const target = render(AttentionBar, { attention, now, onOpen, onGo });
  const group = (n: number) => target.querySelectorAll('.group')[n]!;
  const chips = (n: number) => [...group(n).querySelectorAll('.chip')];
  return { target, onOpen, onGo, group, chips };
}

describe('AttentionBar', () => {
  it('lists who needs you, longest wait first, then what is done, oldest first', () => {
    const { group, chips } = bar();
    expect(text(group(0).querySelector('.label'))).toBe('Needs you');
    expect(text(group(1).querySelector('.label'))).toBe('Done, to review');
    expect(chips(0).map((c) => text(c.querySelector('.who')))).toEqual(['orders-api-c3', 'orders-api-g7']);
    expect(chips(1).map((c) => text(c.querySelector('.who')))).toEqual(['orders-api-i9', 'storefront-web-b2']);
  });

  it('says what each waits for, who raised it, and for how long', () => {
    const { chips } = bar();
    expect(chips(0).map((c) => text(c.querySelector('.what')))).toEqual([
      'Permission: Bash (rm -rf dist && npm run build)',
      'Question: Should the retry queue use Redis or Postgres? · raised by Explore',
    ]);
    expect(chips(0).map((c) => text(c.querySelector('.time')))).toEqual(['12m', '4m']);
    expect(chips(1).map((c) => text(c.querySelector('.what')))).toEqual(['Explain the order state machine', 'Rewrite checkout copy and empty states']);
    expect(chips(1).map((c) => text(c.querySelector('.time')))).toEqual(['1h', '18m']);
  });

  it('names an unknown subagent, a missing reason and a missing title plainly', () => {
    const { needsYou, done } = makeScene().attention;
    needsYou[1]!.reason!.agent = { id: 'agent-9', type: null };
    needsYou[0]!.reason = null;
    done[0]!.title = null;
    const { chips } = bar({ needsYou, done });
    expect(chips(0).map((c) => text(c.querySelector('.what')))).toEqual(['Needs you', 'Question: Should the retry queue use Redis or Postgres? · raised by a subagent']);
    expect(text(chips(1)[0]!.querySelector('.what'))).toBe('Finished its turn');
  });

  it('says so when nobody waits and nothing is done', () => {
    const { target } = bar({ needsYou: [], done: [] });
    expect([...target.querySelectorAll('.empty')].map(text)).toEqual(['Nobody is waiting for you.', 'Nothing to review.']);
    expect(target.querySelectorAll('.chip')).toHaveLength(0);
  });

  it('opens a chip, and offers Go only where tmux can reach the session', () => {
    const scene = makeScene();
    scene.attention.done[1]!.focusable = false;
    const { chips, onOpen, onGo } = bar(scene.attention);
    click(chips(0)[1]!.querySelector('button.open'));
    expect(onOpen).toHaveBeenCalledWith(scene.attention.needsYou[1]);
    expect(chips(1)[1]!.querySelector('button.go')).toBeNull();
    const go = chips(0)[0]!.querySelector('button.go')!;
    expect(go.getAttribute('aria-label')).toBe('Go to the tmux pane of orders-api-c3');
    click(go);
    expect(onGo).toHaveBeenCalledWith(scene.attention.needsYou[0]);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('shows a hostile title as text', () => {
    const scene = makeScene();
    scene.attention.done[0]!.title = '<img src=x onerror=alert(1)>';
    const { target, chips } = bar(scene.attention);
    expect(text(chips(1)[0]!.querySelector('.what'))).toBe('<img src=x onerror=alert(1)>');
    expect(target.querySelector('img')).toBeNull();
  });
});

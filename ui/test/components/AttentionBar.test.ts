import { afterEach, describe, expect, it, vi } from 'vitest';
import AttentionBar from '../../components/AttentionBar.svelte';
import source from '../../components/AttentionBar.svelte?raw';
import tokens from '../../styles/tokens.css?raw';
import { NOW, makeScene } from '../helpers/fixtures';
import { cleanup, click, render, text } from '../helpers/render';

afterEach(cleanup);

/** The declarations of the component's rule for exactly this selector; happy-dom lays nothing out. */
function rule(selector: string): Record<string, string> {
  const at = source.indexOf(`\n  ${selector} {`, source.indexOf('<style>'));
  expect(at, selector).toBeGreaterThan(0);
  const body = source.slice(source.indexOf('{', at) + 1, source.indexOf('}', at));
  return Object.fromEntries(body.split(';').map((d) => d.trim()).filter(Boolean).map((d) => [d.slice(0, d.indexOf(':')).trim(), d.slice(d.indexOf(':') + 1).trim()]));
}

/** A colour token of a tokens.css block: the day one, or the night one the toggle forces. */
function token(name: string, night: boolean): string {
  const block = night ? tokens.match(/:root\[data-theme="dark"\] \{([^}]*)\}/)![1]! : tokens.match(/(?:^|\n):root \{([^}]*)\}/)![1]!;
  return block.match(new RegExp(`--${name}:\\s*(#[0-9A-Fa-f]{6})`))![1]!;
}

function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

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

  it('sends Go once for a double-click', () => {
    const { chips, onGo } = bar();
    const go = chips(0)[0]!.querySelector('button.go')!;
    for (const detail of [1, 2]) go.dispatchEvent(new MouseEvent('click', { bubbles: true, detail }));
    expect(onGo).toHaveBeenCalledTimes(1);
  });

  it('shows a hostile title as text', () => {
    const scene = makeScene();
    scene.attention.done[0]!.title = '<img src=x onerror=alert(1)>';
    const { target, chips } = bar(scene.attention);
    expect(text(chips(1)[0]!.querySelector('.what'))).toBe('<img src=x onerror=alert(1)>');
    expect(target.querySelector('img')).toBeNull();
  });

  it('shows where each session stands under its chip, with its age, and says when a prompt came after it', () => {
    const plain = bar().chips(0)[0]!;
    const classes = [plain.className, plain.querySelector('button.open')!.className];
    expect(plain.querySelector('.sub')).toBeNull();
    cleanup();
    const scene = makeScene();
    scene.attention.needsYou[0]!.summary = { text: 'Idempotency keys are in; waits for permission to rebuild dist', at: NOW - 13 * 60_000, stale: true };
    scene.attention.done[1]!.summary = { text: 'Copy is rewritten and ready for review', at: NOW - 17 * 60_000, stale: false };
    const { chips } = bar(scene.attention);
    const subs = [chips(0)[0]!, chips(1)[1]!].map((c) => c.querySelector('.sub')!);
    expect(subs.map(text)).toEqual(['Idempotency keys are in; waits for permission to rebuild dist · 13m ago (older than the last prompt)', 'Copy is rewritten and ready for review · 17m ago']);
    expect(subs.map((s) => s.classList.contains('stale'))).toEqual([true, false]);
    expect(chips(0)[1]!.querySelector('.sub')).toBeNull();
    // A chip with a line is the same chip: its size does not depend on it.
    expect([chips(0)[0]!.className, chips(0)[0]!.querySelector('button.open')!.className]).toEqual(classes);
  });
});

describe('AttentionBar layout', () => {
  it("keeps each group's label on the first row of its chips, so no row of the bar is cut through a chip", () => {
    expect(rule('.group')).toMatchObject({ 'flex-wrap': 'nowrap', 'align-items': 'flex-start' });
    expect(rule('.label')).toMatchObject({ flex: 'none', 'white-space': 'nowrap' });
    expect(rule('.chips')).toMatchObject({ flex: '1 1 0', 'min-width': '0' });
  });

  it('keeps some of a summary in view in a narrow chip, and lets its age give way rather than spill over Go', () => {
    expect(rule('.sub')).toMatchObject({ overflow: 'hidden' });
    expect(rule('.s-text')).toMatchObject({ flex: '1 1 8ch', 'min-width': '8ch' });
    expect(rule('.s-age')).toMatchObject({ flex: '0 1 auto', 'min-width': '0', overflow: 'hidden', 'text-overflow': 'ellipsis' });
  });

  it('writes an out-of-date line in the muted colour, readable by day and by night', () => {
    expect(source).not.toMatch(/opacity/);
    for (const night of [false, true]) expect(contrast(token('muted', night), token('panel', night))).toBeGreaterThanOrEqual(4.5);
  });

  it('sets an out-of-date line in italics, which stay in view in a narrow chip when the words saying so give way', () => {
    expect(rule('.stale .s-text')).toEqual({ 'font-style': 'italic' });
    expect(rule('.s-text')).not.toHaveProperty('font-style');
    expect(rule('.s-text')).toMatchObject({ 'min-width': '8ch' });
  });
});

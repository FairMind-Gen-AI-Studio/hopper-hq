import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createToasts, type Toast } from '../../lib/toast';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function watch(toasts: ReturnType<typeof createToasts>) {
  let list: readonly Toast[] = [];
  toasts.subscribe((l) => (list = l));
  return () => list.map((t) => `${t.tone}:${t.text}`);
}

describe('toasts', () => {
  it('shows messages in order, cleaned, and drops each after a while', () => {
    const toasts = createToasts();
    const seen = watch(toasts);
    toasts.show('Demo: would switch tmux to %7');
    toasts.show('No tmux client\u001b[0m is attached', 'error');
    expect(seen()).toEqual(['info:Demo: would switch tmux to %7', 'error:No tmux client[0m is attached']);
    vi.advanceTimersByTime(3999);
    expect(seen()).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(seen()).toEqual(['error:No tmux client[0m is attached']);
    vi.advanceTimersByTime(2000);
    expect(seen()).toEqual([]);
  });

  it('keeps the three newest', () => {
    const toasts = createToasts();
    const seen = watch(toasts);
    for (const n of [1, 2, 3, 4]) toasts.show(`m${n}`);
    expect(seen()).toEqual(['info:m2', 'info:m3', 'info:m4']);
  });

  it('dismisses one by id, and all at once', () => {
    const toasts = createToasts();
    const seen = watch(toasts);
    const a = toasts.show('a');
    toasts.show('b');
    toasts.dismiss(a);
    expect(seen()).toEqual(['info:b']);
    toasts.clear();
    expect(seen()).toEqual([]);
    vi.advanceTimersByTime(10_000);
    expect(seen()).toEqual([]);
  });

  it('ignores an empty message', () => {
    const toasts = createToasts();
    const seen = watch(toasts);
    expect(toasts.show(' \u0007 ')).toBe(-1);
    expect(seen()).toEqual([]);
  });
});

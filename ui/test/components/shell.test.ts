import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'svelte';
import StatePill from '../../components/StatePill.svelte';
import Toast from '../../components/Toast.svelte';
import { createToasts } from '../../lib/toast';
import { cleanup, click, render, text } from '../helpers/render';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('StatePill', () => {
  it('names the state and carries its colour class', () => {
    const target = render(StatePill, { state: 'needs_you' });
    const pill = target.querySelector('.pill')!;
    expect(text(pill)).toBe('Needs you');
    expect(pill.classList.contains('sw-needs_you')).toBe(true);
  });
});

describe('Toast', () => {
  it('shows each toast as text, marks errors, and dismisses on click', () => {
    vi.useFakeTimers();
    const toasts = createToasts();
    const target = render(Toast, { toasts });
    toasts.show('Demo: would switch tmux to %7');
    toasts.show('<b>tmux</b> could not switch', 'error');
    flushSync();
    const shown = [...target.querySelectorAll('.toast')];
    expect(shown.map((t) => text(t.querySelector('span')))).toEqual(['Demo: would switch tmux to %7', '<b>tmux</b> could not switch']);
    expect(shown.map((t) => t.classList.contains('error'))).toEqual([false, true]);
    expect(target.querySelector('b')).toBeNull();
    click(shown[0]!.querySelector('button'));
    expect(target.querySelectorAll('.toast')).toHaveLength(1);
    vi.advanceTimersByTime(6000);
    flushSync();
    expect(target.querySelectorAll('.toast')).toHaveLength(0);
  });
});

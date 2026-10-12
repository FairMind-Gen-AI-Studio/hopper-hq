import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  THEME_KEY,
  applyTheme,
  loadTheme,
  nextTheme,
  parseTheme,
  resolvedTheme,
  saveTheme,
  systemPrefersDark,
  watchSystemTheme,
} from '../../lib/theme';

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}
const broken = {
  getItem: () => {
    throw new Error('SecurityError');
  },
  setItem: () => {
    throw new Error('QuotaExceededError');
  },
  removeItem: () => {
    throw new Error('SecurityError');
  },
};

afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.removeAttribute('data-theme');
});

describe('theme preference', () => {
  it('parses what was stored, and anything else as system', () => {
    expect(parseTheme('day')).toBe('day');
    expect(parseTheme('night')).toBe('night');
    expect(parseTheme('system')).toBe('system');
    expect(parseTheme('dark')).toBe('system');
    expect(parseTheme(null)).toBe('system');
  });

  it('cycles system, day, night', () => {
    expect(nextTheme('system')).toBe('day');
    expect(nextTheme('day')).toBe('night');
    expect(nextTheme('night')).toBe('system');
  });

  it('remembers day and night, and forgets system', () => {
    const storage = memoryStorage();
    saveTheme(storage, 'night');
    expect(storage.data.get(THEME_KEY)).toBe('night');
    expect(loadTheme(storage)).toBe('night');
    saveTheme(storage, 'system');
    expect(storage.data.has(THEME_KEY)).toBe(false);
    expect(loadTheme(storage)).toBe('system');
  });

  it('falls back to system when storage is missing or refuses', () => {
    expect(loadTheme(null)).toBe('system');
    expect(loadTheme(broken)).toBe('system');
    expect(() => saveTheme(broken, 'day')).not.toThrow();
    expect(() => saveTheme(null, 'day')).not.toThrow();
  });

  it('marks the page light, dark, or neither', () => {
    const root = document.documentElement;
    applyTheme(root, 'night');
    expect(root.getAttribute('data-theme')).toBe('dark');
    applyTheme(root, 'day');
    expect(root.getAttribute('data-theme')).toBe('light');
    applyTheme(root, 'system');
    expect(root.hasAttribute('data-theme')).toBe(false);
  });

  it('resolves system to what the system prefers', () => {
    expect(resolvedTheme('system', true)).toBe('night');
    expect(resolvedTheme('system', false)).toBe('day');
    expect(resolvedTheme('day', true)).toBe('day');
    expect(resolvedTheme('night', false)).toBe('night');
  });

  it('follows the system scheme and stops when asked', () => {
    let listener: ((e: { matches: boolean }) => void) | null = null;
    const mql = {
      matches: true,
      addEventListener: (_: string, fn: (e: { matches: boolean }) => void) => void (listener = fn),
      removeEventListener: () => void (listener = null),
    };
    vi.spyOn(window, 'matchMedia').mockReturnValue(mql as unknown as MediaQueryList);
    expect(systemPrefersDark()).toBe(true);
    const seen: boolean[] = [];
    const stop = watchSystemTheme((dark) => seen.push(dark));
    listener!({ matches: false });
    expect(seen).toEqual([false]);
    stop();
    expect(listener).toBeNull();
  });

  it('treats a browser without matchMedia as a light system', () => {
    vi.spyOn(window, 'matchMedia').mockImplementation(() => {
      throw new Error('not supported');
    });
    expect(systemPrefersDark()).toBe(false);
    expect(() => watchSystemTheme(() => {})()).not.toThrow();
  });
});

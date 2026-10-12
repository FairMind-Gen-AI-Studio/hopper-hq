/**
 * The theme the user picked: follow the system, or force day or night. Kept in localStorage, which a browser may
 * refuse (private windows, blocked site data): every access is wrapped, and the theme then falls back to system.
 */
export type ThemePreference = 'system' | 'day' | 'night';

export const THEME_KEY = 'scranton-hq.theme';

const ORDER: readonly ThemePreference[] = ['system', 'day', 'night'];

export const THEME_LABEL: Record<ThemePreference, string> = { system: 'System', day: 'Day', night: 'Night' };

type ThemeStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function parseTheme(value: unknown): ThemePreference {
  return value === 'day' || value === 'night' ? value : 'system';
}

/** The toggle's next step: system, day, night, and round again. */
export function nextTheme(pref: ThemePreference): ThemePreference {
  return ORDER[(ORDER.indexOf(pref) + 1) % ORDER.length]!;
}

/** The page's storage, or null when the browser refuses it. */
export function browserStorage(): ThemeStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function loadTheme(storage: ThemeStorage | null): ThemePreference {
  try {
    return parseTheme(storage?.getItem(THEME_KEY));
  } catch {
    return 'system';
  }
}

/** Day and night are remembered; system is the absence of a choice. */
export function saveTheme(storage: ThemeStorage | null, pref: ThemePreference): void {
  try {
    if (pref === 'system') storage?.removeItem(THEME_KEY);
    else storage?.setItem(THEME_KEY, pref);
  } catch {
    // Not remembered: the choice still holds until the page is closed.
  }
}

/** tokens.css reads `data-theme`: light forces day, dark forces night, and without it the system decides. */
export function applyTheme(root: HTMLElement, pref: ThemePreference): void {
  if (pref === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', pref === 'day' ? 'light' : 'dark');
}

export function resolvedTheme(pref: ThemePreference, prefersDark: boolean): 'day' | 'night' {
  if (pref !== 'system') return pref;
  return prefersDark ? 'night' : 'day';
}

const DARK_QUERY = '(prefers-color-scheme: dark)';

export function systemPrefersDark(): boolean {
  try {
    return window.matchMedia(DARK_QUERY).matches;
  } catch {
    return false;
  }
}

/** Calls `fn` whenever the system switches between light and dark. Returns the way to stop. */
export function watchSystemTheme(fn: (prefersDark: boolean) => void): () => void {
  try {
    const query = window.matchMedia(DARK_QUERY);
    const onChange = (e: { matches: boolean }) => fn(e.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  } catch {
    return () => {};
  }
}

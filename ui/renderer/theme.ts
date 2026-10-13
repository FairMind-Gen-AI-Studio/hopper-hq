/**
 * The theme tokens the 3D floor reads from the page's CSS custom properties (outline §2.11), parsed and checked.
 * A missing or unreadable value falls back to the built-in day theme, so the floor always draws.
 */

export const COLOR_TOKENS = [
  'scene-floor',
  'scene-wall',
  'scene-base',
  'scene-desk',
  'scene-leg',
  'scene-chair',
  'scene-monitor',
  'scene-key',
  'scene-plant',
  'scene-pot',
  'scene-elevator',
  'scene-frame',
  'scene-paper',
  'scene-board',
  'scene-glass',
  'bot-shell',
  'bot-visor',
  'bot-hardhat',
  'bot-jet',
  'window-glow',
  'lamp-glow',
  'hemi-sky',
  'hemi-ground',
  'sun',
  'accent',
  's-working',
  's-needs',
  's-done',
  's-meeting',
  's-nosignal',
  'repo-0',
  'repo-1',
  'repo-2',
  'repo-3',
  'repo-4',
  'repo-5',
  'repo-6',
  'repo-7',
  'feature-0',
  'feature-1',
  'feature-2',
  'feature-3',
  'feature-4',
  'feature-5',
  'feature-6',
  'feature-7',
  'feature-none',
] as const;

export const NUMBER_TOKENS = ['visor-int', 'window-int', 'lamp-int', 'screen-int', 'hemi-int', 'sun-int'] as const;

export type ColorToken = (typeof COLOR_TOKENS)[number];
export type NumberToken = (typeof NUMBER_TOKENS)[number];

export interface ThemeTokens {
  /** '#rrggbb', lower case. */
  colors: Record<ColorToken, string>;
  numbers: Record<NumberToken, number>;
  reducedMotion: boolean;
}

/** The day theme of ui/styles/tokens.css, from prototypes/floor-3d-mockup.html. */
export const DAY_COLORS: Readonly<Record<ColorToken, string>> = {
  'scene-floor': '#e5e1ea',
  'scene-wall': '#eee8e0',
  'scene-base': '#d3cbc2',
  'scene-desk': '#efe8da',
  'scene-leg': '#3a3f4b',
  'scene-chair': '#7c8db0',
  'scene-monitor': '#23262e',
  'scene-key': '#d9dce3',
  'scene-plant': '#4e9a5a',
  'scene-pot': '#c46e4f',
  'scene-elevator': '#a9b0bc',
  'scene-frame': '#5c6170',
  'scene-paper': '#ffffff',
  'scene-board': '#fafafa',
  'scene-glass': '#bcd7f2',
  'bot-shell': '#d5dae1',
  'bot-visor': '#7fe7ff',
  'bot-hardhat': '#4a5163',
  'bot-jet': '#6b7280',
  'window-glow': '#cfe4f7',
  'lamp-glow': '#ffe2a8',
  'hemi-sky': '#ffffff',
  'hemi-ground': '#b9b2c4',
  sun: '#fff4e5',
  accent: '#2c59c9',
  's-working': '#e8b030',
  's-needs': '#d63a3a',
  's-done': '#1c9a6a',
  's-meeting': '#6857db',
  's-nosignal': '#c88a35',
  'repo-0': '#3fb8b0',
  'repo-1': '#e58fb9',
  'repo-2': '#7c8fe8',
  'repo-3': '#f2a65a',
  'repo-4': '#7fbf6a',
  'repo-5': '#b88be0',
  'repo-6': '#4fa3d9',
  'repo-7': '#b7967a',
  'feature-0': '#2e3a59',
  'feature-1': '#7a2e4d',
  'feature-2': '#1f5c4a',
  'feature-3': '#8a4b14',
  'feature-4': '#3d2e7a',
  'feature-5': '#0f5a73',
  'feature-6': '#5e5410',
  'feature-7': '#7a1f1f',
  'feature-none': '#4a5163',
};

export const DAY_NUMBERS: Readonly<Record<NumberToken, number>> = {
  'visor-int': 1,
  'window-int': 0.45,
  'lamp-int': 0.6,
  'screen-int': 0.9,
  'hemi-int': 1.15,
  'sun-int': 1.7,
};

/** '#rgb' or '#rrggbb', any case, surrounding spaces allowed, to '#rrggbb' in lower case; anything else is null. */
export function parseColor(raw: string): string | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(raw.trim());
  if (!m) return null;
  const hex = m[1]!.toLowerCase();
  return '#' + (hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex);
}

/** A plain decimal, finite and not negative; anything else is null. */
export function parseNumber(raw: string): number | null {
  const text = raw.trim();
  if (!/^\d*\.?\d+$/.test(text)) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

/** read('--scene-floor') -> raw CSS value; missing/invalid values fall back to built-in day defaults. */
export function readThemeTokens(read: (cssVar: string) => string, reducedMotion: boolean): ThemeTokens {
  const colors = { ...DAY_COLORS };
  for (const name of COLOR_TOKENS) colors[name] = parseColor(String(read('--' + name) ?? '')) ?? DAY_COLORS[name];
  const numbers = { ...DAY_NUMBERS };
  for (const name of NUMBER_TOKENS) numbers[name] = parseNumber(String(read('--' + name) ?? '')) ?? DAY_NUMBERS[name];
  return { colors, numbers, reducedMotion };
}

/** The built-in day theme. */
export function dayTheme(reducedMotion = false): ThemeTokens {
  return { colors: { ...DAY_COLORS }, numbers: { ...DAY_NUMBERS }, reducedMotion };
}

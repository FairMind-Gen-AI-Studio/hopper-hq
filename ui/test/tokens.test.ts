import { describe, expect, it } from 'vitest';
import css from '../styles/tokens.css?raw';

/** Outline §2.11: what Part D's renderer reads. */
const RENDERER_COLORS = [
  'scene-floor', 'scene-wall', 'scene-base', 'scene-desk', 'scene-leg', 'scene-chair', 'scene-monitor', 'scene-key', 'scene-plant',
  'scene-pot', 'scene-elevator', 'scene-frame', 'scene-paper', 'bot-shell', 'bot-visor', 'window-glow', 'lamp-glow', 'hemi-sky',
  'hemi-ground', 'sun', 'accent', 's-working', 's-needs', 's-done', 's-meeting', 's-nosignal',
  ...[0, 1, 2, 3, 4, 5, 6, 7].map((n) => `repo-${n}`),
  ...[0, 1, 2, 3, 4, 5, 6, 7].map((n) => `feature-${n}`),
  'feature-none',
];
const RENDERER_NUMBERS = ['visor-int', 'window-int', 'lamp-int', 'screen-int', 'hemi-int', 'sun-int'];
/** Outline §2.11: what the CSS and the SVG use, plus the label halo and the placard colours. */
const UI_TOKENS = [
  'bg', 'sky', 'fg', 'muted', 'panel', 'line', 'hover', 'halo', 'shade', 'edge', 'shadow', 'wall', 'slab', 'roof', 'plinth',
  'win-off', 'win-back', 'shutter', 'win-filter', 'needs-ink', 'done-ink', 'working-ink', 'meeting-ink', 'nosignal-ink',
  'badge-fg', 'tmux-bg', 'tmux-fg', 'tmux-needs', 'tmux-done', 'sign-bg', 'sign-fg', 'font-display', 'font-body', 'font-mono',
];

/** The values Part D's built-in day defaults copy (published with Task C1): [day, night]. */
const SLOTS = ['#3FB8B0', '#E58FB9', '#7C8FE8', '#F2A65A', '#7FBF6A', '#B88BE0', '#4FA3D9', '#B7967A'];
const TIES = ['#2E3A59', '#7A2E4D', '#1F5C4A', '#8A4B14', '#3D2E7A', '#0F5A73', '#5E5410', '#7A1F1F'];
const PUBLISHED: Record<string, [string, string]> = {
  'scene-floor': ['#E5E1EA', '#3A3F55'], 'scene-wall': ['#EEE8E0', '#484D62'], 'scene-base': ['#D3CBC2', '#2E3245'],
  'scene-desk': ['#EFE8DA', '#8C877C'], 'scene-leg': ['#3A3F4B', '#15181F'], 'scene-chair': ['#7C8DB0', '#4F5B7A'],
  'scene-monitor': ['#23262E', '#0E1015'], 'scene-key': ['#D9DCE3', '#6B7080'], 'scene-plant': ['#4E9A5A', '#2F6B3B'],
  'scene-pot': ['#C46E4F', '#7E4532'], 'scene-elevator': ['#A9B0BC', '#5E6575'], 'scene-frame': ['#5C6170', '#2A2E3A'],
  'scene-paper': ['#FFFFFF', '#E4E7EE'], 'bot-shell': ['#D5DAE1', '#7E8796'], 'bot-visor': ['#7FE7FF', '#8FF0FF'],
  'window-glow': ['#CFE4F7', '#2A3A6E'], 'lamp-glow': ['#FFE2A8', '#FFC870'], 'hemi-sky': ['#FFFFFF', '#8EA2D8'],
  'hemi-ground': ['#B9B2C4', '#1A1D2A'], sun: ['#FFF4E5', '#9DB4FF'], accent: ['#2C59C9', '#7EA4FF'],
  's-working': ['#E8B030', '#FFD27A'], 's-needs': ['#D63A3A', '#FF5A5F'], 's-done': ['#1C9A6A', '#3DD68C'],
  's-meeting': ['#6857DB', '#9B8CFF'], 's-nosignal': ['#C88A35', '#D9A04A'],
  ...Object.fromEntries(SLOTS.map((c, n) => [`repo-${n}`, [c, c]])),
  ...Object.fromEntries(TIES.map((c, n) => [`feature-${n}`, [c, c]])),
  'feature-none': ['#4A5163', '#4A5163'],
  'visor-int': ['1', '1.8'], 'window-int': ['0.45', '0.9'], 'lamp-int': ['0.6', '2.4'], 'screen-int': ['0.9', '2'],
  'hemi-int': ['1.15', '0.6'], 'sun-int': ['1.7', '0.55'],
};

function declarations(body: string | undefined): Map<string, string> {
  expect(body, 'block not found').toBeDefined();
  return new Map([...body!.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
}
const day = declarations(css.match(/(?:^|\n):root \{([^}]*)\}/)?.[1]);
const systemNight = declarations(css.match(/@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme="light"\]\) \{([^}]*)\}/)?.[1]);
const forcedNight = declarations(css.match(/:root\[data-theme="dark"\] \{([^}]*)\}/)?.[1]);

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

describe('theme tokens', () => {
  it('defines every renderer token in the day theme and in both night blocks', () => {
    for (const theme of [day, systemNight, forcedNight]) {
      for (const name of RENDERER_COLORS) expect(theme.get(name), name).toMatch(/^#[0-9A-F]{6}$/);
      for (const name of RENDERER_NUMBERS) expect(theme.get(name), name).toMatch(/^\d+(?:\.\d+)?$/);
    }
  });

  it('keeps the values Part D was given', () => {
    for (const [name, [d, n]] of Object.entries(PUBLISHED)) {
      expect(day.get(name), name).toBe(d);
      expect(forcedNight.get(name), name).toBe(n);
    }
    expect(Object.keys(PUBLISHED).sort()).toEqual([...RENDERER_COLORS, ...RENDERER_NUMBERS].sort());
  });

  it('gives night the same values whether the system or the toggle asks for it', () => {
    expect([...systemNight]).toEqual([...forcedNight]);
  });

  it('defines the UI tokens, with a system fallback for each bundled font', () => {
    for (const name of UI_TOKENS) expect(day.has(name), name).toBe(true);
    expect(day.get('font-display')).toMatch(/^"Archivo", .*sans-serif$/);
    expect(day.get('font-body')).toMatch(/^"IBM Plex Sans", .*system-ui.*sans-serif$/);
    expect(day.get('font-mono')).toMatch(/^"IBM Plex Mono", .*ui-monospace.*monospace$/);
    expect(day.get('font-display')).not.toBe(day.get('font-body'));
  });

  it('shows every rug on the floor and every tie on every body, day and night', () => {
    for (const theme of [day, forcedNight]) {
      const repos = SLOTS.map((_, n) => theme.get(`repo-${n}`)!);
      const ties = [...TIES.map((_, n) => theme.get(`feature-${n}`)!), theme.get('feature-none')!];
      for (const repo of repos) {
        expect(contrast(repo, theme.get('scene-floor')!), `${repo} on the floor`).toBeGreaterThanOrEqual(1.5);
        for (const tie of ties) expect(contrast(tie, repo), `${tie} on ${repo}`).toBeGreaterThanOrEqual(2);
      }
      expect(new Set(repos).size).toBe(8);
      expect(new Set(ties).size).toBe(9);
    }
  });

  it('tells the browser which scheme each theme is', () => {
    expect(css.match(/(?:^|\n):root \{[^}]*color-scheme: light;/)).not.toBeNull();
    expect(css.match(/:root:not\(\[data-theme="light"\]\) \{[^}]*color-scheme: dark;/)).not.toBeNull();
    expect(css.match(/:root\[data-theme="dark"\] \{[^}]*color-scheme: dark;/)).not.toBeNull();
  });
});

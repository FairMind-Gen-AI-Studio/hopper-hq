import { describe, expect, it } from 'vitest';
import {
  COLOR_TOKENS,
  DAY_COLORS,
  DAY_NUMBERS,
  NUMBER_TOKENS,
  dayTheme,
  parseColor,
  parseNumber,
  readThemeTokens,
} from '../../renderer/theme';

/** A few night values of ui/styles/tokens.css, as getPropertyValue returns them (raw text, leading space). */
const NIGHT: Record<string, string> = {
  '--scene-floor': ' #3A3F55',
  '--bot-visor': ' #8FF0FF',
  '--s-needs': '#FF5A5F',
  '--visor-int': ' 1.8',
  '--screen-int': '2',
  '--sun-int': ' 0.55',
};

describe('theme tokens', () => {
  it('lists the renderer tokens, the room tokens among them, without the leading dashes', () => {
    expect(COLOR_TOKENS).toHaveLength(47);
    expect(new Set(COLOR_TOKENS).size).toBe(47);
    expect(COLOR_TOKENS).toEqual(expect.arrayContaining(['scene-floor', 'bot-visor', 'accent', 's-nosignal', 'repo-7', 'feature-7', 'feature-none']));
    expect(COLOR_TOKENS).toEqual(expect.arrayContaining(['scene-board', 'bot-hardhat', 'bot-jet']));
    expect([DAY_COLORS['scene-board'], DAY_COLORS['bot-hardhat'], DAY_COLORS['bot-jet']]).toEqual(['#fafafa', '#4a5163', '#6b7280']);
    expect([COLOR_TOKENS.includes('scene-glass'), DAY_COLORS['scene-glass']]).toEqual([true, '#bcd7f2']);
    expect(NUMBER_TOKENS).toEqual(['visor-int', 'window-int', 'lamp-int', 'screen-int', 'hemi-int', 'sun-int']);
    for (const name of [...COLOR_TOKENS, ...NUMBER_TOKENS]) expect(name.startsWith('-')).toBe(false);
    expect(Object.keys(DAY_COLORS).sort()).toEqual([...COLOR_TOKENS].sort());
    expect(Object.keys(DAY_NUMBERS).sort()).toEqual([...NUMBER_TOKENS].sort());
  });

  it('reads each token through the reader, as a custom property', () => {
    const asked: string[] = [];
    readThemeTokens((v) => {
      asked.push(v);
      return '';
    }, false);
    expect(asked).toEqual([...COLOR_TOKENS, ...NUMBER_TOKENS].map((n) => '--' + n));
  });

  it('parses the values it is given and keeps the day theme for the rest', () => {
    const theme = readThemeTokens((v) => NIGHT[v] ?? '', true);
    expect(theme.colors['scene-floor']).toBe('#3a3f55');
    expect(theme.colors['bot-visor']).toBe('#8ff0ff');
    expect(theme.colors['s-needs']).toBe('#ff5a5f');
    expect(theme.colors['scene-wall']).toBe(DAY_COLORS['scene-wall']);
    expect(theme.numbers).toEqual({ ...DAY_NUMBERS, 'visor-int': 1.8, 'screen-int': 2, 'sun-int': 0.55 });
    expect(theme.reducedMotion).toBe(true);
  });

  it('falls back to the day theme for garbage', () => {
    const garbage = ['red', '#12345', '#ggg', 'url(x)', 'rgb(1, 2, 3)', '#1234567', '-1', '1e3', 'abc', '1.'];
    for (const value of garbage) {
      const theme = readThemeTokens(() => value, false);
      expect(theme.colors, value).toEqual(DAY_COLORS);
      expect(theme.numbers, value).toEqual(DAY_NUMBERS);
    }
  });

  it('normalises colours and numbers', () => {
    expect(parseColor('#ABC')).toBe('#aabbcc');
    expect(parseColor('  #E5E1EA ')).toBe('#e5e1ea');
    expect(parseColor('E5E1EA')).toBeNull();
    expect(parseColor('')).toBeNull();
    expect(parseNumber(' 0.45 ')).toBe(0.45);
    expect(parseNumber('.5')).toBe(0.5);
    expect(parseNumber('0')).toBe(0);
    expect(parseNumber('Infinity')).toBeNull();
    expect(parseNumber('')).toBeNull();
  });

  it('hands out copies of the day theme', () => {
    const a = dayTheme();
    a.colors['scene-floor'] = '#000000';
    a.numbers['sun-int'] = 0;
    expect(dayTheme().colors['scene-floor']).toBe('#e5e1ea');
    expect(DAY_NUMBERS['sun-int']).toBe(1.7);
    expect(dayTheme(true).reducedMotion).toBe(true);
  });
});

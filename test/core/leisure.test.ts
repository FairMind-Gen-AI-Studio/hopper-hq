import { describe, expect, it } from 'vitest';
import { DEFAULT_LEISURE_WINDOW } from '../../src/config.js';
import { assignLeisure, inLeisureWindow, leisureOf, waitingSubagents } from '../../src/core/leisure.js';

describe('inLeisureWindow', () => {
  const hourOf = (h: number) => () => h;

  it('matches the office aperitivo window (17:00 -> 02:00, wraps midnight)', () => {
    expect(inLeisureWindow(0, DEFAULT_LEISURE_WINDOW, hourOf(16))).toBe(false); // 16:59
    expect(inLeisureWindow(0, DEFAULT_LEISURE_WINDOW, hourOf(17))).toBe(true); // 17:00
    expect(inLeisureWindow(0, DEFAULT_LEISURE_WINDOW, hourOf(23))).toBe(true); // 23:59
    expect(inLeisureWindow(0, DEFAULT_LEISURE_WINDOW, hourOf(0))).toBe(true); // 00:30
    expect(inLeisureWindow(0, DEFAULT_LEISURE_WINDOW, hourOf(1))).toBe(true); // 01:59
    expect(inLeisureWindow(0, DEFAULT_LEISURE_WINDOW, hourOf(2))).toBe(false); // 02:00
  });

  it('handles a non-wrapping window', () => {
    const window = { fromHour: 18, toHour: 24 };
    expect(inLeisureWindow(0, window, hourOf(18))).toBe(true);
    expect(inLeisureWindow(0, window, hourOf(20))).toBe(true);
    expect(inLeisureWindow(0, window, hourOf(23))).toBe(true);
    expect(inLeisureWindow(0, window, hourOf(9))).toBe(false);
    expect(inLeisureWindow(0, window, hourOf(17))).toBe(false);
  });

  it('handles an arbitrary wrapping window', () => {
    const window = { fromHour: 22, toHour: 2 };
    expect(inLeisureWindow(0, window, hourOf(23))).toBe(true);
    expect(inLeisureWindow(0, window, hourOf(1))).toBe(true);
    expect(inLeisureWindow(0, window, hourOf(12))).toBe(false);
  });

  it('defaults hourOf to the viewer-local hour of `now`', () => {
    const inWindow = new Date(2026, 0, 1, 18, 0, 0).getTime();
    const outOfWindow = new Date(2026, 0, 1, 10, 0, 0).getTime();
    expect(inLeisureWindow(inWindow)).toBe(true);
    expect(inLeisureWindow(outOfWindow)).toBe(false);
  });
});

describe('waitingSubagents', () => {
  it('returns the finished ids only when at least one sibling is still running', () => {
    expect(waitingSubagents([{ id: 'a', running: true }, { id: 'b', running: false }])).toEqual(['b']);
  });

  it('returns [] when every sibling is running', () => {
    expect(waitingSubagents([{ id: 'a', running: true }, { id: 'b', running: true }])).toEqual([]);
  });

  it('returns [] when every sibling is finished (nobody to wait for)', () => {
    expect(waitingSubagents([{ id: 'a', running: false }, { id: 'b', running: false }])).toEqual([]);
  });

  it('returns [] for an empty list', () => {
    expect(waitingSubagents([])).toEqual([]);
  });
});

describe('assignLeisure', () => {
  it('pairs waiters into biliardino with a lone leftover on gintonic, inside the window', () => {
    expect(assignLeisure(['a'], true)).toEqual(new Map([['a', 'gintonic']]));
    expect(assignLeisure(['a', 'b'], true)).toEqual(new Map([['a', 'biliardino'], ['b', 'biliardino']]));
    expect(assignLeisure(['a', 'b', 'c'], true)).toEqual(
      new Map([['a', 'biliardino'], ['b', 'biliardino'], ['c', 'gintonic']]),
    );
  });

  it('is deterministic regardless of input order (sorts by code unit)', () => {
    expect(assignLeisure(['c', 'a', 'b'], true)).toEqual(assignLeisure(['a', 'b', 'c'], true));
    expect(assignLeisure(['z', 'a'], true)).toEqual(new Map([['a', 'biliardino'], ['z', 'biliardino']]));
  });

  it('sends every waiter for coffee outside the window, whatever the count', () => {
    expect(assignLeisure([], false)).toEqual(new Map());
    expect(assignLeisure(['a'], false)).toEqual(new Map([['a', 'coffee']]));
    expect(assignLeisure(['a', 'b', 'c'], false)).toEqual(
      new Map([['a', 'coffee'], ['b', 'coffee'], ['c', 'coffee']]),
    );
  });

  it('returns an empty map for no waiters', () => {
    expect(assignLeisure([], true)).toEqual(new Map());
  });
});

describe('leisureOf', () => {
  const hourOf = (h: number) => () => h;
  const agents = [
    { id: 'a', running: false },
    { id: 'b', running: false },
    { id: 'c', running: true },
  ];

  it('pairs waiters for biliardino/gintonic inside the window', () => {
    expect(leisureOf(0, agents, DEFAULT_LEISURE_WINDOW, hourOf(18))).toEqual(
      new Map([['a', 'biliardino'], ['b', 'biliardino']]),
    );
  });

  it('sends waiters for coffee outside the window (new OQ-3 scope)', () => {
    expect(leisureOf(0, agents, DEFAULT_LEISURE_WINDOW, hourOf(10))).toEqual(
      new Map([['a', 'coffee'], ['b', 'coffee']]),
    );
  });

  it('is empty when nobody is waiting, in or out of the window', () => {
    const allRunning = [{ id: 'a', running: true }, { id: 'b', running: true }];
    expect(leisureOf(0, allRunning, DEFAULT_LEISURE_WINDOW, hourOf(18))).toEqual(new Map());
    expect(leisureOf(0, allRunning, DEFAULT_LEISURE_WINDOW, hourOf(10))).toEqual(new Map());
  });
});

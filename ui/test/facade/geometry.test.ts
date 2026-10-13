import { describe, expect, it } from 'vitest';
import type { FloorSummary } from '../../../src/scene/types';
import { FLOOR_H, LABEL_W, LOBBY_H, TW, box, facadeOf, points, project, type FacadeModel } from '../../facade/geometry';
import { makeScene } from '../helpers/fixtures';

/** Every x,y pair the model draws, from points strings and lines. */
function everyPoint(m: FacadeModel): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const walk = (v: unknown): void => {
    if (typeof v === 'string' && /^-?\d/.test(v)) for (const p of v.split(' ')) out.push(p.split(',').map(Number) as [number, number]);
    else if (Array.isArray(v) && v.length === 4 && v.every((n) => typeof n === 'number')) {
      const [x1, y1, x2, y2] = v as [number, number, number, number];
      out.push([x1, y1], [x2, y2]);
    }
    else if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x);
  };
  walk({ plinth: m.plinth, lobby: m.lobby, floors: m.floors, roof: m.roof });
  return out;
}

function floorWith(n: number, overrides: Partial<FloorSummary> = {}): FloorSummary {
  const f = makeScene().floors[0]!;
  return { ...f, windows: Array.from({ length: n }, (_, i) => ({ sessionId: `s${i}`, state: 'working' as const })), ...overrides };
}

describe('façade geometry', () => {
  it('projects the grid isometrically, height going up the page', () => {
    expect(project(0, 0)).toEqual([0, 0]);
    expect(project(1, 0)).toEqual([32, 16]);
    expect(project(0, 1)).toEqual([-32, 16]);
    expect(project(0, 0, 10)).toEqual([0, -10]);
  });

  it('writes points to a tenth of a pixel', () => {
    expect(points([[1.234, -5.678], [0, 0.05]])).toBe('1.2,-5.7 0,0.1');
  });

  it('draws a box as its top and two front faces', () => {
    expect(box(0, 0, 1, 1, 0, 10)).toEqual({
      top: '0,-10 32,6 0,22 -32,6',
      left: '-32,6 0,22 0,32 -32,16',
      right: '32,6 0,22 0,32 32,16',
    });
  });

  it('stacks the floors bottom-up on the lobby: the scene lists them top-down', () => {
    const scene = makeScene();
    const m = facadeOf(scene.floors);
    expect(m.floors.map((f) => f.number)).toEqual([1, 2, 3, 4]);
    expect(m.floors.map((f) => f.key)).toEqual([...scene.floors].reverse().map((f) => f.key));
    const nameY = m.floors.map((f) => f.label.nameAt[1]);
    for (let j = 1; j < nameY.length; j++) expect(nameY[j]! - nameY[j - 1]!).toBeCloseTo(-FLOOR_H, 5);
    expect(m.lobby.label.circle[1]).toBeGreaterThan(m.floors[0]!.label.circle[1]);
  });

  it('gives each desk of a floor\'s plan a window, in desk order, dark where it is free, and fills the row with blanks', () => {
    const m = facadeOf(makeScene().floors);
    expect(m.width).toBe(16);
    const checkout = m.floors[3]!;
    const free = (n: number) => Array<string>(n).fill('null:null:false');
    expect(checkout.windows.map((w) => `${w.sessionId}:${w.state}:${w.lit}`)).toEqual([
      'oa-c3:needs_you:true',
      ...free(3),
      'ps-d4:in_meeting:true',
      ...free(3),
      'sw-a1:working:true',
      'sw-b2:done:true',
      ...free(6),
    ]);
    expect(checkout.blanks).toHaveLength(0);
    const orders = m.floors[1]!;
    expect(orders.windows.map((w) => w.lit)).toEqual([true, true, true, false, true, false, false, false]);
    expect(orders.blanks).toHaveLength(8);
    const xs = checkout.windows.map((w) => Number(w.points.split(' ')[0]!.split(',')[0]));
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
  });

  it('is as wide as the busiest floor, and never narrower than six windows', () => {
    expect(facadeOf([floorWith(9)]).width).toBe(9);
    expect(facadeOf([floorWith(2)]).width).toBe(6);
    expect(facadeOf([]).width).toBe(6);
  });

  it('lowers the shutters with three slats per window on a dormant floor only', () => {
    const m = facadeOf(makeScene().floors);
    expect(m.floors.map((f) => f.shutters)).toEqual([true, false, false, false]);
    expect(m.floors[0]!.slats).toHaveLength(16 * 3);
    expect(m.floors[1]!.slats).toHaveLength(0);
  });

  it('frames the whole model and the label column in the viewBox', () => {
    for (const floors of [makeScene().floors, [floorWith(12)], []]) {
      const m = facadeOf(floors);
      const [x, y, w, h] = m.viewBox.split(' ').map(Number) as [number, number, number, number];
      for (const [px, py] of everyPoint(m)) {
        expect(px).toBeGreaterThanOrEqual(x);
        expect(px).toBeLessThanOrEqual(x + w);
        expect(py).toBeGreaterThanOrEqual(y);
        expect(py).toBeLessThanOrEqual(y + h);
      }
      expect(x + w).toBeGreaterThanOrEqual((m.width * TW) / 2 + 40 + LABEL_W);
    }
  });

  it('keeps an empty building to its lobby and roof', () => {
    const m = facadeOf([]);
    expect(m.floors).toEqual([]);
    expect(m.lobby.doors).toHaveLength(2);
    expect(m.lobby.windows).toHaveLength(4);
    expect(m.roof.units).toHaveLength(2);
    expect(m.roof.slab.top).toBe(box(-0.12, -0.12, 6.12, 3.12, LOBBY_H, LOBBY_H + 6).top);
  });
});

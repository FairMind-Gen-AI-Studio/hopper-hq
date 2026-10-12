import { describe, expect, it } from 'vitest';
import { Box3, BoxGeometry, Group, Mesh, Vector3, type BufferGeometry, type Object3D } from 'three';
import { Materials } from '../../renderer/materials';
import { Geometries, buildDesk, buildShell, updateDesk, windowSpots, type PickData } from '../../renderer/props';
import { dayTheme } from '../../renderer/theme';
import { WALL_H, deskAnchor } from '../../renderer/world';
import { checkoutFloor, desksOf } from './fixtures';

function kit() {
  return { geo: new Geometries(), mats: new Materials(dayTheme()) };
}

function meshes(root: Object3D): Mesh[] {
  const out: Mesh[] = [];
  root.traverse((o) => {
    if (o instanceof Mesh) out.push(o);
  });
  return out;
}

describe('shared geometries', () => {
  it('makes each size once and frees them together', () => {
    const geo = new Geometries();
    expect(geo.box(1, 2, 3)).toBe(geo.box(1, 2, 3));
    expect(geo.box(1, 2, 3)).not.toBe(geo.box(3, 2, 1));
    expect(geo.rbox(1, 1, 1, 0.1)).toBe(geo.rbox(1, 1, 1, 0.1));
    const made = geo.shared('custom', () => new BoxGeometry(1, 1, 1));
    expect(geo.shared('custom', () => new BoxGeometry(2, 2, 2))).toBe(made);
    expect(geo.size).toBe(4);
    let freed = 0;
    geo.box(1, 2, 3).addEventListener('dispose', () => freed++);
    geo.dispose();
    expect(freed).toBe(1);
    expect(geo.size).toBe(0);
  });
});

describe('the shell', () => {
  it('lays the slab under the whole floor', () => {
    const { geo, mats } = kit();
    const shell = buildShell(checkoutFloor(), geo, mats);
    const slab = meshes(shell.group).find((m) => m.material === mats.surface.floor)!;
    const box = new Box3().setFromObject(slab);
    expect(box.min.x).toBeCloseTo(0, 6);
    expect(box.min.z).toBeCloseTo(0, 6);
    expect(box.max.x).toBeCloseTo(28, 6);
    expect(box.max.z).toBeCloseTo(12, 6);
    expect(box.max.y).toBeCloseTo(0, 6);
  });

  it('raises four walls along the edges, each tagged by its side, with windows on the inside', () => {
    const { geo, mats } = kit();
    const shell = buildShell(checkoutFloor(), geo, mats);
    expect(shell.walls.map((w) => w.side)).toEqual(['north', 'east', 'south', 'west']);
    const wallOf = (g: Object3D) => meshes(g).find((m) => m.material === mats.surface.wall)!;
    const bounds = Object.fromEntries(shell.walls.map((w) => [w.side, new Box3().setFromObject(wallOf(w.group))]));
    expect(bounds.north!.max.z).toBeCloseTo(0, 6);
    expect(bounds.south!.min.z).toBeCloseTo(12, 6);
    expect(bounds.west!.max.x).toBeCloseTo(0, 6);
    expect(bounds.east!.min.x).toBeCloseTo(28, 6);
    for (const box of Object.values(bounds)) expect(box.max.y).toBeCloseTo(WALL_H, 6);
    const windows = Object.fromEntries(
      shell.walls.map((w) => [w.side, meshes(w.group).filter((m) => m.material === mats.surface.window).length]),
    );
    // One window every 5 m; the north wall leaves room for the elevator.
    expect(windows).toEqual({ north: 4, east: 2, south: 5, west: 2 });
  });

  it('spaces windows evenly and skips the ones that would overlap', () => {
    expect(windowSpots(28)).toEqual([2.8, 8.4, 14, 19.6, 25.2].map((x) => expect.closeTo(x, 10)));
    expect(windowSpots(12)).toEqual([3, 9]);
    expect(windowSpots(3)).toEqual([1.5]);
    expect(windowSpots(28, [2.6, 5.4])).toHaveLength(4);
  });

  it('puts the elevator on the north wall above the core, and plants inside the core', () => {
    const { geo, mats } = kit();
    const floor = checkoutFloor();
    const shell = buildShell(floor, geo, mats);
    const doors = meshes(shell.walls[0]!.group).filter((m) => m.material === mats.surface.elevator);
    expect(doors).toHaveLength(2);
    const coreX = floor.core.x + floor.core.w / 2;
    expect((doors[0]!.position.x + doors[1]!.position.x) / 2).toBeCloseTo(coreX, 6);
    const pots = meshes(shell.group).filter((m) => m.material === mats.surface.pot);
    expect(pots).toHaveLength(2);
    for (const pot of pots) {
      expect(pot.position.x).toBeGreaterThan(floor.core.x);
      expect(pot.position.x).toBeLessThan(floor.core.x + floor.core.w);
      expect(pot.position.z).toBeGreaterThan(floor.core.y);
      expect(pot.position.z).toBeLessThan(floor.core.y + floor.core.h);
    }
  });

  it('lays a rug in the repo colour under each island, with a lamp in the same colour above it', () => {
    const { geo, mats } = kit();
    const floor = checkoutFloor();
    const shell = buildShell(floor, geo, mats);
    for (const island of floor.islands) {
      const rug = shell.group.getObjectByName(`rug ${island.key}`) as Mesh;
      expect(rug.material).toBe(mats.rug(island.color));
      const box = new Box3().setFromObject(rug);
      expect(box.min.x).toBeGreaterThan(island.rect.x);
      expect(box.max.x).toBeLessThan(island.rect.x + island.rect.w);
      expect(box.min.z).toBeGreaterThan(island.rect.y);
      expect(box.max.z).toBeLessThan(island.rect.y + island.rect.h);
    }
    const shades = meshes(shell.group).filter((m) => m.material === mats.body(1) || m.material === mats.body(2));
    expect(shades).toHaveLength(3);
  });

  it('frees only the geometries sized to this floor when it is disposed', () => {
    const { geo, mats } = kit();
    const parent = new Group();
    const shell = buildShell(checkoutFloor(), geo, mats);
    parent.add(shell.group);
    const freed = new Set<BufferGeometry>();
    const all = new Set(meshes(shell.group).map((m) => m.geometry));
    for (const g of all) g.addEventListener('dispose', () => freed.add(g));
    const shared = geo.size;
    shell.dispose();
    expect(shell.group.parent).toBeNull();
    // The slab, four walls, four base strips and a rug per island; windows, fittings and lamps stay with the shared set.
    expect(freed.size).toBe(12);
    expect(geo.size).toBe(shared);
  });
});

describe('desks', () => {
  it('stands each desk at its cells and marks what a click picks', () => {
    const { geo, mats } = kit();
    const desk = desksOf(checkoutFloor()).find((d) => d.sessionId === 'oa-c3')!;
    const obj = buildDesk(desk, geo, mats);
    const a = deskAnchor(desk.rect);
    expect(obj.group.position.toArray()).toEqual([a.x, 0, a.z]);
    expect(obj.pickables).toHaveLength(5);
    for (const m of obj.pickables) expect(m.userData.pick as PickData).toEqual({ sessionId: 'oa-c3' });
    // The desk stays inside its 2x2 cells.
    const box = new Box3().setFromObject(obj.group);
    expect(box.min.x).toBeGreaterThanOrEqual(desk.rect.x);
    expect(box.max.x).toBeLessThanOrEqual(desk.rect.x + desk.rect.w);
    expect(box.min.z).toBeGreaterThanOrEqual(desk.rect.y);
    expect(box.max.z).toBeLessThanOrEqual(desk.rect.y + desk.rect.h);
    // The screen faces the chair, south.
    const normal = new Vector3(0, 0, 1).applyQuaternion(obj.screen.quaternion);
    expect(normal.z).toBeCloseTo(1, 6);
  });

  it('lights the screen by state, and turns it off and dims the desk when the session is dormant', () => {
    const { geo, mats } = kit();
    for (const desk of desksOf(checkoutFloor())) {
      const obj = buildDesk(desk, geo, mats);
      expect(obj.screen.material, desk.state).toBe(mats.screen(desk.state));
      expect(obj.top.material, desk.state).toBe(desk.state === 'dormant' ? mats.surface.deskOff : mats.surface.desk);
    }
    expect(mats.screen('idle').emissiveIntensity).toBe(0);
    expect(mats.screen('working').emissiveIntensity).toBeGreaterThan(0);
  });

  it('moves and relights a desk in place', () => {
    const { geo, mats } = kit();
    const desk = desksOf(checkoutFloor())[0]!;
    const obj = buildDesk(desk, geo, mats);
    const group = obj.group;
    updateDesk(obj, { ...desk, state: 'dormant', robot: null, rect: { x: 9, y: 11, w: 2, h: 2 } }, mats);
    expect(obj.group).toBe(group);
    expect(obj.group.position.toArray()).toEqual([10, 0, 11.6]);
    expect(obj.screen.material).toBe(mats.screen('dormant'));
    expect(obj.top.material).toBe(mats.surface.deskOff);
  });

  it('lets only the top, the monitor and the chair cast shadows', () => {
    const { geo, mats } = kit();
    const obj = buildDesk(desksOf(checkoutFloor())[0]!, geo, mats);
    const casters = meshes(obj.group).filter((m) => m.castShadow);
    expect(casters).toHaveLength(4);
    for (const m of casters) expect(obj.pickables.includes(m) && m !== obj.screen).toBe(true);
  });

  it('shares geometries between desks', () => {
    const { geo, mats } = kit();
    const [a, b] = desksOf(checkoutFloor());
    const before = (buildDesk(a!, geo, mats), geo.size);
    buildDesk(b!, geo, mats);
    expect(geo.size).toBe(before);
  });
});

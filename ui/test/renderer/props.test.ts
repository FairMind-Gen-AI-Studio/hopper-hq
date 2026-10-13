import { describe, expect, it } from 'vitest';
import { Box3, BoxGeometry, Group, Mesh, Vector3, type BufferGeometry, type Object3D } from 'three';
import { Materials } from '../../renderer/materials';
import { Geometries, buildDesk, buildRoom, buildShell, updateDesk, updateRoom, windowSpots, type PickData } from '../../renderer/props';
import { dayTheme } from '../../renderer/theme';
import { PARTITION_H, WALL_H, boardAnchor, deskAnchor, doorGap, headSpot, seatSpots, tableCenter } from '../../renderer/world';
import { checkoutFloor, desksOf, roomFloor } from './fixtures';

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

describe('meeting rooms', () => {
  /** The checkout floor's first room, ps-d4's, at the top of the wing; its host sits at the head. */
  function firstRoom() {
    const { geo, mats } = kit();
    const room = roomFloor().rooms[0]!;
    const obj = buildRoom(room, geo, mats);
    obj.group.updateMatrixWorld(true);
    return { geo, mats, room, obj };
  }
  const worldBox = (m: Object3D) => new Box3().setFromObject(m);
  const at = (m: Object3D) => m.getWorldPosition(new Vector3());

  it('stands the room at its north-west corner and keeps what is in it inside its cells', () => {
    const { room, obj } = firstRoom();
    expect(obj.group.position.toArray()).toEqual([room.rect.x, 0, room.rect.y]);
    expect([obj.runId, obj.w, obj.h]).toEqual([room.runId, room.rect.w, room.rect.h]);
    for (const m of meshes(obj.group)) {
      const box = worldBox(m);
      expect(box.min.x).toBeGreaterThanOrEqual(room.rect.x - 1e-6);
      expect(box.max.x).toBeLessThanOrEqual(room.rect.x + room.rect.w + 1e-6);
      expect(box.min.z).toBeGreaterThanOrEqual(room.rect.y - 1e-6);
      expect(box.max.z).toBeLessThanOrEqual(room.rect.y + room.rect.h + 1e-6);
    }
  });

  it('walls the room in glass on four sides, with the door in the middle of the west partition', () => {
    const { mats, room, obj } = firstRoom();
    const { x, y, w, h } = room.rect;
    const panes = meshes(obj.group).filter((m) => m.material === mats.surface.glass).map(worldBox);
    expect(panes).toHaveLength(5);
    for (const box of panes) expect([box.min.y, box.max.y]).toEqual([expect.closeTo(0, 6), expect.closeTo(PARTITION_H, 6)]);
    const along = (box: Box3) => (box.max.x - box.min.x > box.max.z - box.min.z ? 'x' : 'z');
    const north = panes.filter((b) => along(b) === 'x' && b.max.z < y + 0.5);
    const south = panes.filter((b) => along(b) === 'x' && b.min.z > y + h - 0.5);
    const east = panes.filter((b) => along(b) === 'z' && b.min.x > x + w - 0.5);
    const west = panes.filter((b) => along(b) === 'z' && b.max.x < x + 0.5);
    expect([north.length, south.length, east.length, west.length]).toEqual([1, 1, 1, 2]);
    // The two west panes leave the door open between them.
    const door = doorGap(room.rect);
    const [a, b] = west.sort((p, q) => p.min.z - q.min.z);
    expect(a!.max.z).toBeCloseTo(door.from, 6);
    expect(b!.min.z).toBeCloseTo(door.to, 6);
    expect(meshes(obj.group).filter((m) => m.material === mats.surface.glass).every((m) => !m.castShadow)).toBe(true);
  });

  it('lays a floor tinted for meetings, and puts the table in the middle with eight seats along it and the head seat at its west end', () => {
    const { mats, room, obj } = firstRoom();
    const floor = meshes(obj.group).filter((m) => m.material === mats.surface.roomFloor);
    expect(floor).toHaveLength(1);
    const table = meshes(obj.group).filter((m) => m.material === mats.surface.desk);
    expect(table).toHaveLength(1);
    const t = tableCenter(room.rect);
    expect([at(table[0]!).x, at(table[0]!).z]).toEqual([expect.closeTo(t.x, 9), expect.closeTo(t.z, 9)]);
    const seats = meshes(obj.group).filter((m) => m.material === mats.surface.chair).map((m) => ({ x: at(m).x, z: at(m).z }));
    const spots = [...seatSpots(room.rect), headSpot(room.rect)];
    expect(seats).toHaveLength(9);
    for (const spot of spots) expect(seats.some((p) => Math.hypot(p.x - spot.x, p.z - spot.z) < 1e-9)).toBe(true);
  });

  it('hangs the whiteboard inside the north partition, under the anchor of its overlay', () => {
    const { mats, room, obj } = firstRoom();
    const boards = meshes(obj.group).filter((m) => m.material === mats.surface.board);
    expect(boards).toHaveLength(1);
    const box = worldBox(boards[0]!);
    const a = boardAnchor(room.rect);
    expect(box.max.y).toBeCloseTo(a.y, 6);
    expect((box.min.x + box.max.x) / 2).toBeCloseTo(a.x, 6);
    expect(box.max.z).toBeLessThanOrEqual(a.z + 1e-6);
    expect(box.min.z).toBeGreaterThan(room.rect.y);
  });

  it('puts the placard on the head seat only while the host is not at the meeting', () => {
    const { mats, room, obj } = firstRoom();
    expect(room.host).not.toBeNull();
    expect(obj.placard.visible).toBe(false);
    expect(obj.placard.material).toBe(mats.surface.paper);
    const head = headSpot(room.rect);
    expect([at(obj.placard).x, at(obj.placard).z]).toEqual([expect.closeTo(head.x, 9), expect.closeTo(head.z, 9)]);
    updateRoom(obj, { ...room, host: null });
    expect(obj.placard.visible).toBe(true);
  });

  it('moves the room in place when its cells move', () => {
    const { room, obj } = firstRoom();
    const group = obj.group;
    updateRoom(obj, { ...room, rect: { ...room.rect, x: 30, y: 9 } });
    expect(obj.group).toBe(group);
    expect(obj.group.position.toArray()).toEqual([30, 0, 9]);
  });

  it('lets only the table top and the seats cast shadows', () => {
    const { mats, obj } = firstRoom();
    const casters = meshes(obj.group).filter((m) => m.castShadow);
    expect(casters).toHaveLength(10);
    for (const m of casters) expect([mats.surface.desk, mats.surface.chair]).toContain(m.material);
  });

  it('shares every geometry between rooms', () => {
    const { geo, mats } = kit();
    const [a, b] = roomFloor().rooms;
    buildRoom(a!, geo, mats);
    const size = geo.size;
    buildRoom(b!, geo, mats);
    expect(geo.size).toBe(size);
  });
});

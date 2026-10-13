import { describe, expect, it } from 'vitest';
import { Box3, BoxGeometry, Group, Mesh, Quaternion, Vector3, type BufferGeometry, type Material, type Object3D } from 'three';
import { Materials } from '../../renderer/materials';
import { Geometries, buildDesk, buildRoom, buildShell, updateDesk, updatePod, updateRoom, windowSpots, type PickData } from '../../renderer/props';
import { dayTheme } from '../../renderer/theme';
import { PARTITION_H, WALL_H, boardAnchor, deskAnchor, doorGap, headSpot, loungeSpots, seatSpots, tableCenter } from '../../renderer/world';
import { checkoutFloor, roomFloor, seatsOf } from './fixtures';

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
    const floor = checkoutFloor();
    const shell = buildShell(floor, geo, mats);
    const slab = meshes(shell.group).find((m) => m.material === mats.surface.floor)!;
    const box = new Box3().setFromObject(slab);
    expect(box.min.x).toBeCloseTo(0, 6);
    expect(box.min.z).toBeCloseTo(0, 6);
    expect(box.max.x).toBeCloseTo(floor.size.w, 6);
    expect(box.max.z).toBeCloseTo(floor.size.h, 6);
    expect(box.max.y).toBeCloseTo(0, 6);
  });

  it('raises four walls along the edges, each tagged by its side, with windows on the inside', () => {
    const { geo, mats } = kit();
    const floor = checkoutFloor();
    expect(floor.size).toEqual({ w: 28, h: 28 });
    const shell = buildShell(floor, geo, mats);
    expect(shell.walls.map((w) => w.side)).toEqual(['north', 'east', 'south', 'west']);
    const wallOf = (g: Object3D) => meshes(g).find((m) => m.material === mats.surface.wall)!;
    const bounds = Object.fromEntries(shell.walls.map((w) => [w.side, new Box3().setFromObject(wallOf(w.group))]));
    expect(bounds.north!.max.z).toBeCloseTo(0, 6);
    expect(bounds.south!.min.z).toBeCloseTo(28, 6);
    expect(bounds.west!.max.x).toBeCloseTo(0, 6);
    expect(bounds.east!.min.x).toBeCloseTo(28, 6);
    for (const box of Object.values(bounds)) expect(box.max.y).toBeCloseTo(WALL_H, 6);
    const windows = Object.fromEntries(
      shell.walls.map((w) => [w.side, meshes(w.group).filter((m) => m.material === mats.surface.window).length]),
    );
    // One window every 5 m; the north wall leaves room for the elevator.
    expect(windows).toEqual({ north: 4, east: 5, south: 5, west: 5 });
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

  it('lays a rug under each pod with a lamp over it, neutral until the floor colours them by the pod\'s repository', () => {
    const { geo, mats } = kit();
    const floor = checkoutFloor();
    const shell = buildShell(floor, geo, mats);
    expect([...shell.pods.keys()]).toEqual(floor.pods.map((p) => p.id));
    for (const pod of floor.pods) {
      const { rug, shade } = shell.pods.get(pod.id)!;
      expect([rug.name, rug.material, shade.material]).toEqual([`rug ${pod.id}`, mats.surface.rug, mats.surface.base]);
      const box = new Box3().setFromObject(rug);
      expect(box.min.x).toBeGreaterThan(pod.rect.x);
      expect(box.max.x).toBeLessThan(pod.rect.x + pod.rect.w);
      expect(box.min.z).toBeGreaterThan(pod.rect.y);
      expect(box.max.z).toBeLessThan(pod.rect.y + pod.rect.h);
      const lamp = new Box3().setFromObject(shade);
      expect((lamp.min.x + lamp.max.x) / 2).toBeCloseTo(pod.rect.x + pod.rect.w / 2, 6);
    }
    const p0 = shell.pods.get('p0')!;
    updatePod(p0, 2, mats);
    expect([p0.rug.material, p0.shade.material]).toEqual([mats.rug(2), mats.body(2)]);
    updatePod(p0, null, mats);
    expect([p0.rug.material, p0.shade.material]).toEqual([mats.surface.rug, mats.surface.base]);
  });

  it('stands every desk of every pod, free and dark until somebody sits at it', () => {
    const { geo, mats } = kit();
    const floor = checkoutFloor();
    const shell = buildShell(floor, geo, mats);
    const desks = floor.pods.flatMap((p) => p.desks);
    expect([...shell.desks.keys()]).toEqual(desks.map((d) => d.id));
    for (const desk of desks) {
      const obj = shell.desks.get(desk.id)!;
      expect(obj.group.parent).toBe(shell.group);
      expect([obj.screen.material, obj.pickables.some((m) => m.userData.pick)]).toEqual([mats.screen('idle'), false]);
    }
  });

  it('furnishes the lounge: a rug, two couches facing each other across a coffee table, and a beanbag at each end', () => {
    const { geo, mats } = kit();
    const floor = checkoutFloor();
    const shell = buildShell(floor, geo, mats);
    const lounge = shell.group.getObjectByName('lounge')!;
    const of = (m: Material) => meshes(lounge).filter((x) => x.material === m);
    // Each couch: a seat, a back and two arms.
    expect([of(mats.surface.couch).length, of(mats.surface.wood).length, of(mats.surface.beanA).length, of(mats.surface.beanB).length, of(mats.surface.loungeRug).length]).toEqual([8, 1, 1, 1, 1]);
    const rect = floor.lounge.rect;
    for (const m of meshes(lounge)) {
      const box = new Box3().setFromObject(m);
      expect(box.min.x).toBeGreaterThan(rect.x);
      expect(box.max.x).toBeLessThan(rect.x + rect.w);
      expect(box.min.z).toBeGreaterThan(rect.y);
      expect(box.max.z).toBeLessThan(rect.y + rect.h);
    }
    // Every lounge seat is over a couch's seat or a beanbag, and the backs stand away from the table.
    const seats = [...of(mats.surface.couch).filter((m) => m.position.y === 0.21), ...of(mats.surface.beanA), ...of(mats.surface.beanB)].map((m) => new Box3().setFromObject(m));
    for (const spot of loungeSpots(rect)) {
      expect(seats.some((b) => spot.x > b.min.x && spot.x < b.max.x && spot.z > b.min.z && spot.z < b.max.z), `${spot.x} ${spot.z}`).toBe(true);
    }
    const table = of(mats.surface.wood)[0]!.position;
    for (const back of of(mats.surface.couch).filter((m) => m.position.y === 0.6)) {
      const seat = of(mats.surface.couch).find((m) => m.position.y === 0.21 && Math.sign(m.position.z - table.z) === Math.sign(back.position.z - table.z))!;
      expect(Math.abs(back.position.z - table.z)).toBeGreaterThan(Math.abs(seat.position.z - table.z));
    }
  });

  it('builds a room in every slot of the plan, empty', () => {
    const { geo, mats } = kit();
    const floor = roomFloor();
    const shell = buildShell(floor, geo, mats);
    expect(shell.rooms.map((r) => [r.slot, r.group.parent, r.group.position.x, r.group.position.z])).toEqual(floor.roomSlots.map((rect, slot) => [slot, shell.group, rect.x, rect.y]));
    for (const r of shell.rooms) expect([r.floor.material, r.door.visible]).toEqual([mats.surface.roomDim, true]);
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
    // The slab, four walls and four base strips; rugs, desks, the lounge, rooms, windows, fittings and lamps stay with the shared set.
    expect(freed.size).toBe(9);
    expect(geo.size).toBe(shared);
  });
});

describe('desks', () => {
  const desksOf = () => checkoutFloor().pods.flatMap((p) => p.desks);

  it('stands each desk at its cells, its screen toward its chair, on either side of a pod', () => {
    const { geo, mats } = kit();
    for (const desk of desksOf().slice(0, 4)) {
      const obj = buildDesk(desk, geo, mats);
      const a = deskAnchor(desk);
      expect(obj.group.position.toArray()).toEqual([a.x, 0, a.z]);
      expect(obj.pickables).toHaveLength(5);
      obj.group.updateMatrixWorld(true);
      // The desk stays inside its 2x2 cells.
      const box = new Box3().setFromObject(obj.group);
      expect(box.min.x).toBeGreaterThanOrEqual(desk.rect.x);
      expect(box.max.x).toBeLessThanOrEqual(desk.rect.x + desk.rect.w);
      expect(box.min.z).toBeGreaterThanOrEqual(desk.rect.y - 1e-9);
      expect(box.max.z).toBeLessThanOrEqual(desk.rect.y + desk.rect.h + 1e-9);
      // The screen faces the chair: south in the south row, north in the north row.
      const normal = new Vector3(0, 0, 1).applyQuaternion(obj.screen.getWorldQuaternion(new Quaternion()));
      expect(normal.z, desk.id).toBeCloseTo(desk.chair === 'south' ? 1 : -1, 6);
    }
  });

  it('lights the screen by the state of whoever sits there, dims a dormant one, leaves a free one dark, and picks the occupant only', () => {
    const { geo, mats } = kit();
    const floor = checkoutFloor();
    for (const desk of desksOf()) {
      const obj = buildDesk(desk, geo, mats);
      updateDesk(obj, desk.occupant, mats);
      const state = desk.occupant?.state;
      expect(obj.screen.material, desk.id).toBe(mats.screen(state ?? 'idle'));
      expect(obj.top.material, desk.id).toBe(state === 'dormant' ? mats.surface.deskOff : mats.surface.desk);
      for (const m of obj.pickables) expect(m.userData.pick ?? null, desk.id).toEqual(desk.occupant ? ({ kind: 'desk', id: desk.occupant.sessionId } satisfies PickData) : null);
    }
    const { desk, occupant } = seatsOf(floor)[0]!;
    const obj = buildDesk(desk, geo, mats);
    updateDesk(obj, occupant, mats);
    updateDesk(obj, null, mats);
    expect([obj.screen.material, obj.top.material, obj.pickables.some((m) => m.userData.pick)]).toEqual([mats.screen('idle'), mats.surface.desk, false]);
    expect(mats.screen('idle').emissiveIntensity).toBe(0);
    expect(mats.screen('working').emissiveIntensity).toBeGreaterThan(0);
  });

  it('lets only the top, the monitor and the chair cast shadows', () => {
    const { geo, mats } = kit();
    const obj = buildDesk(desksOf()[0]!, geo, mats);
    const casters = meshes(obj.group).filter((m) => m.castShadow);
    expect(casters).toHaveLength(4);
    for (const m of casters) expect(obj.pickables.includes(m) && m !== obj.screen).toBe(true);
  });

  it('shares geometries between desks', () => {
    const { geo, mats } = kit();
    const [a, b] = desksOf();
    const before = (buildDesk(a!, geo, mats), geo.size);
    buildDesk(b!, geo, mats);
    expect(geo.size).toBe(before);
  });
});

describe('meeting rooms', () => {
  /** The checkout floor's first room, ps-d4's, in the first slot; its host sits at the head. */
  function firstRoom() {
    const { geo, mats } = kit();
    const room = roomFloor().rooms[0]!;
    const obj = buildRoom(room.rect, room.slot, geo, mats);
    obj.group.updateMatrixWorld(true);
    return { geo, mats, room, obj };
  }
  const worldBox = (m: Object3D) => new Box3().setFromObject(m);
  const at = (m: Object3D) => m.getWorldPosition(new Vector3());

  it('stands the room at its north-west corner and keeps what is in it inside its cells', () => {
    const { room, obj } = firstRoom();
    expect(obj.group.position.toArray()).toEqual([room.rect.x, 0, room.rect.y]);
    expect([obj.slot, obj.group.name]).toEqual([0, 'room 0']);
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
    // The two west panes leave the door between them, where the door panel closes it.
    const door = doorGap(room.rect);
    const [a, b] = west.sort((p, q) => p.min.z - q.min.z);
    expect(a!.max.z).toBeCloseTo(door.from, 6);
    expect(b!.min.z).toBeCloseTo(door.to, 6);
    const panel = worldBox(obj.door);
    expect([panel.min.z > door.from, panel.max.z < door.to, panel.max.x < x + 0.5]).toEqual([true, true, true]);
    expect(meshes(obj.group).filter((m) => m.material === mats.surface.glass).every((m) => !m.castShadow)).toBe(true);
  });

  it('lays a floor, and puts the table in the middle with eight seats along it and the head seat at its west end', () => {
    const { mats, room, obj } = firstRoom();
    expect(obj.floor.material).toBe(mats.surface.roomDim);
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

  it('opens for a run, with its floor tinted for meetings, its door open and the placard on the head seat while the host is away, and closes again', () => {
    const { mats, room, obj } = firstRoom();
    expect([obj.floor.material, obj.door.visible, obj.placard.visible]).toEqual([mats.surface.roomDim, true, false]);
    expect(obj.pickables.some((m) => m.userData.pick)).toBe(false);
    updateRoom(obj, room, true, mats);
    expect([obj.floor.material, obj.door.visible, obj.placard.visible]).toEqual([mats.surface.roomFloor, false, false]);
    for (const m of obj.pickables) expect(m.userData.pick as PickData).toEqual({ kind: 'room', id: room.runId });
    updateRoom(obj, room, false, mats);
    expect(obj.placard.visible).toBe(true);
    expect(obj.placard.material).toBe(mats.surface.paper);
    const head = headSpot(room.rect);
    expect([at(obj.placard).x, at(obj.placard).z]).toEqual([expect.closeTo(head.x, 9), expect.closeTo(head.z, 9)]);
    updateRoom(obj, null, false, mats);
    expect([obj.floor.material, obj.door.visible, obj.placard.visible, obj.pickables.some((m) => m.userData.pick)]).toEqual([mats.surface.roomDim, true, false, false]);
    // Glass and the door are never picked.
    const skipped = meshes(obj.group).filter((m) => !obj.pickables.includes(m));
    expect(skipped.every((m) => m.material === mats.surface.glass || m === obj.door)).toBe(true);
    expect(skipped).toHaveLength(6);
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
    buildRoom(a!.rect, a!.slot, geo, mats);
    const size = geo.size;
    buildRoom(b!.rect, b!.slot, geo, mats);
    expect(geo.size).toBe(size);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Box3, BoxGeometry, CanvasTexture, Color, Group, InstancedMesh, Matrix4, Mesh, MeshStandardMaterial, SRGBColorSpace, Vector3, type BufferGeometry, type Material, type Object3D } from 'three';
import { POD_DESKS } from '../../../src/scene/layout';
import type { PodDesk } from '../../../src/scene/types';
import { Furniture, type Piece } from '../../renderer/furniture';
import { DESK_OFF, Materials, SCREEN_GLASS } from '../../renderer/materials';
import {
  DOOR_PANEL,
  DOOR_SLIDE,
  Geometries,
  NAMEPLATE,
  NAMEPLATE_CHARS,
  NAMEPLATE_PX,
  buildDesk,
  buildNameplate,
  buildRoom,
  buildShell,
  drawNameplate,
  nameplateText,
  setDoors,
  updateDesk,
  updatePod,
  updateRoom,
  windowSpots,
  type PickData,
} from '../../renderer/props';
import { dayTheme } from '../../renderer/theme';
import {
  BEANBAG_R,
  BEANBAG_SCALE,
  CHAIR_Z,
  COUCH,
  COUCH_ARM,
  COUCH_BACK,
  DESK_CHAIR,
  DESK_TOP,
  PARTITION_H,
  ROOM_SEAT,
  WALL_H,
  boardAnchor,
  deskAnchor,
  doorGap,
  headSpot,
  loungeSpots,
  plantSpots,
  seatSpots,
  tableCenter,
} from '../../renderer/world';
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

/** Where an instance of an instanced mesh stands in the world. */
function instanceMatrix(mesh: InstancedMesh, index: number): Matrix4 {
  mesh.updateWorldMatrix(true, false);
  return new Matrix4().multiplyMatrices(mesh.matrixWorld, mesh.getMatrixAt(index, new Matrix4()));
}

/** The box in the world of an instance of an instanced mesh. */
function instanceBox(mesh: InstancedMesh, index: number): Box3 {
  if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
  return mesh.geometry.boundingBox!.clone().applyMatrix4(instanceMatrix(mesh, index));
}

/** The box in the world of every piece drawn under `root` in `material`: a mesh, or an instance of an instanced mesh. */
function drawn(root: Object3D, material: Material): Box3[] {
  root.updateMatrixWorld(true);
  return meshes(root)
    .filter((m) => m.material === material)
    .flatMap((m) => (m instanceof InstancedMesh ? Array.from({ length: m.count }, (_, i) => instanceBox(m, i)) : [new Box3().setFromObject(m)]));
}

/** A colour's channels, to the millionth: instanced meshes keep colours in 32-bit floats. */
const rgb = (c: Color) => c.toArray().map((v) => Math.round(v * 1e6) / 1e6);
/** The colour a piece is given over its material. */
const paintOf = (piece: Piece) => rgb(piece.mesh!.getColorAt(piece.index, new Color()));

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
    const pots = drawn(shell.group, mats.surface.pot).map((b) => b.getCenter(new Vector3()));
    expect(pots).toHaveLength(2);
    for (const pot of pots) {
      expect(pot.x).toBeGreaterThan(floor.core.x);
      expect(pot.x).toBeLessThan(floor.core.x + floor.core.w);
      expect(pot.z).toBeGreaterThan(floor.core.y);
      expect(pot.z).toBeLessThan(floor.core.y + floor.core.h);
    }
  });

  it('slides the elevator doors aside to open them and back to shut them, and lets neither cast a shadow', () => {
    const { geo, mats } = kit();
    const floor = checkoutFloor();
    const shell = buildShell(floor, geo, mats);
    const doors = meshes(shell.walls[0]!.group).filter((m) => m.material === mats.surface.elevator);
    expect(shell.doors).toEqual(doors);
    expect(doors.map((d) => d.castShadow)).toEqual([false, false]);
    const coreX = floor.core.x + floor.core.w / 2;
    /** Each door's centre from the core's middle, to the nanometre. */
    const xs = () => shell.doors.map((d) => Math.round((d.position.x - coreX) * 1e9) / 1e9);
    const at = (open: number) => {
      setDoors(shell.doors, floor.core, open);
      return xs();
    };
    expect(xs()).toEqual([-DOOR_PANEL / 2, DOOR_PANEL / 2]);
    expect(at(1)).toEqual([-(DOOR_PANEL / 2 + DOOR_SLIDE), DOOR_PANEL / 2 + DOOR_SLIDE]);
    expect(at(0.5)).toEqual([-(DOOR_PANEL / 2 + DOOR_SLIDE / 2), DOOR_PANEL / 2 + DOOR_SLIDE / 2]);
    expect(at(0)).toEqual([-DOOR_PANEL / 2, DOOR_PANEL / 2]);
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
      expect([obj.top.mesh!.parent, obj.screen.mesh!.parent]).toEqual([shell.group, shell.group]);
      expect([paintOf(obj.screen), obj.pickables.some((p) => p.pick)]).toEqual([rgb(mats.screenColor('idle')), false]);
    }
  });

  it('draws the furniture with instanced meshes, one per geometry and material, each piece an instance of one', () => {
    const { geo, mats } = kit();
    const floor = checkoutFloor();
    const shell = buildShell(floor, geo, mats);
    const n = floor.pods.length * POD_DESKS;
    const r = floor.roomSlots.length;
    expect(shell.furniture.meshes.map((m) => m.count)).toEqual([
      // The plants: their pots and three sizes of leaves.
      ...[2, 2, 2, 2],
      // The desks: top, four legs, monitor stand and neck, monitor, screen, keyboard, seat, back, post (a room seat's
      // too) and base.
      ...[n, 4 * n, n, n, n, n, n, n, n, n + 9 * r, n],
      // The lounge: the couches' seats, backs and arms, the coffee table's top, legs and cup, and the two beanbags.
      ...[2, 2, 4, 1, 2, 1, 1, 1],
      // The rooms: each table, its two pedestals, and its nine seats.
      ...[r, 2 * r, 9 * r],
    ]);
    expect(shell.furniture.meshes.every((m) => m.parent === shell.group)).toBe(true);
    expect(shell.group.getObjectByName(`desk ${floor.pods[0]!.desks[0]!.id}`)).toBeUndefined();
  });

  it('furnishes the lounge: a rug, two couches facing each other across a coffee table, and a beanbag at each end', () => {
    const { geo, mats } = kit();
    const floor = checkoutFloor();
    const shell = buildShell(floor, geo, mats);
    const s = mats.surface;
    const of = (m: Material) => drawn(shell.group, m);
    const centre = (b: Box3) => b.getCenter(new Vector3());
    // Each couch: a seat, a back and two arms.
    expect([of(s.couch).length, of(s.wood).length, of(s.beanA).length, of(s.beanB).length, of(s.loungeRug).length]).toEqual([8, 1, 1, 1, 1]);
    const rect = floor.lounge.rect;
    for (const box of [s.couch, s.wood, s.beanA, s.beanB, s.loungeRug].flatMap(of)) {
      expect(box.min.x).toBeGreaterThan(rect.x);
      expect(box.max.x).toBeLessThan(rect.x + rect.w);
      expect(box.min.z).toBeGreaterThan(rect.y);
      expect(box.max.z).toBeLessThan(rect.y + rect.h);
    }
    // Every lounge seat is over a couch's seat or a beanbag, and the backs stand away from the table.
    const at = (y: number) => of(s.couch).filter((b) => Math.abs(centre(b).y - y) < 1e-5);
    const seats = [...at(0.21), ...of(s.beanA), ...of(s.beanB)];
    for (const spot of loungeSpots(rect)) {
      expect(seats.some((b) => spot.x > b.min.x && spot.x < b.max.x && spot.z > b.min.z && spot.z < b.max.z), `${spot.x} ${spot.z}`).toBe(true);
    }
    const table = centre(of(s.wood)[0]!);
    for (const back of at(0.6).map(centre)) {
      const seat = at(0.21).map(centre).find((c) => Math.sign(c.z - table.z) === Math.sign(back.z - table.z))!;
      expect(Math.abs(back.z - table.z)).toBeGreaterThan(Math.abs(seat.z - table.z));
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
    const instanced = new Set<InstancedMesh>();
    for (const m of shell.furniture.meshes) m.addEventListener('dispose', () => instanced.add(m));
    const shared = geo.size;
    shell.dispose();
    expect(shell.group.parent).toBeNull();
    // The slab, four walls and four base strips; rugs, desks, the lounge, rooms, windows, fittings and lamps stay with the shared set.
    expect(freed.size).toBe(9);
    expect(geo.size).toBe(shared);
    // The instanced meshes give back what they hold on the GPU.
    expect(instanced.size).toBe(shell.furniture.meshes.length);
  });
});

describe('desks', () => {
  const desksOf = () => checkoutFloor().pods.flatMap((p) => p.desks);
  /** A desk built as the only furniture there is, and drawn. */
  function alone(desk: PodDesk) {
    const { geo, mats } = kit();
    const furniture = new Furniture();
    const obj = buildDesk(desk, furniture, geo, mats);
    furniture.build(new Group());
    return { mats, furniture, obj };
  }

  it('stands each desk at its cells, its screen toward its chair, on either side of a pod', () => {
    for (const desk of desksOf().slice(0, 4)) {
      const { furniture, obj } = alone(desk);
      const a = deskAnchor(desk);
      const top = new Vector3().setFromMatrixPosition(instanceMatrix(obj.top.mesh!, obj.top.index));
      expect([top.x, top.z]).toEqual([expect.closeTo(a.x, 6), expect.closeTo(a.z, 6)]);
      expect(obj.pickables).toHaveLength(5);
      // The desk stays inside its 2x2 cells.
      const box = furniture.meshes.flatMap((m) => Array.from({ length: m.count }, (_, i) => instanceBox(m, i))).reduce((u, b) => u.clone().union(b));
      expect(box.min.x).toBeGreaterThanOrEqual(desk.rect.x - 1e-6);
      expect(box.max.x).toBeLessThanOrEqual(desk.rect.x + desk.rect.w + 1e-6);
      expect(box.min.z).toBeGreaterThanOrEqual(desk.rect.y - 1e-6);
      expect(box.max.z).toBeLessThanOrEqual(desk.rect.y + desk.rect.h + 1e-6);
      // The screen faces the chair: south in the south row, north in the north row.
      const normal = new Vector3(0, 0, 1).transformDirection(instanceMatrix(obj.screen.mesh!, obj.screen.index));
      expect(normal.z, desk.id).toBeCloseTo(desk.chair === 'south' ? 1 : -1, 6);
    }
  });

  it('lights the screen by the state of whoever sits there, dims a dormant one, leaves a free one dark, and picks the occupant only', () => {
    const { geo, mats } = kit();
    const floor = checkoutFloor();
    const furniture = new Furniture();
    const desks = desksOf().map((desk) => ({ desk, obj: buildDesk(desk, furniture, geo, mats) }));
    furniture.build(new Group());
    for (const { desk, obj } of desks) {
      updateDesk(obj, desk.occupant, mats);
      const state = desk.occupant?.state;
      expect(paintOf(obj.screen), desk.id).toEqual(rgb(mats.screenColor(state ?? 'idle')));
      // A dormant session's desk top: the desk's colour times DESK_OFF.
      expect(paintOf(obj.top), desk.id).toEqual(state === 'dormant' ? [DESK_OFF, DESK_OFF, DESK_OFF] : [1, 1, 1]);
      for (const p of obj.pickables) expect(p.pick ?? null, desk.id).toEqual(desk.occupant ? ({ kind: 'desk', id: desk.occupant.sessionId } satisfies PickData) : null);
    }
    const { desk, occupant } = seatsOf(floor)[0]!;
    const obj = desks.find((d) => d.desk.id === desk.id)!.obj;
    updateDesk(obj, occupant, mats);
    updateDesk(obj, null, mats);
    expect([paintOf(obj.screen), paintOf(obj.top), obj.pickables.some((p) => p.pick)]).toEqual([rgb(new Color(SCREEN_GLASS)), [1, 1, 1], false]);
    expect(DESK_OFF).toBe(0.55);
  });

  it('lets only the top, the monitor and the chair cast shadows', () => {
    const { furniture, obj } = alone(desksOf()[0]!);
    const casters = furniture.meshes.filter((m) => m.castShadow);
    expect(casters.map((m) => m.count)).toEqual([1, 1, 1, 1]);
    const casting = obj.pickables.filter((p) => p.mesh!.castShadow);
    expect([casting.length, casting.includes(obj.screen)]).toEqual([4, false]);
    expect(new Set(casting.map((p) => p.mesh))).toEqual(new Set(casters));
  });

  it('shares geometries between desks, and the instanced meshes that draw them', () => {
    const { geo, mats } = kit();
    const [a, b] = desksOf();
    const furniture = new Furniture();
    const before = (buildDesk(a!, furniture, geo, mats), geo.size);
    buildDesk(b!, furniture, geo, mats);
    expect(geo.size).toBe(before);
    furniture.build(new Group());
    expect(furniture.meshes.map((m) => m.count)).toEqual([2, 8, 2, 2, 2, 2, 2, 2, 2, 2, 2]);
  });
});

describe('meeting rooms', () => {
  /** The checkout floor's first room, ps-d4's, in the first slot, as the only furniture there is; its host sits at the head. */
  function firstRoom() {
    const { geo, mats } = kit();
    const room = roomFloor().rooms[0]!;
    const furniture = new Furniture();
    const obj = buildRoom(room.rect, room.slot, furniture, geo, mats);
    const floor = new Group();
    floor.add(obj.group);
    furniture.build(floor);
    floor.updateMatrixWorld(true);
    return { geo, mats, room, obj };
  }
  const worldBox = (m: Object3D) => new Box3().setFromObject(m);
  const at = (m: Object3D) => m.getWorldPosition(new Vector3());
  const pieceBox = (p: Piece) => instanceBox(p.mesh!, p.index);
  const pieceAt = (p: Piece) => new Vector3().setFromMatrixPosition(instanceMatrix(p.mesh!, p.index));

  it('stands the room at its north-west corner and keeps what is in it inside its cells', () => {
    const { room, obj } = firstRoom();
    expect(obj.group.position.toArray()).toEqual([room.rect.x, 0, room.rect.y]);
    expect([obj.slot, obj.group.name]).toEqual([0, 'room 0']);
    for (const box of [...meshes(obj.group).map(worldBox), ...obj.pieces.map(pieceBox)]) {
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
    // The table and the seats are pieces of the floor's furniture.
    const table = obj.pieces.filter((p) => p.mesh!.material === mats.surface.desk).map(pieceAt);
    expect(table).toHaveLength(1);
    const t = tableCenter(room.rect);
    expect([table[0]!.x, table[0]!.z]).toEqual([expect.closeTo(t.x, 6), expect.closeTo(t.z, 6)]);
    const seats = obj.pieces.filter((p) => p.mesh!.material === mats.surface.chair).map(pieceAt);
    const spots = [...seatSpots(room.rect), headSpot(room.rect)];
    expect(seats).toHaveLength(9);
    for (const spot of spots) expect(seats.some((p) => Math.hypot(p.x - spot.x, p.z - spot.z) < 1e-6)).toBe(true);
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
    expect([obj.pickables.some((m) => m.userData.pick), obj.pieces.some((p) => p.pick)]).toEqual([false, false]);
    updateRoom(obj, room, true, mats);
    expect([obj.floor.material, obj.door.visible, obj.placard.visible]).toEqual([mats.surface.roomFloor, false, false]);
    for (const m of obj.pickables) expect(m.userData.pick as PickData).toEqual({ kind: 'room', id: room.runId });
    for (const p of obj.pieces) expect(p.pick).toEqual({ kind: 'room', id: room.runId });
    updateRoom(obj, room, false, mats);
    expect(obj.placard.visible).toBe(true);
    expect(obj.placard.material).toBe(mats.surface.paper);
    const head = headSpot(room.rect);
    expect([at(obj.placard).x, at(obj.placard).z]).toEqual([expect.closeTo(head.x, 9), expect.closeTo(head.z, 9)]);
    updateRoom(obj, null, false, mats);
    expect([obj.floor.material, obj.door.visible, obj.placard.visible, obj.pickables.some((m) => m.userData.pick), obj.pieces.some((p) => p.pick)]).toEqual([
      mats.surface.roomDim,
      true,
      false,
      false,
      false,
    ]);
    // Glass and the door are never picked.
    const skipped = meshes(obj.group).filter((m) => !obj.pickables.includes(m));
    expect(skipped.every((m) => m.material === mats.surface.glass || m === obj.door)).toBe(true);
    expect(skipped).toHaveLength(6);
  });

  it('lets only the table top and the seats cast shadows', () => {
    const { mats, obj } = firstRoom();
    expect(meshes(obj.group).filter((m) => m.castShadow)).toEqual([]);
    const casters = obj.pieces.filter((p) => p.mesh!.castShadow);
    expect(casters).toHaveLength(10);
    for (const p of casters) expect([mats.surface.desk, mats.surface.chair]).toContain(p.mesh!.material);
  });

  it('shares every geometry between rooms, and the instanced meshes that draw their tables and seats', () => {
    const { geo, mats } = kit();
    const [a, b] = roomFloor().rooms;
    const furniture = new Furniture();
    buildRoom(a!.rect, a!.slot, furniture, geo, mats);
    const size = geo.size;
    buildRoom(b!.rect, b!.slot, furniture, geo, mats);
    expect(geo.size).toBe(size);
    // The tables, their pedestals, the seats and the seats' posts.
    furniture.build(new Group());
    expect(furniture.meshes.map((m) => m.count)).toEqual([2, 4, 18, 18]);
  });
});

describe('the sizes the walk grid shares', () => {
  const span = (b: Box3) => b.getSize(new Vector3());
  // Geometries keep their vertices in 32-bit floats: sizes are exact to a few millionths of a metre.
  const near = (v: number) => expect.closeTo(v, 5);
  const within = (b: Box3, r: { x: number; y: number; w: number; h: number }) => b.min.x > r.x && b.max.x < r.x + r.w && b.min.z > r.y && b.max.z < r.y + r.h;

  it('draws every desk top, desk chair and room seat at the size world.ts gives the walk grid', () => {
    const { geo, mats } = kit();
    const floor = roomFloor();
    const shell = buildShell(floor, geo, mats);
    const tops = drawn(shell.group, mats.surface.desk);
    const chairs = drawn(shell.group, mats.surface.chair);
    for (const desk of floor.pods.flatMap((p) => p.desks)) {
      const a = deskAnchor(desk);
      const top = tops.find((b) => Math.abs(b.getCenter(new Vector3()).x - a.x) < 1e-5 && Math.abs(b.getCenter(new Vector3()).z - a.z) < 1e-5)!;
      expect([span(top).x, span(top).z], desk.id).toEqual([near(DESK_TOP.w), near(DESK_TOP.d)]);
      // Its chair, seat and back, from the desk top's centre toward the chair.
      const chair = chairs.filter((b) => within(b, desk.rect)).reduce((u, b) => u.clone().union(b));
      const toward = desk.chair === 'south' ? [chair.min.z - a.z, chair.max.z - a.z] : [a.z - chair.max.z, a.z - chair.min.z];
      expect([span(chair).x, ...toward], desk.id).toEqual([near(DESK_CHAIR.w), near(CHAIR_Z - DESK_CHAIR.seat / 2), near(DESK_CHAIR.backZ + DESK_CHAIR.back / 2)]);
    }
    for (const rect of floor.roomSlots) {
      const seats = chairs.filter((b) => within(b, rect));
      expect(seats).toHaveLength(9);
      for (const seat of seats) expect([span(seat).x, span(seat).z]).toEqual([near(ROOM_SEAT), near(ROOM_SEAT)]);
    }
  });

  it('draws the couches, the beanbags and the plants at the sizes and spots world.ts gives the walk grid', () => {
    const { geo, mats } = kit();
    const floor = checkoutFloor();
    const shell = buildShell(floor, geo, mats);
    const couch = drawn(shell.group, mats.surface.couch);
    // Two backs COUCH_BACK deep, four arms COUCH_ARM wide, and each couch COUCH.w + COUCH_ARM wide with its arms.
    expect(couch.filter((b) => Math.abs(span(b).z - COUCH_BACK) < 1e-5)).toHaveLength(2);
    expect(couch.filter((b) => Math.abs(span(b).x - COUCH_ARM) < 1e-5)).toHaveLength(4);
    expect(span(couch.reduce((u, b) => u.clone().union(b))).x).toBeCloseTo(COUCH.w + COUCH_ARM, 5);
    const beans = [...drawn(shell.group, mats.surface.beanA), ...drawn(shell.group, mats.surface.beanB)];
    const bean = [2 * BEANBAG_R * BEANBAG_SCALE.across, 2 * BEANBAG_R * BEANBAG_SCALE.up, 2 * BEANBAG_R * BEANBAG_SCALE.across];
    expect(beans.map((b) => span(b).toArray())).toEqual([bean.map(near), bean.map(near)]);
    const pots = drawn(shell.group, mats.surface.pot).map((b) => b.getCenter(new Vector3()));
    expect(pots.map((p) => ({ x: p.x, z: p.z }))).toEqual(plantSpots(floor.core).map((p) => ({ x: near(p.x), z: near(p.z) })));
  });
});

describe('nameplates', () => {
  afterEach(() => vi.restoreAllMocks());

  /** Markup that must stay text, short enough to be shown whole. */
  const HOSTILE = '<img src=x>&lt;';
  const span = (b: Box3) => b.getSize(new Vector3());
  const near = (v: number) => expect.closeTo(v, 5);

  /** A 2D context that records what is done with it, in order: a call by its name and arguments, a setting as 'set <name>'. */
  function recorder() {
    const calls: unknown[][] = [];
    const ctx = new Proxy(
      {},
      {
        get: (_target, key) => (...args: unknown[]) => void calls.push([key, ...args]),
        set: (_target, key, value) => {
          calls.push([`set ${String(key)}`, value]);
          return true;
        },
      },
    );
    return { ctx: ctx as CanvasRenderingContext2D, calls };
  }

  /** Gives every canvas a recording 2D context, and lists the canvases asked for one with what was drawn on each. */
  function canvases() {
    const made: Array<{ canvas: HTMLCanvasElement; calls: unknown[][] }> = [];
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
      const { ctx, calls } = recorder();
      made.push({ canvas: this, calls });
      return ctx;
    } as unknown as HTMLCanvasElement['getContext']);
    return made;
  }

  it('shows a name whole up to NAMEPLATE_CHARS code points, and cuts a longer one short with an ellipsis', () => {
    const whole = 'n'.repeat(NAMEPLATE_CHARS);
    expect(nameplateText(whole)).toBe(whole);
    expect(nameplateText(whole + 'n')).toBe('n'.repeat(NAMEPLATE_CHARS - 1) + '\u2026');
    // Code points, not UTF-16 units: a character outside the BMP is never cut in two.
    const octopus = '\u{1F419}';
    expect(nameplateText(octopus.repeat(NAMEPLATE_CHARS))).toBe(octopus.repeat(NAMEPLATE_CHARS));
    expect(nameplateText(octopus.repeat(NAMEPLATE_CHARS + 2))).toBe(octopus.repeat(NAMEPLATE_CHARS - 1) + '\u2026');
    expect(nameplateText('')).toBe('');
  });

  it('draws a nameplate as a white card with the name centred on it in ink, with fillText only', () => {
    const { w, h, pad, font } = NAMEPLATE_PX;
    const { ctx, calls } = recorder();
    drawNameplate(ctx, 'checkout tests');
    expect(calls).toEqual([
      ['set fillStyle', '#ffffff'],
      ['fillRect', 0, 0, w, h],
      ['set fillStyle', '#20263a'],
      ['set font', `600 ${font}px ui-monospace, monospace`],
      ['set textAlign', 'center'],
      ['set textBaseline', 'middle'],
      ['fillText', 'checkout tests', w / 2, h / 2, w - 2 * pad],
    ]);
    // A long name is cut short, and fillText narrows what is still wider than the card's inside.
    const long = recorder();
    drawNameplate(long.ctx, 'n'.repeat(200));
    expect(long.calls.at(-1)).toEqual(['fillText', nameplateText('n'.repeat(200)), w / 2, h / 2, w - 2 * pad]);
  });

  it('writes a hostile name as text: fillText gets it as it is, and the canvas never joins the page', () => {
    const made = canvases();
    const desk = checkoutFloor().pods[0]!.desks[0]!;
    const plate = buildNameplate(desk, { sessionId: 'ps-f7', name: HOSTILE }, new Geometries());
    expect(made).toHaveLength(1);
    const { canvas, calls } = made[0]!;
    expect(calls.filter((c) => c[0] === 'fillText').map((c) => c[1])).toEqual([HOSTILE]);
    expect(calls.map((c) => String(c[0])).filter((k) => /text|html/i.test(k) && k !== 'fillText' && !k.startsWith('set '))).toEqual([]);
    const map = (plate.mesh.material as MeshStandardMaterial).map as CanvasTexture;
    expect([map.image, canvas.width, canvas.height]).toEqual([canvas, NAMEPLATE_PX.w, NAMEPLATE_PX.h]);
    expect([canvas.isConnected, canvas.childNodes.length, document.querySelector('img')]).toEqual([false, 0, null]);
  });

  it("stands a nameplate on its desk's monitor, either side of a pod, lit, casting no shadow and blank without a 2D context", () => {
    const { geo, mats } = kit();
    const floor = checkoutFloor();
    const shell = buildShell(floor, geo, mats);
    shell.group.updateMatrixWorld(true);
    const monitors = drawn(shell.group, mats.surface.monitor);
    const desks = floor.pods[0]!.desks;
    expect(desks.map((d) => d.chair)).toEqual(['north', 'north', 'south', 'south']);
    for (const desk of desks) {
      // happy-dom's canvases have no 2D context: the card is left blank.
      const plate = buildNameplate(desk, { sessionId: 'ps-f7', name: 'ps-f7' }, geo);
      plate.mesh.updateMatrixWorld(true);
      const box = new Box3().setFromObject(plate.mesh);
      const monitor = monitors.find((m) => m.min.x > desk.rect.x && m.max.x < desk.rect.x + desk.rect.w && m.min.z > desk.rect.y && m.max.z < desk.rect.y + desk.rect.h)!;
      const c = monitor.getCenter(new Vector3());
      // On the monitor's top edge, centred over it, in its plane.
      expect([box.min.y, box.getCenter(new Vector3()).x, box.getCenter(new Vector3()).z], desk.id).toEqual([near(monitor.max.y), near(c.x), near(c.z)]);
      expect(span(box).toArray(), desk.id).toEqual([near(NAMEPLATE.w), near(NAMEPLATE.h), near(NAMEPLATE.d)]);
      expect([plate.mesh.name, plate.mesh.rotation.y, plate.mesh.castShadow, plate.mesh.receiveShadow]).toEqual([`nameplate ${desk.id}`, desk.chair === 'north' ? Math.PI : 0, false, true]);
      const material = plate.mesh.material as MeshStandardMaterial;
      expect([material.isMeshStandardMaterial, material.map instanceof CanvasTexture, material.map!.colorSpace]).toEqual([true, true, SRGBColorSpace]);
    }
  });

  it('frees its texture and its material, not the geometry every nameplate shares, as it comes off its desk', () => {
    const geo = new Geometries();
    const desk = checkoutFloor().pods[0]!.desks[0]!;
    const plate = buildNameplate(desk, { sessionId: 'ps-f7', name: 'ps-f7' }, geo);
    const other = buildNameplate(checkoutFloor().pods[0]!.desks[1]!, { sessionId: 'oa-d5', name: 'oa-d5' }, geo);
    expect(other.mesh.geometry).toBe(plate.mesh.geometry);
    expect(other.mesh.material).not.toBe(plate.mesh.material);
    const parent = new Group().add(plate.mesh);
    const freed: string[] = [];
    const material = plate.mesh.material as MeshStandardMaterial;
    material.addEventListener('dispose', () => freed.push('material'));
    material.map!.addEventListener('dispose', () => freed.push('texture'));
    plate.mesh.geometry.addEventListener('dispose', () => freed.push('geometry'));
    plate.dispose();
    expect([plate.mesh.parent, parent.children.length, freed]).toEqual([null, 0, ['material', 'texture']]);
    expect([plate.sessionId, plate.name]).toEqual(['ps-f7', 'ps-f7']);
  });
});

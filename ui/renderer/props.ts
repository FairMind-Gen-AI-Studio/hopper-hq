/**
 * The floor's furniture from primitives: the shell (slab, walls with windows, the elevator and plants of the core), and
 * on the plan a rug, a lamp and four desks per pod, the lounge and a meeting room per room slot. Proportions follow
 * prototypes/floor-3d-mockup.html. The furniture (furniture.ts) is drawn by instanced meshes: the desks, the rooms'
 * tables and seats, the lounge's couches, coffee table and beanbags, and the plants.
 */
import {
  BoxGeometry,
  CircleGeometry,
  Color,
  CylinderGeometry,
  Group,
  Mesh,
  PlaneGeometry,
  RingGeometry,
  SphereGeometry,
  type BufferGeometry,
  type Material,
  type Object3D,
} from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { FloorDetail, GridRect, MeetingRoom, Occupant, PodDesk } from '../../src/scene/types';
import { Furniture, frameAt, type Piece, type PieceOptions } from './furniture';
import type { Target } from './index';
import { DESK_OFF, type Materials } from './materials';
import {
  BEANBAG_R,
  BEANBAG_SCALE,
  BEANBAG_X,
  BOARD,
  CHAIR_Z,
  COFFEE_TABLE,
  COUCH,
  COUCH_ARM,
  COUCH_BACK,
  COUCH_Z,
  DESK_CHAIR,
  DESK_TOP,
  PARTITION_H,
  PARTITION_T,
  ROOM_SEAT,
  TABLE,
  WALL_H,
  WALL_SIDES,
  WALL_T,
  deskAnchor,
  doorGap,
  headSpot,
  plantSpots,
  rectCenter,
  seatSpots,
  tableCenter,
  type WallSide,
} from './world';

/**
 * What a click on a mesh selects, a desk or a room: set as `mesh.userData.pick`, or for an instance of an instanced mesh
 * as `mesh.userData.picks[instanceId]` (furniture.ts).
 */
export type PickData = Target;

/** Fixed-size geometries, made once and shared by every desk, robot and fitting; freed together by dispose(). */
export class Geometries {
  private readonly made = new Map<string, BufferGeometry>();

  box(w: number, h: number, d: number): BufferGeometry {
    return this.shared(`box ${w} ${h} ${d}`, () => new BoxGeometry(w, h, d));
  }

  /** A box with rounded edges. */
  rbox(w: number, h: number, d: number, r: number): BufferGeometry {
    return this.shared(`rbox ${w} ${h} ${d} ${r}`, () => new RoundedBoxGeometry(w, h, d, 2, Math.min(r, w / 2, h / 2, d / 2)));
  }

  /** A cylinder; rt != rb makes a cone or a lamp shade. */
  rod(rt: number, rb: number, h: number, segments = 12): BufferGeometry {
    return this.shared(`rod ${rt} ${rb} ${h} ${segments}`, () => new CylinderGeometry(rt, rb, h, segments));
  }

  ball(r: number): BufferGeometry {
    return this.shared(`ball ${r}`, () => new SphereGeometry(r, 16, 12));
  }

  plane(w: number, h: number): BufferGeometry {
    return this.shared(`plane ${w} ${h}`, () => new PlaneGeometry(w, h));
  }

  circle(r: number): BufferGeometry {
    return this.shared(`circle ${r}`, () => new CircleGeometry(r, 24));
  }

  ring(inner: number, outer: number): BufferGeometry {
    return this.shared(`ring ${inner} ${outer}`, () => new RingGeometry(inner, outer, 48));
  }

  get size(): number {
    return this.made.size;
  }

  dispose(): void {
    for (const g of this.made.values()) g.dispose();
    this.made.clear();
  }

  /** The geometry made under this key, made by `make` the first time. */
  shared(key: string, make: () => BufferGeometry): BufferGeometry {
    let g = this.made.get(key);
    if (!g) {
      g = make();
      this.made.set(key, g);
    }
    return g;
  }
}

export interface PartOptions {
  rx?: number;
  ry?: number;
  /** Casts a shadow (default true). Every part receives shadows. */
  cast?: boolean;
}

/** A mesh added to a parent at (x, y, z). */
export function part(parent: Object3D, geometry: BufferGeometry, material: Material, x: number, y: number, z: number, opts: PartOptions = {}): Mesh {
  const mesh = new Mesh(geometry, material);
  mesh.position.set(x, y, z);
  if (opts.rx) mesh.rotation.x = opts.rx;
  if (opts.ry) mesh.rotation.y = opts.ry;
  mesh.castShadow = opts.cast !== false;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

/** Windows: about one every WINDOW_EVERY metres of wall, each WINDOW_W wide, at WINDOW_Y. */
export const WINDOW_EVERY = 5;
export const WINDOW_W = 2.2;
export const WINDOW_Y = 1.55;
/** The elevator's frame width on the north wall. */
export const ELEVATOR_W = 2;
/** Each elevator door's width, and how far it slides aside from its closed place when the doors open. */
export const DOOR_PANEL = 0.8;
export const DOOR_SLIDE = 0.72;

/** Centres of the windows along a wall of this length, leaving out any that would overlap `skip` (from, to). */
export function windowSpots(length: number, skip: readonly [number, number] | null = null): number[] {
  const n = Math.max(1, Math.floor(length / WINDOW_EVERY));
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const at = ((i + 0.5) * length) / n;
    if (skip && at + WINDOW_W / 2 > skip[0] && at - WINDOW_W / 2 < skip[1]) continue;
    out.push(at);
  }
  return out;
}

export interface WallPart {
  side: WallSide;
  /** The wall and its windows; hidden when it faces the camera. */
  group: Group;
}

export interface PodObject {
  readonly id: string;
  /** The rug, in the repo colour of the pod's occupants while they share one, neutral otherwise. */
  readonly rug: Mesh;
  /** The shade of the lamp over the pod, in the rug's colour. */
  readonly shade: Mesh;
}

export interface Shell {
  readonly group: Group;
  readonly walls: readonly WallPart[];
  /** Every pod's rug and lamp, by pod id. */
  readonly pods: ReadonlyMap<string, PodObject>;
  /** Every desk of every pod, by desk id, in plan order. */
  readonly desks: ReadonlyMap<string, DeskObject>;
  /** The furniture its instanced meshes draw: the desks, the rooms' tables and seats, the lounge's furniture and the plants. */
  readonly furniture: Furniture;
  /** Every room of the plan, by slot. */
  readonly rooms: readonly RoomObject[];
  /** The elevator's two doors, west then east: shut until robots come or go. */
  readonly doors: readonly Mesh[];
  /** Detaches the shell and frees the geometries sized to this floor and the instanced meshes. */
  dispose(): void;
}

/**
 * The floor's shell, sized to its plan: the slab, the walls, the core, each pod's rug, lamp and four desks, the lounge
 * and every room of the plan, open or not. Rebuilt only when the plan grows; what changes in between (rug colours, who
 * sits at a desk, which rooms are open) is updated in place.
 */
export function buildShell(floor: Pick<FloorDetail, 'size' | 'core' | 'pods' | 'lounge' | 'roomSlots'>, geo: Geometries, mats: Materials): Shell {
  const { w, h } = floor.size;
  const group = new Group();
  group.name = 'shell';
  const own: BufferGeometry[] = [];
  const sized = (g: BufferGeometry) => {
    own.push(g);
    return g;
  };
  const s = mats.surface;
  const furniture = new Furniture();

  part(group, sized(new BoxGeometry(w, 0.3, h)), s.floor, w / 2, -0.15, h / 2, { cast: false });

  const core = rectCenter(floor.core);
  const walls: WallPart[] = WALL_SIDES.map((side) => {
    const wall = new Group();
    wall.name = `wall-${side}`;
    const alongX = side === 'north' || side === 'south';
    const length = alongX ? w : h;
    const cx = side === 'west' ? -WALL_T / 2 : side === 'east' ? w + WALL_T / 2 : w / 2;
    const cz = side === 'north' ? -WALL_T / 2 : side === 'south' ? h + WALL_T / 2 : h / 2;
    const sx = alongX ? w + 2 * WALL_T : WALL_T;
    const sz = alongX ? WALL_T : h;
    part(wall, sized(new BoxGeometry(sx, WALL_H, sz)), s.wall, cx, WALL_H / 2, cz);
    part(group, sized(new BoxGeometry(sx, 0.22, sz)), s.base, cx, 0.11, cz);
    // Windows hang on the inner face, facing into the room.
    const skip = side === 'north' ? ([core.x - ELEVATOR_W / 2 - 0.4, core.x + ELEVATOR_W / 2 + 0.4] as const) : null;
    const ry = side === 'north' ? 0 : side === 'south' ? Math.PI : side === 'west' ? Math.PI / 2 : -Math.PI / 2;
    const inner = side === 'north' ? 0 : side === 'south' ? h : side === 'west' ? 0 : w;
    const inward = side === 'north' || side === 'west' ? 1 : -1;
    for (const at of windowSpots(length, skip)) {
      const x = alongX ? at : inner + inward * 0.003;
      const z = alongX ? inner + inward * 0.003 : at;
      const x2 = alongX ? at : inner + inward * 0.006;
      const z2 = alongX ? inner + inward * 0.006 : at;
      part(wall, geo.plane(WINDOW_W + 0.16, 1.26), s.frame, x, WINDOW_Y, z, { ry, cast: false });
      part(wall, geo.plane(WINDOW_W, 1.1), s.window, x2, WINDOW_Y, z2, { ry, cast: false });
    }
    group.add(wall);
    return { side, group: wall };
  });

  // The core: the elevator on the north wall above it, a lobby mat and two plants. The doors slide over the wall: they
  // cast no shadow, so that the shadow map need not be drawn again as they move.
  const north = walls[0]!.group;
  part(north, geo.rbox(ELEVATOR_W, 2.4, 0.12, 0.03), s.frame, core.x, 1.2, 0.06);
  part(north, geo.box(1.6, 2.1, 0.02), s.monitor, core.x, 1.05, 0.12, { cast: false });
  const doors = [-1, 1].map((side) => part(north, geo.box(DOOR_PANEL, 2.1, 0.05), s.elevator, core.x + (side * DOOR_PANEL) / 2, 1.05, 0.16, { cast: false }));
  part(north, geo.ball(0.06), s.lamp, core.x, 2.5, 0.16, { cast: false });
  const lobbyD = floor.core.y + floor.core.h;
  part(group, geo.plane(floor.core.w, lobbyD), s.lobby, core.x, 0.004, lobbyD / 2, { rx: -Math.PI / 2, cast: false });
  for (const spot of plantSpots(floor.core)) plant(furniture, geo, mats, spot.x, spot.z);

  // Each pod: a rug, a lamp over it, and its four desks. Rugs and shades start neutral: the floor colours them.
  const pods = new Map<string, PodObject>();
  const desks = new Map<string, DeskObject>();
  for (const pod of floor.pods) {
    const c = rectCenter(pod.rect);
    const rug = part(group, geo.plane(pod.rect.w - 0.3, pod.rect.h - 0.3), s.rug, c.x, 0.005, c.z, { rx: -Math.PI / 2, cast: false });
    rug.name = `rug ${pod.id}`;
    part(group, geo.rod(0.008, 0.008, 1.4, 4), s.leg, c.x, 2.9, c.z, { cast: false });
    const shade = part(group, geo.rod(0.2, 0.34, 0.2, 24), s.base, c.x, 2.15, c.z, { cast: false });
    part(group, geo.circle(0.3), s.lamp, c.x, 2.045, c.z, { rx: Math.PI / 2, cast: false });
    pods.set(pod.id, { id: pod.id, rug, shade });
    for (const desk of pod.desks) desks.set(desk.id, buildDesk(desk, furniture, geo, mats));
  }

  buildLounge(group, floor.lounge.rect, furniture, geo, mats);

  const rooms = floor.roomSlots.map((rect, slot) => {
    const obj = buildRoom(rect, slot, furniture, geo, mats);
    group.add(obj.group);
    return obj;
  });
  furniture.build(group);

  return {
    group,
    walls,
    pods,
    desks,
    furniture,
    rooms,
    doors,
    dispose() {
      group.removeFromParent();
      for (const g of own) g.dispose();
      furniture.dispose();
    },
  };
}

/** Slides the elevator doors `open` of the way open: 0 shut, 1 open. */
export function setDoors(doors: readonly Mesh[], core: GridRect, open: number): void {
  const x = rectCenter(core).x;
  doors.forEach((door, i) => {
    door.position.x = x + (i === 0 ? -1 : 1) * (DOOR_PANEL / 2 + open * DOOR_SLIDE);
  });
}

/** Colours a pod's rug and lamp shade by its repo slot; neutral when it has none. */
export function updatePod(obj: PodObject, color: number | null, mats: Materials): void {
  obj.rug.material = color === null ? mats.surface.rug : mats.rug(color);
  obj.shade.material = color === null ? mats.surface.base : mats.body(color);
}

/** Where the floor's own pieces stand: the plants and the lounge's furniture, placed in floor coordinates. */
const ON_FLOOR = frameAt(0, 0);

/** A plant of the core, as pieces of the floor's furniture: its pot and three balls of leaves. */
function plant(furniture: Furniture, geo: Geometries, mats: Materials, x: number, z: number): void {
  furniture.add(ON_FLOOR, geo.rod(0.22, 0.17, 0.36, 16), mats.surface.pot, x, 0.18, z);
  furniture.add(ON_FLOOR, geo.ball(0.28), mats.surface.plant, x, 0.6, z);
  furniture.add(ON_FLOOR, geo.ball(0.22), mats.surface.plant, x + 0.12, 0.86, z - 0.05);
  furniture.add(ON_FLOOR, geo.ball(0.18), mats.surface.plant, x - 0.1, 1.02, z + 0.06);
}

/**
 * The lounge (world.ts places its seats): a rug, and as pieces of the floor's furniture a coffee table, two couches
 * facing each other across it, each with its back away from the table, and a beanbag at each end of the table.
 */
function buildLounge(parent: Group, rect: GridRect, furniture: Furniture, geo: Geometries, mats: Materials): void {
  const s = mats.surface;
  const c = rectCenter(rect);
  const add = (geometry: BufferGeometry, material: Material, x: number, y: number, z: number, opts?: PieceOptions) => furniture.add(ON_FLOOR, geometry, material, x, y, z, opts);
  const group = new Group();
  group.name = 'lounge';
  parent.add(group);
  part(group, geo.plane(2 * (BEANBAG_X + BEANBAG_R) + 0.6, 2 * COUCH_Z + COUCH.d + 0.2), s.loungeRug, c.x, 0.006, c.z, { rx: -Math.PI / 2, cast: false });
  for (const sign of [-1, 1]) {
    const z = c.z + sign * COUCH_Z;
    const back = z + sign * (COUCH.d / 2 - COUCH_BACK / 2);
    add(geo.rbox(COUCH.w, 0.42, COUCH.d, 0.08), s.couch, c.x, 0.21, z);
    add(geo.rbox(COUCH.w, 0.62, COUCH_BACK, 0.08), s.couch, c.x, 0.6, back);
    for (const end of [-1, 1]) add(geo.rbox(COUCH_ARM, 0.56, COUCH.d, 0.08), s.couch, c.x + end * (COUCH.w / 2), 0.38, z);
  }
  add(geo.rbox(COFFEE_TABLE.w, 0.06, COFFEE_TABLE.d, 0.02), s.wood, c.x, 0.42, c.z);
  for (const dx of [-0.6, 0.6]) add(geo.rod(0.05, 0.05, 0.4, 8), s.leg, c.x + dx, 0.2, c.z, { cast: false });
  add(geo.rod(0.06, 0.07, 0.1, 12), s.paper, c.x + 0.3, 0.5, c.z - 0.1, { cast: false });
  const squash = [BEANBAG_SCALE.across, BEANBAG_SCALE.up, BEANBAG_SCALE.across] as const;
  for (const [side, bean] of [[-1, s.beanA], [1, s.beanB]] as const) add(geo.ball(BEANBAG_R), bean, c.x + side * BEANBAG_X, 0.2, c.z, { scale: squash });
}

export interface DeskObject {
  /** The desk's id ('p<pod>-<n>'). */
  readonly id: string;
  /** Its top, dimmed while its occupant is dormant. */
  readonly top: Piece;
  /** Its screen, lit in its occupant's state colour, off while it is free. */
  readonly screen: Piece;
  /** The pieces a click selects the desk by, while somebody sits at it: the top, the monitor, the screen and the chair. */
  readonly pickables: readonly Piece[];
}

/** The colour that leaves a piece's material as it is, and the one that dims the top of a dormant session's desk. */
const AS_IS = new Color(1, 1, 1);
const DIMMED = new Color(DESK_OFF, DESK_OFF, DESK_OFF);

/**
 * One desk, as pieces of the floor's furniture: top, legs, monitor and screen, keyboard and chair. Built facing north
 * (the monitor on the north side, the chair on the south side) in a frame at the desk top's centre on the ground
 * (world.deskAnchor), turned round when its chair is on the north edge. Only the top, the monitor and the chair cast
 * shadows: thin parts would cost a draw for a texel or two of shadow. It starts free: its screen off.
 */
export function buildDesk(desk: Pick<PodDesk, 'id' | 'rect' | 'chair'>, furniture: Furniture, geo: Geometries, mats: Materials): DeskObject {
  const s = mats.surface;
  const thin = { cast: false };
  const a = deskAnchor(desk);
  const frame = frameAt(a.x, a.z, desk.chair === 'north' ? Math.PI : 0);
  const add = (geometry: BufferGeometry, material: Material, x: number, y: number, z: number, opts?: PieceOptions) => furniture.add(frame, geometry, material, x, y, z, opts);
  const top = add(geo.rbox(DESK_TOP.w, 0.07, DESK_TOP.d, 0.02), s.desk, 0, 0.74, 0);
  for (const [lx, lz] of [[-0.74, -0.34], [0.74, -0.34], [-0.74, 0.34], [0.74, 0.34]] as const) {
    add(geo.box(0.05, 0.72, 0.05), s.leg, lx, 0.36, lz, thin);
  }
  add(geo.box(0.25, 0.02, 0.16), s.leg, 0, 0.785, -0.22, thin);
  add(geo.box(0.05, 0.28, 0.05), s.leg, 0, 0.92, -0.24, thin);
  const monitor = add(geo.rbox(0.74, 0.46, 0.05, 0.02), s.monitor, 0, 1.15, -0.24);
  const screen = add(geo.plane(0.66, 0.38), mats.screen, 0, 1.15, -0.212, thin);
  add(geo.box(0.46, 0.02, 0.15), s.key, 0, 0.785, 0.26, thin);
  const seat = add(geo.rbox(DESK_CHAIR.w, 0.08, DESK_CHAIR.seat, 0.03), s.chair, 0, 0.45, CHAIR_Z);
  const back = add(geo.rbox(DESK_CHAIR.w, 0.5, DESK_CHAIR.back, 0.03), s.chair, 0, 0.75, DESK_CHAIR.backZ);
  add(geo.rod(0.03, 0.03, 0.4, 8), s.leg, 0, 0.22, CHAIR_Z, thin);
  add(geo.rod(0.22, 0.22, 0.03, 16), s.leg, 0, 0.02, CHAIR_Z, thin);
  const obj: DeskObject = { id: desk.id, top, screen, pickables: [top, monitor, screen, seat, back] };
  updateDesk(obj, null, mats);
  return obj;
}

/**
 * Shows who sits at the desk: the screen lit in its occupant's state colour, the top dimmed while the occupant is
 * dormant, and a click on it picks the occupant. A free desk has its screen off and picks nothing. Run it again after a
 * theme change: the screen's colour comes from the theme.
 */
export function updateDesk(obj: DeskObject, occupant: Occupant | null, mats: Materials): void {
  obj.screen.paint(mats.screenColor(occupant?.state ?? 'idle'));
  obj.top.paint(occupant?.state === 'dormant' ? DIMMED : AS_IS);
  const pick: PickData | undefined = occupant ? { kind: 'desk', id: occupant.sessionId } : undefined;
  for (const piece of obj.pickables) piece.pick = pick;
}

export interface RoomObject {
  /** Its room slot. */
  readonly slot: number;
  /** Stands at the room's north-west corner on the ground: everything in the room is placed from there. */
  readonly group: Group;
  readonly floor: Mesh;
  /** The door panel in the west partition: shown, closed, while the room is empty. */
  readonly door: Mesh;
  /** A card on the head seat, shown while a run holds the room and its host is not at the head of the table. */
  readonly placard: Mesh;
  /** Every mesh of the room but its glass and its door: while a run holds the room, a click on any of them selects it. */
  readonly pickables: readonly Mesh[];
  /** Its table and seats, pieces of the floor's furniture: while a run holds the room, a click on any of them selects it too. */
  readonly pieces: readonly Piece[];
}

/**
 * One room of the meeting wing, from its north-west corner: a floor, glass partitions with a door in the west one, a
 * table with SEATS_MAX seats and a head seat (pieces of the floor's furniture), a whiteboard on the north partition and
 * a placard. No lamp hangs over the table: seen from above, it would hide the agents. Every geometry is shared: rooms
 * are all the same size. Only the table top and the seats cast shadows. A click goes through the glass, to whatever
 * lies behind it. It starts empty: its floor dim and its door closed.
 */
export function buildRoom(rect: GridRect, slot: number, furniture: Furniture, geo: Geometries, mats: Materials): RoomObject {
  const s = mats.surface;
  const thin = { cast: false };
  const { w, h } = rect;
  const local = { x: 0, y: 0, w, h };
  const group = new Group();
  group.name = `room ${slot}`;
  group.position.set(rect.x, 0, rect.y);

  const floor = part(group, geo.plane(w, h), s.roomDim, w / 2, 0.006, h / 2, { rx: -Math.PI / 2, cast: false });

  // Glass along each edge, inside the room's cells, and a frame rail on top of each pane. The west partition is two
  // panes, either side of the door.
  const door = doorGap(local);
  const t = PARTITION_T;
  const panes: Array<[x: number, z: number, lx: number, lz: number]> = [
    [w / 2, t / 2, w, t],
    [w / 2, h - t / 2, w, t],
    [w - t / 2, h / 2, t, h - 2 * t],
    [t / 2, (t + door.from) / 2, t, door.from - t],
    [t / 2, (door.to + h - t) / 2, t, h - t - door.to],
  ];
  const skip = new Set<Mesh>();
  for (const [x, z, lx, lz] of panes) {
    skip.add(part(group, geo.box(lx, PARTITION_H, lz), s.glass, x, PARTITION_H / 2, z, thin));
    part(group, geo.box(lx, 0.05, lz), s.frame, x, PARTITION_H - 0.025, z, thin);
  }
  // Posts at the corners and either side of the door.
  for (const [x, z] of [[t, t], [w - t, t], [t, h - t], [w - t, h - t], [t, door.from], [t, door.to]] as const) {
    part(group, geo.box(2 * t, PARTITION_H, 2 * t), s.frame, x, PARTITION_H / 2, z, thin);
  }
  const panel = part(group, geo.box(t, PARTITION_H - 0.1, door.to - door.from - 0.04), s.frame, t / 2, (PARTITION_H - 0.1) / 2, (door.from + door.to) / 2, thin);
  skip.add(panel);

  // The table, its two pedestals, and a seat on a post at each place.
  const frame = frameAt(rect.x, rect.y);
  const add = (geometry: BufferGeometry, material: Material, x: number, y: number, z: number, opts?: PieceOptions) => furniture.add(frame, geometry, material, x, y, z, opts);
  const c = tableCenter(local);
  const pieces = [add(geo.rbox(TABLE.w, 0.08, TABLE.d, 0.03), s.desk, c.x, 0.74, c.z)];
  for (const dx of [-1.4, 1.4]) pieces.push(add(geo.rod(0.12, 0.12, 0.7, 12), s.leg, c.x + dx, 0.35, c.z, thin));
  const head = headSpot(local);
  for (const spot of [...seatSpots(local), head]) {
    pieces.push(add(geo.rbox(ROOM_SEAT, 0.07, ROOM_SEAT, 0.03), s.chair, spot.x, 0.44, spot.z));
    pieces.push(add(geo.rod(0.03, 0.03, 0.4, 8), s.leg, spot.x, 0.2, spot.z, thin));
  }
  const placard = part(group, geo.box(0.3, 0.2, 0.02), s.paper, head.x, 0.575, head.z, { ry: Math.PI / 2, cast: false });

  // The whiteboard in its frame, on the inside of the north partition; its overlay lists the phases (labels.ts).
  part(group, geo.box(BOARD.w + 0.08, BOARD.h + 0.08, 0.02), s.frame, w / 2, BOARD.y, t + 0.01, thin);
  part(group, geo.rbox(BOARD.w, BOARD.h, 0.05, 0.02), s.board, w / 2, BOARD.y, t + 0.025, thin);

  const pickables: Mesh[] = [];
  group.traverse((o) => {
    if ((o as Mesh).isMesh && !skip.has(o as Mesh)) pickables.push(o as Mesh);
  });
  const obj: RoomObject = { slot, group, floor, door: panel, placard, pickables, pieces };
  updateRoom(obj, null, false, mats);
  return obj;
}

/**
 * Opens the room for the run that holds it, or closes it: a run's room has its floor tinted for meetings, its door open,
 * its placard on the head seat while its host is elsewhere, and picks the run; an empty room is dim, closed, and picks
 * nothing.
 */
export function updateRoom(obj: RoomObject, room: Pick<MeetingRoom, 'runId'> | null, hostHere: boolean, mats: Materials): void {
  obj.floor.material = room ? mats.surface.roomFloor : mats.surface.roomDim;
  obj.door.visible = room === null;
  obj.placard.visible = room !== null && !hostHere;
  const pick: PickData | undefined = room ? { kind: 'room', id: room.runId } : undefined;
  for (const m of obj.pickables) {
    if (pick) m.userData.pick = pick;
    else delete m.userData.pick;
  }
  for (const piece of obj.pieces) piece.pick = pick;
}

import { describe, expect, it } from 'vitest';
import { INTERNS_MAX, LOUNGE_SEATS, SEATS_MAX, layoutPlan } from '../../../src/scene/layout';
import type { Occupant, Place, PodDesk } from '../../../src/scene/types';
import {
  BAR_CART,
  BAR_COUNTER,
  BAR_SHELF,
  BAR_SPOT_DX,
  BAR_SPOT_OUT,
  BAR_STOOL_DX,
  BAR_STOOL_OUT,
  BEANBAG_SCALE,
  BEANBAG_X,
  BOARD,
  BOARD_NORMAL,
  CAMERA_DISTANCE,
  CARD_LEAN,
  CARD_Y,
  CHAIR_Z,
  COFFEE_MACHINE,
  COFFEE_MACHINE_OUT,
  COUCH,
  COUCH_ARM,
  COUCH_BACK,
  COUCH_Z,
  DESK_CHAIR,
  DESK_TOP,
  DOOR_W,
  ELEVATOR_STEP,
  FOOSBALL,
  FOOSBALL_OUT,
  FRAME_MARGIN,
  HOME_AZIMUTH,
  LABEL_Y,
  PARTITION_H,
  PARTITION_T,
  PLANT_IN,
  POLAR,
  ROOM_SEAT,
  TABLE,
  azimuthOf,
  barCartCenter,
  barCartSpots,
  boardAnchor,
  boardCorners,
  cameraOffset,
  cardAnchor,
  cardLean,
  cellToWorld,
  coffeeMachineCenter,
  coffeeMachineSpots,
  deskAnchor,
  doorGap,
  elevatorSpot,
  facesCamera,
  floorCenter,
  foosballCenter,
  foosballSpots,
  frustumFor,
  headSpot,
  internSpots,
  isStanding,
  labelAnchor,
  loungeSpots,
  placardAnchor,
  placeSpot,
  plantSpots,
  polarOf,
  roomKey,
  roomTagAnchor,
  seatSpot,
  seatSpots,
  shadowExtent,
  standSpot,
  tableCenter,
  visibleWalls,
  type Point,
} from '../../renderer/world';
import { checkoutOf, checkoutSpecs, makeOccupant } from './fixtures';

const RECT = { x: 3, y: 7, w: 2, h: 2 };
/** A desk of a pod's south row, chair on its south edge, and one of its north row, chair on its north edge. */
const SOUTH: Pick<PodDesk, 'rect' | 'chair'> = { rect: RECT, chair: 'south' };
const NORTH: Pick<PodDesk, 'rect' | 'chair'> = { rect: RECT, chair: 'north' };
const QUARTER = Math.PI / 2;
/** How far the monitor stands from the desk top's centre, away from the chair (props.ts). */
const MONITOR_Z = 0.24;
const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.z - b.z);
/** A session in this state, at this place. */
const who = (state: Occupant['state'], at: Place) => makeOccupant({ id: 'x', state }, 0, null, checkoutOf(checkoutSpecs()[0]!), at);

describe('world maths', () => {
  it('maps a grid cell to the ground plane, one cell per metre', () => {
    expect(cellToWorld(5, 9)).toEqual({ x: 5, z: 9 });
    expect(floorCenter({ w: 22, h: 12 })).toEqual({ x: 11, z: 6 });
  });

  it('puts the desk top toward the edge opposite the chair, the chair toward its own edge, and a robot facing the monitor', () => {
    expect(deskAnchor(SOUTH)).toEqual({ x: 4, z: 7.6 });
    const seat = seatSpot(SOUTH);
    expect(seat.x).toBe(4);
    expect(seat.z).toBeCloseTo(8.38, 10);
    expect(seat.facing).toBe(Math.PI);
    const stand = standSpot(SOUTH);
    expect(stand.x).toBeCloseTo(4.6, 10);
    expect(stand.z).toBeCloseTo(8.48, 10);
    expect(stand.facing).toBe(0);
    // The north row is the south row turned round: the chair on the north edge, the robot facing south.
    expect(deskAnchor(NORTH)).toEqual({ x: 4, z: 8.4 });
    const north = seatSpot(NORTH);
    expect([north.x, north.facing]).toEqual([4, 0]);
    expect(north.z).toBeCloseTo(7.62, 10);
    const up = standSpot(NORTH);
    expect([up.facing]).toEqual([Math.PI]);
    expect(up.x).toBeCloseTo(4.6, 10);
    expect(up.z).toBeCloseTo(7.52, 10);
    // Waving and holding stand up from the chair; typing, dozing and resting sit; every leisure pose stands too, at the
    // break area, which has no chair.
    expect((['typing', 'still', 'resting'] as const).map(isStanding)).toEqual([false, false, false]);
    expect((['waving', 'holding', 'gintonic', 'biliardino', 'coffee'] as const).map(isStanding)).toEqual([true, true, true, true, true]);
    // Every spot stays inside the desk's own cells.
    for (const s of [seat, stand, north, up]) {
      expect(s.x).toBeGreaterThan(RECT.x);
      expect(s.x).toBeLessThan(RECT.x + RECT.w);
      expect(s.z).toBeGreaterThan(RECT.y);
      expect(s.z).toBeLessThan(RECT.y + RECT.h);
    }
  });

  it('floats the interns over the desk\'s own half, between its monitor and its chair, turned toward the middle', () => {
    for (const desk of [SOUTH, NORTH]) {
      const a = deskAnchor(desk);
      // Toward the chair: south for the south row, north for the north row.
      const sign = desk.chair === 'south' ? 1 : -1;
      const spots = internSpots(desk);
      expect(spots).toHaveLength(INTERNS_MAX);
      for (const s of spots) {
        expect(sign * (s.z - a.z) + MONITOR_Z).toBeGreaterThanOrEqual(0.25);
        expect(sign * (s.z - a.z)).toBeLessThan(CHAIR_Z);
        expect(s.x).toBeGreaterThan(RECT.x);
        expect(s.x).toBeLessThan(RECT.x + RECT.w);
      }
      const [middle, west, east] = spots;
      expect([middle!.x, middle!.facing]).toEqual([a.x, sign === 1 ? 0 : Math.PI]);
      expect(west!.x).toBeLessThan(a.x);
      expect(east!.x).toBeGreaterThan(a.x);
      // The arc bows toward the chair in the middle, and its ends turn in.
      expect(sign * (middle!.z - west!.z)).toBeGreaterThan(0);
      expect(west!.z).toBe(east!.z);
      expect(Math.sin(west!.facing)).toBeGreaterThan(0);
      expect(Math.sin(east!.facing)).toBeCloseTo(-Math.sin(west!.facing), 10);
    }
  });

  it('keeps every two intern spots of a pod at least half a metre apart', () => {
    const spots = layoutPlan({ blocks: 1, roomCols: 1 }).pods[0]!.desks.flatMap((d) => internSpots(d));
    expect(spots).toHaveLength(4 * INTERNS_MAX);
    spots.forEach((s, i) => {
      for (const other of spots.slice(i + 1)) expect(dist(s, other)).toBeGreaterThanOrEqual(0.5);
    });
  });

  it('seats the lounge: the north couch west to east, the south couch west to east, then the west and east beanbags, each facing the table', () => {
    const lounge = layoutPlan({ blocks: 1, roomCols: 1 }).lounge;
    const c = { x: lounge.x + lounge.w / 2, z: lounge.y + lounge.h / 2 };
    const spots = loungeSpots(lounge);
    expect(spots).toHaveLength(LOUNGE_SEATS);
    const [n0, n1, n2, s0, s1, s2, west, east] = spots;
    for (const row of [[n0!, n1!, n2!], [s0!, s1!, s2!]]) {
      expect(row[0]!.x).toBeLessThan(row[1]!.x);
      expect(row[1]!.x).toBe(c.x);
      expect(row[1]!.x).toBeLessThan(row[2]!.x);
      expect(new Set(row.map((s) => s.z)).size).toBe(1);
    }
    expect(n0!.z).toBeLessThan(c.z);
    expect(n0!.z).toBeGreaterThan(c.z - COUCH_Z);
    expect(s0!.z).toBeGreaterThan(c.z);
    expect([n0!.facing, s0!.facing]).toEqual([0, Math.PI]);
    expect([west, east]).toEqual([{ x: c.x - BEANBAG_X, z: c.z, facing: QUARTER }, { x: c.x + BEANBAG_X, z: c.z, facing: -QUARTER }]);
    spots.forEach((s, i) => {
      expect(s.x).toBeGreaterThan(lounge.x);
      expect(s.x).toBeLessThan(lounge.x + lounge.w);
      expect(s.z).toBeGreaterThan(lounge.y);
      expect(s.z).toBeLessThan(lounge.y + lounge.h);
      for (const other of spots.slice(i + 1)) expect(dist(s, other)).toBeGreaterThanOrEqual(0.5);
    });
  });

  it("stands the bar near the break area's west edge, with 4 \"standing with a glass\" spots evenly spaced along the counter's front, each facing north toward it", () => {
    const rect = layoutPlan({ blocks: 1, roomCols: 1 }).breakArea;
    const c = barCartCenter(rect);
    const spots = barCartSpots(rect);
    expect(spots).toHaveLength(4);
    expect(spots).toEqual(BAR_SPOT_DX.map((dx) => ({ x: c.x + dx, z: c.z + BAR_SPOT_OUT, facing: Math.PI })));
    // Evenly spaced, west to east.
    for (let i = 1; i < spots.length; i++) expect(spots[i]!.x - spots[i - 1]!.x).toBeCloseTo(spots[1]!.x - spots[0]!.x);
    for (const s of spots) {
      expect(s.x).toBeGreaterThan(rect.x);
      expect(s.x).toBeLessThan(rect.x + rect.w);
      expect(s.z).toBeGreaterThan(rect.y);
      expect(s.z).toBeLessThan(rect.y + rect.h);
    }
    // Grown well past the old bar cart's 1.0 x 0.5, wide and deep enough to hold the shelf and the counter together.
    expect(BAR_CART).toEqual({ w: 2.2, d: 0.9 });
    // The shelf racks behind the bar's centre, the counter stands in front of it, and a stool stands either side of
    // the counter, all inside BAR_CART's own footprint or its walk clearance, so neither needs blocking of its own.
    expect(BAR_SHELF.w).toBeLessThan(BAR_CART.w);
    expect(BAR_COUNTER.w).toBeLessThan(BAR_CART.w);
    expect(BAR_SHELF.d + BAR_COUNTER.d).toBeLessThan(BAR_CART.d);
    expect(BAR_STOOL_OUT).toBeGreaterThan(BAR_CART.d / 2);
    expect(BAR_STOOL_DX).toBeLessThan(BAR_CART.w / 2);
    // The spots stand clear of the stools, south of them, between the stools and the break area's own south edge.
    expect(BAR_SPOT_OUT).toBeGreaterThan(BAR_STOOL_OUT);
  });

  it("stands the biliardino table near the break area's east edge, with its v1 handle spots, one per side, facing each other across it", () => {
    const rect = layoutPlan({ blocks: 1, roomCols: 1 }).breakArea;
    const c = foosballCenter(rect);
    const spots = foosballSpots(rect);
    expect(spots).toEqual([
      { x: c.x, z: c.z - FOOSBALL.d / 2 - FOOSBALL_OUT, facing: 0 },
      { x: c.x, z: c.z + FOOSBALL.d / 2 + FOOSBALL_OUT, facing: Math.PI },
    ]);
    for (const s of spots) {
      expect(s.x).toBeGreaterThan(rect.x);
      expect(s.x).toBeLessThan(rect.x + rect.w);
      expect(s.z).toBeGreaterThan(rect.y);
      expect(s.z).toBeLessThan(rect.y + rect.h);
    }
    // Far enough from the cart's ring that walking between them never crosses the other's spots.
    for (const cart of barCartSpots(rect)) for (const s of spots) expect(dist(cart, s)).toBeGreaterThan(1);
  });

  it("stands the coffee machine (OQ-3) at the break area's own centre, midway between the cart and the table, with a single stand spot south of it, facing it", () => {
    const rect = layoutPlan({ blocks: 1, roomCols: 1 }).breakArea;
    const c = coffeeMachineCenter(rect);
    expect(c).toEqual({ x: rect.x + rect.w / 2, z: rect.y + rect.h / 2 });
    const spots = coffeeMachineSpots(rect);
    expect(spots).toEqual([{ x: c.x, z: c.z + COFFEE_MACHINE.d / 2 + COFFEE_MACHINE_OUT, facing: Math.PI }]);
    for (const s of spots) {
      expect(s.x).toBeGreaterThan(rect.x);
      expect(s.x).toBeLessThan(rect.x + rect.w);
      expect(s.z).toBeGreaterThan(rect.y);
      expect(s.z).toBeLessThan(rect.y + rect.h);
    }
    // Far enough from the cart's and the table's own spots that walking to any of the three never crosses another's.
    for (const other of [...barCartSpots(rect), ...foosballSpots(rect)]) for (const s of spots) expect(dist(other, s)).toBeGreaterThan(1);
  });

  it('steps out of the elevator in the middle of the core, just inside the doors, facing south', () => {
    const core = layoutPlan({ blocks: 1, roomCols: 1 }).core;
    expect(elevatorSpot(core)).toEqual({ x: core.x + core.w / 2, z: ELEVATOR_STEP, facing: 0 });
    expect(ELEVATOR_STEP).toBeLessThan(core.y);
  });

  it('stands the core\'s plants in its south corners, and gives the shell and the walk grid one size for each piece they share', () => {
    const core = layoutPlan({ blocks: 1, roomCols: 1 }).core;
    expect(plantSpots(core)).toEqual([
      { x: core.x + PLANT_IN, z: core.y + core.h - PLANT_IN },
      { x: core.x + core.w - PLANT_IN, z: core.y + core.h - PLANT_IN },
    ]);
    expect(plantSpots(core)).toEqual([{ x: 2.5, z: 3.5 }, { x: 5.5, z: 3.5 }]);
    expect(DESK_TOP).toEqual({ w: 1.6, d: 0.8 });
    // A desk chair runs from 0.53 m to 1.065 m from the desk top's centre toward the chair.
    expect(DESK_CHAIR).toEqual({ w: 0.5, seat: 0.5, back: 0.07, backZ: 1.03 });
    expect([CHAIR_Z - DESK_CHAIR.seat / 2, DESK_CHAIR.backZ + DESK_CHAIR.back / 2]).toEqual([0.53, 1.065]);
    expect(ROOM_SEAT).toBe(0.46);
    expect([COUCH_BACK, COUCH_ARM]).toEqual([0.26, 0.26]);
    expect(COUCH.w + COUCH_ARM).toBeCloseTo(2.86, 12);
    expect(BEANBAG_SCALE).toEqual({ across: 1.05, up: 0.55 });
  });

  it('places a robot where its occupant is: at its desk by pose, on its lounge seat, at the head of its room, nowhere when gone', () => {
    const plan = layoutPlan({ blocks: 1, roomCols: 2 });
    const floor = { lounge: { rect: plan.lounge, seats: LOUNGE_SEATS }, roomSlots: plan.rooms };
    const desk = plan.pods[0]!.desks[1]!;
    for (const state of ['working', 'in_meeting', 'no_signal', 'idle'] as const) expect(placeSpot(floor, desk, who(state, { kind: 'desk' })), state).toEqual(seatSpot(desk));
    for (const state of ['needs_you', 'done'] as const) expect(placeSpot(floor, desk, who(state, { kind: 'desk' })), state).toEqual(standSpot(desk));
    expect(placeSpot(floor, desk, who('idle', { kind: 'lounge', seat: 6 }))).toEqual(loungeSpots(plan.lounge)[6]);
    expect(placeSpot(floor, desk, who('in_meeting', { kind: 'room', slot: 3 }))).toEqual(headSpot(plan.rooms[3]!));
    expect(placeSpot(floor, desk, who('dormant', { kind: 'gone' }))).toBeNull();
    // Nowhere to be: no desk, a seat or a slot the floor does not have.
    expect(placeSpot(floor, null, who('working', { kind: 'desk' }))).toBeNull();
    expect(placeSpot(floor, desk, who('idle', { kind: 'lounge', seat: LOUNGE_SEATS }))).toBeNull();
    expect(placeSpot({ ...floor, roomSlots: plan.rooms.slice(0, 2) }, desk, who('in_meeting', { kind: 'room', slot: 3 }))).toBeNull();
  });

  it('hangs a desk label above its robot wherever it is, or above the monitor when its robot has gone', () => {
    const plan = layoutPlan({ blocks: 1, roomCols: 1 });
    const floor = { lounge: { rect: plan.lounge, seats: LOUNGE_SEATS }, roomSlots: plan.rooms };
    const label = (state: Occupant['state'], at: Place = { kind: 'desk' }) => labelAnchor(floor, SOUTH, who(state, at));
    expect(label('working')).toEqual({ ...pick(seatSpot(SOUTH)), y: LABEL_Y.seated });
    expect(label('needs_you')).toEqual({ ...pick(standSpot(SOUTH)), y: LABEL_Y.standing });
    expect(label('idle', { kind: 'lounge', seat: 7 })).toEqual({ ...pick(loungeSpots(plan.lounge)[7]!), y: LABEL_Y.seated });
    expect(label('in_meeting', { kind: 'room', slot: 1 })).toEqual({ ...pick(headSpot(plan.rooms[1]!)), y: LABEL_Y.seated });
    expect(label('dormant', { kind: 'gone' })).toEqual({ x: 4, y: LABEL_Y.empty, z: 7.6 });
    expect(labelAnchor(floor, NORTH, who('dormant', { kind: 'gone' }))).toEqual({ x: 4, y: LABEL_Y.empty, z: 8.4 });
    expect(placardAnchor({ x: 2, y: 6, w: 4, h: 4 })).toEqual({ x: 2.2, y: 0.02, z: 9.85 });
  });

  it('places the camera on a sphere around its target, and reads the azimuth and the tilt back', () => {
    const o = cameraOffset(HOME_AZIMUTH);
    expect(Math.hypot(o.x, o.y, o.z)).toBeCloseTo(CAMERA_DISTANCE, 10);
    expect(o.y).toBeCloseTo(CAMERA_DISTANCE * Math.cos(POLAR), 10);
    expect(o.x).toBeCloseTo(o.z, 10);
    expect(o.x).toBeGreaterThan(0);
    for (const a of [HOME_AZIMUTH, HOME_AZIMUTH + QUARTER, -HOME_AZIMUTH, -3 * HOME_AZIMUTH]) {
      expect(azimuthOf(cameraOffset(a))).toBeCloseTo(a, 10);
    }
    expect(polarOf(o)).toBeCloseTo(POLAR, 10);
    for (const p of [0.2, 0.7, 1.3]) {
      const tilted = cameraOffset(HOME_AZIMUTH + QUARTER, p);
      expect(Math.hypot(tilted.x, tilted.y, tilted.z)).toBeCloseTo(CAMERA_DISTANCE, 10);
      expect(polarOf(tilted)).toBeCloseTo(p, 10);
      expect(azimuthOf(tilted)).toBeCloseTo(HOME_AZIMUTH + QUARTER, 10);
    }
  });

  it('frames the whole floor, wall tops included, for a wide and a square view', () => {
    const size = { w: 24, h: 16 };
    // From home, the floor spans (w + h) / sqrt 2 across the screen; the back wall tops set the height.
    const halfW = 20 / Math.SQRT2;
    const halfH = (20 / Math.SQRT2) * Math.cos(POLAR) + 2.6 * Math.sin(POLAR);
    const wide = frustumFor(size, 2);
    expect(wide.top).toBeCloseTo(halfH * FRAME_MARGIN, 10);
    expect(wide.bottom).toBeCloseTo(-wide.top, 10);
    expect(wide.right).toBeCloseTo(2 * wide.top, 10);
    expect(wide.left).toBeCloseTo(-wide.right, 10);
    const square = frustumFor(size, 1);
    expect(square.right).toBeCloseTo(halfW * FRAME_MARGIN, 10);
    expect(square.top).toBeCloseTo(square.right, 10);
  });

  it('gives the same frustum from every quarter turn, and spans the floor width looking north', () => {
    const size = { w: 22, h: 12 };
    const home = frustumFor(size, 1.6);
    for (let k = 1; k < 4; k++) {
      const turned = frustumFor(size, 1.6, HOME_AZIMUTH + k * QUARTER);
      expect(turned.right).toBeCloseTo(home.right, 10);
      expect(turned.top).toBeCloseTo(home.top, 10);
    }
    expect(frustumFor(size, 0.5, 0).right).toBeCloseTo((22 / 2) * FRAME_MARGIN, 10);
    expect(frustumFor(size, 0).right).toBeCloseTo(frustumFor(size, 1).right, 10);
  });

  it('cuts away the two walls that face the camera, in all four quadrants', () => {
    expect(visibleWalls(HOME_AZIMUTH)).toEqual({ north: true, east: false, south: false, west: true });
    expect(visibleWalls(HOME_AZIMUTH + QUARTER)).toEqual({ north: false, east: false, south: true, west: true });
    expect(visibleWalls(HOME_AZIMUTH + 2 * QUARTER)).toEqual({ north: false, east: true, south: true, west: false });
    expect(visibleWalls(HOME_AZIMUTH - QUARTER)).toEqual({ north: true, east: true, south: false, west: false });
    expect(visibleWalls(HOME_AZIMUTH + 4 * QUARTER)).toEqual(visibleWalls(HOME_AZIMUTH));
  });

  it('keeps side walls when the camera looks straight along them', () => {
    expect(visibleWalls(0)).toEqual({ north: true, east: true, south: false, west: true });
  });

  it('sizes the sun shadow to the floor', () => {
    expect(shadowExtent({ w: 22, h: 12 })).toBe(14);
    expect(shadowExtent({ w: 16, h: 30 })).toBe(18);
  });
});

describe('meeting rooms', () => {
  /** The demo's room: east of the checkouts, at the top of the wing. */
  const ROOM = { x: 22, y: 2, w: 8, h: 6 };
  const inside = (p: Point) => p.x > ROOM.x && p.x < ROOM.x + ROOM.w && p.z > ROOM.y && p.z < ROOM.y + ROOM.h;

  it('stands the table in the middle of the room, a little south of its centre, away from the whiteboard', () => {
    const t = tableCenter(ROOM);
    expect(t.x).toBe(26);
    expect(t.z).toBeGreaterThan(5);
    expect(t.z - TABLE.d / 2).toBeGreaterThan(ROOM.y + 1.5);
    expect(t.z + TABLE.d / 2).toBeLessThan(ROOM.y + ROOM.h - 1.5);
    expect(t.x - TABLE.w / 2).toBeGreaterThan(ROOM.x + 1.5);
    expect(t.x + TABLE.w / 2).toBeLessThan(ROOM.x + ROOM.w - 1);
  });

  it('seats four agents on the north side and four on the south, in facing pairs from the head end, each facing the table', () => {
    const t = tableCenter(ROOM);
    const seats = seatSpots(ROOM);
    expect(seats).toHaveLength(SEATS_MAX);
    const north = seats.filter((s) => s.z < t.z);
    const south = seats.filter((s) => s.z > t.z);
    expect([north.length, south.length]).toEqual([4, 4]);
    // North seats look south across the table, south seats look north.
    for (const s of north) expect([s.facing, s.z]).toEqual([0, t.z - TABLE.d / 2 - 0.45]);
    for (const s of south) expect([s.facing, s.z]).toEqual([Math.PI, t.z + TABLE.d / 2 + 0.45]);
    // Agents take a north seat, then the one facing it, from the west end east.
    expect(seats.map((s) => (s.z < t.z ? 'N' : 'S')).join('')).toBe('NSNSNSNS');
    for (let k = 0; k < 4; k++) expect(seats[2 * k]!.x).toBe(seats[2 * k + 1]!.x);
    expect(north.map((s) => s.x)).toEqual([24.5, 25.5, 26.5, 27.5]);
    for (const s of seats) {
      expect(inside(s)).toBe(true);
      expect(Math.abs(s.x - t.x)).toBeLessThan(TABLE.w / 2);
    }
  });

  it('puts the head seat at the west end of the table, facing east along it', () => {
    const t = tableCenter(ROOM);
    const head = headSpot(ROOM);
    expect(head).toEqual({ x: t.x - TABLE.w / 2 - 0.45, z: t.z, facing: Math.PI / 2 });
    expect(inside(head)).toBe(true);
    for (const s of seatSpots(ROOM)) expect(head.x).toBeLessThan(s.x - 1);
  });

  it('opens the door in the middle of the west partition, clear of the head seat', () => {
    const door = doorGap(ROOM);
    expect((door.from + door.to) / 2).toBe(ROOM.y + ROOM.h / 2);
    expect(door.to - door.from).toBeCloseTo(DOOR_W, 10);
    expect(door.from).toBeGreaterThan(ROOM.y);
    expect(door.to).toBeLessThan(ROOM.y + ROOM.h);
    expect(headSpot(ROOM).x - ROOM.x).toBeGreaterThan(1);
  });

  it('puts the whiteboard anchor point on the inside of the north partition, at the top of the board', () => {
    const a = boardAnchor(ROOM);
    expect(a.x).toBe(ROOM.x + ROOM.w / 2);
    expect(a.y).toBe(BOARD.y + BOARD.h / 2);
    expect(a.y).toBeLessThan(PARTITION_H);
    expect(a.z).toBeGreaterThan(ROOM.y + PARTITION_T);
    expect(a.z).toBeLessThan(ROOM.y + 0.2);
    expect(BOARD.w).toBeLessThan(ROOM.w);
  });

  it("gives the whiteboard's own four corners, level and square on its north partition, in front of boardAnchor's point", () => {
    const c = boardCorners(ROOM);
    expect(c.tl).toEqual({ x: ROOM.x + ROOM.w / 2 - BOARD.w / 2, y: BOARD.y + BOARD.h / 2, z: c.tl.z });
    expect(c.tr).toEqual({ x: ROOM.x + ROOM.w / 2 + BOARD.w / 2, y: BOARD.y + BOARD.h / 2, z: c.tl.z });
    expect(c.bl).toEqual({ x: c.tl.x, y: BOARD.y - BOARD.h / 2, z: c.tl.z });
    expect(c.br).toEqual({ x: c.tr.x, y: c.bl.y, z: c.tl.z });
    // All four corners sit on the same plane, just off the partition, exactly where boardAnchor's own point stands
    // (both derive PARTITION_T + 0.05 from the board mesh's own centre and depth, props.ts's buildRoom): a looser
    // check here would let the two drift apart by a centimetre or more without either test noticing.
    expect(c.tl.z).toBeGreaterThan(ROOM.y + PARTITION_T);
    expect(c.tl.z).toBe(boardAnchor(ROOM).z);
  });

  it("faces the whiteboard's normal toward the camera when it stands on the board's own south side, not edge-on or behind it", () => {
    expect(facesCamera(BOARD_NORMAL, { x: 0, y: 1, z: 1 })).toBe(true);
    expect(facesCamera(BOARD_NORMAL, { x: 0, y: 1, z: 0 })).toBe(false);
    expect(facesCamera(BOARD_NORMAL, { x: 0, y: 1, z: -1 })).toBe(false);
  });

  it('hangs the room tag over the door', () => {
    const door = doorGap(ROOM);
    const a = roomTagAnchor(ROOM);
    expect(a.z).toBe((door.from + door.to) / 2);
    expect(a.x).toBeCloseTo(ROOM.x + PARTITION_T / 2, 10);
    expect(a.y).toBeGreaterThan(PARTITION_H);
  });

  it("leans a room's full-detail card away from a neighbour sharing its row, and not at all without one", () => {
    // No other room at all: no row neighbour to lean away from.
    expect(cardLean(ROOM, [])).toBe(0);
    expect(cardLean(ROOM, [ROOM])).toBe(0);
    // A second room east of it, in the same row (their y-extents overlap): lean west, away from it.
    const east = { ...ROOM, x: ROOM.x + ROOM.w + 2 };
    expect(cardLean(ROOM, [ROOM, east])).toBe(-1);
    expect(cardLean(east, [ROOM, east])).toBe(1);
    // A room directly south, in its own column (layoutPlan's room slots stack two rooms, same x): no row overlap,
    // so no lean either, even though the two rooms are neighbours in the wing.
    const south = { ...ROOM, y: ROOM.y + ROOM.h + 1 };
    expect(cardLean(ROOM, [ROOM, south])).toBe(0);
    // Two neighbours, one either side: leans away from whichever centre sits nearer.
    const far = { ...ROOM, x: ROOM.x + ROOM.w + 40 };
    expect(cardLean(ROOM, [ROOM, east, far])).toBe(-1);
  });

  it("hangs a room's full-detail card above it, leaning off its centre the way cardLean says", () => {
    const east = { ...ROOM, x: ROOM.x + ROOM.w + 2 };
    const a = cardAnchor(ROOM, [ROOM, east]);
    expect(a.y).toBe(CARD_Y);
    expect(a.y).toBeGreaterThan(PARTITION_H);
    expect(a.x).toBe(ROOM.x + ROOM.w / 2 - CARD_LEAN);
    expect(a.z).toBe(ROOM.y + ROOM.h / 2);
    // No neighbour in its row: the card hangs centred, dead above the room.
    expect(cardAnchor(ROOM, []).x).toBe(ROOM.x + ROOM.w / 2);
  });

  it('keys a room by its host and its run, so the rooms of one run under two hosts stay apart', () => {
    const a = { hostSessionId: 'host-a', runId: 'wf_0000aaaa-001' };
    expect(roomKey(a)).toBe(roomKey({ ...a }));
    expect(roomKey(a)).not.toBe(roomKey({ ...a, hostSessionId: 'host-b' }));
    expect(roomKey({ hostSessionId: 'a b', runId: 'c' })).not.toBe(roomKey({ hostSessionId: 'a', runId: 'b c' }));
  });
});

function pick(s: { x: number; z: number }): { x: number; z: number } {
  return { x: s.x, z: s.z };
}

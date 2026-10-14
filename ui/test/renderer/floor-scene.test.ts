import { describe, expect, it } from 'vitest';
import { Box3, Color, Matrix4, Mesh, Vector3, type BufferGeometry, type Material } from 'three';
import { CONTACT_Y, FloorScene, layoutSignature } from '../../renderer/floor-scene';
import type { Piece } from '../../renderer/furniture';
import { BURST_GAP_MS, DOOR_HOLD_MS, DOOR_MS, FLY_SPEED, WALK_SPEED, startTrip, tripAt, tripEnd, type Trip } from '../../renderer/motion';
import { DESK_OFF, Materials, SCREEN_GLASS } from '../../renderer/materials';
import { DOOR_PANEL, DOOR_SLIDE, Geometries } from '../../renderer/props';
import { HOVER_Y, KIND_SCALE, POSES, STRIDE, animateRobot, buildRobot, phaseOf, poseRobot, rootHeight, type RobotObject } from '../../renderer/robot';
import { WALK_CELL, findPath, walkGrid, type WalkGrid } from '../../renderer/walk';
import { dayTheme } from '../../renderer/theme';
import type { Intern, Robot } from '../../../src/scene/types';
import type { Target } from '../../renderer/index';
import {
  HOME_AZIMUTH,
  LABEL_Y,
  deskAnchor,
  elevatorSpot,
  headSpot,
  internSpots,
  labelAnchor,
  loungeSpots,
  roomKey,
  seatSpot,
  seatSpots,
  shadowExtent,
  standSpot,
  tableCenter,
  type Point,
} from '../../renderer/world';
import { checkoutFloor, checkoutSpecs, checkoutRooms, makeFloor, roomFloor, seatOf, seatsOf, type CheckoutSpec } from './fixtures';

/** The checkout floor after a change: sw-a1 needs you, sw-c3 left and sw-x9 sat down at its desk. */
function changedCheckouts(): CheckoutSpec[] {
  const checkouts = checkoutSpecs();
  checkouts[0]!.desks = [
    { id: 'sw-a1', state: 'needs_you', agents: 1 },
    { id: 'sw-b2', state: 'done' },
    { id: 'sw-x9', state: 'working' },
  ];
  return checkouts;
}

/** The checkout floor with sw-c3, idle, resting on lounge seat 2. */
function loungeFloor() {
  const checkouts = checkoutSpecs();
  checkouts[0]!.desks[2] = { ...checkouts[0]!.desks[2]!, lounge: 2 };
  return makeFloor(checkouts);
}

const deskTarget = (id: string): Target => ({ kind: 'desk', id });
const roomTarget = (id: string): Target => ({ kind: 'room', id });
/** Where a robot stands and the way it faces, as a spot lists them. */
const at = (o: { group: { position: { x: number; z: number }; rotation: { y: number } } }) => [o.group.position.x, o.group.position.z, o.group.rotation.y];
const spot = (s: { x: number; z: number; facing: number }) => [s.x, s.z, s.facing];
/** Where a piece of furniture stands in the world. */
const matrixOf = (piece: Piece) => new Matrix4().multiplyMatrices(piece.mesh!.matrixWorld, piece.mesh!.getMatrixAt(piece.index, new Matrix4()));
/** A colour's channels, to the millionth: instanced meshes keep colours in 32-bit floats. */
const rgb = (c: Color) => c.toArray().map((v) => Math.round(v * 1e6) / 1e6);
/** The colour a piece is given over its material. */
const paintOf = (piece: Piece) => rgb(piece.mesh!.getColorAt(piece.index, new Color()));

function sceneOf(floor = checkoutFloor()) {
  const fs = new FloorScene(dayTheme());
  fs.apply(floor);
  return fs;
}

describe('the floor scene', () => {
  it('builds the shell with every desk of the plan, and a robot per session on the floor, under two lights', () => {
    const fs = sceneOf();
    const floor = checkoutFloor();
    expect(fs.shell).not.toBeNull();
    expect(fs.shell!.group.parent).toBe(fs.scene);
    expect([...fs.shell!.desks.keys()]).toEqual(floor.pods.flatMap((p) => p.desks.map((d) => d.id)));
    expect(fs.shell!.desks.size).toBe(16);
    expect([...fs.sessions.keys()]).toEqual(seatsOf(floor).map((s) => s.occupant.sessionId));
    for (const entry of fs.sessions.values()) {
      expect(entry.robot !== null, entry.occupant.state).toBe(entry.occupant.state !== 'dormant');
      if (entry.robot) expect(entry.robot.group.parent).toBe(fs.scene);
    }
    expect(fs.hemi.parent).toBe(fs.scene);
    expect(fs.sun.parent).toBe(fs.scene);
    expect(fs.sun.castShadow).toBe(true);
  });

  it('turns each desk to face its chair, lights its screen by its occupant, leaves a free desk dark and dims a dormant one', () => {
    const fs = sceneOf();
    fs.scene.updateMatrixWorld(true);
    for (const desk of checkoutFloor().pods.flatMap((p) => p.desks)) {
      const obj = fs.shell!.desks.get(desk.id)!;
      const a = deskAnchor(desk);
      const top = new Vector3().setFromMatrixPosition(matrixOf(obj.top));
      expect([top.x, top.z], desk.id).toEqual([expect.closeTo(a.x, 6), expect.closeTo(a.z, 6)]);
      // The screen faces the chair: the desk is turned round when its chair is on the north edge.
      expect(new Vector3(0, 0, 1).transformDirection(matrixOf(obj.screen)).z, desk.id).toBeCloseTo(desk.chair === 'north' ? -1 : 1, 6);
      expect(paintOf(obj.screen), desk.id).toEqual(rgb(fs.mats.screenColor(desk.occupant?.state ?? 'idle')));
      expect(paintOf(obj.top), desk.id).toEqual(desk.occupant?.state === 'dormant' ? [DESK_OFF, DESK_OFF, DESK_OFF] : [1, 1, 1]);
    }
    expect(paintOf(fs.shell!.desks.get('p0-3')!.screen)).toEqual(rgb(new Color(SCREEN_GLASS)));
  });

  it('keeps unchanged robots, places a changed one where it now belongs, adds the new and drops the gone', () => {
    const fs = sceneOf();
    const before = new Map([...fs.sessions].map(([id, e]) => [id, e.robot]));
    const gone = fs.sessions.get('sw-c3')!;
    expect(fs.apply(makeFloor(changedCheckouts()))).toBe(false);
    expect(fs.sessions.get('sw-b2')!.robot).toBe(before.get('sw-b2'));
    const changed = fs.sessions.get('sw-a1')!;
    expect(changed.robot).toBe(before.get('sw-a1'));
    expect(paintOf(fs.shell!.desks.get(changed.desk!.id)!.screen)).toEqual(rgb(fs.mats.screenColor('needs_you')));
    expect(at(changed.robot!)).toEqual(spot(standSpot(changed.desk!)));
    expect(fs.sessions.has('sw-c3')).toBe(false);
    expect(gone.robot!.group.parent).toBeNull();
    const fresh = fs.sessions.get('sw-x9')!;
    expect(fresh.desk!.id).toBe(gone.desk!.id);
    expect(fresh.robot!.group.parent).toBe(fs.scene);
    expect(at(fresh.robot!)).toEqual(spot(seatSpot(fresh.desk!)));
  });

  it('rebuilds the shell only when the plan grows, and frees the old one', () => {
    const fs = sceneOf();
    const shell = fs.shell!;
    expect(fs.apply(checkoutFloor())).toBe(false);
    expect(fs.apply(makeFloor(changedCheckouts()))).toBe(false);
    expect(fs.apply(roomFloor())).toBe(false);
    expect(fs.shell).toBe(shell);
    const slab = shell.group.children.find((c) => c instanceof Mesh && c.material === fs.mats.surface.floor) as Mesh;
    let freed = false;
    slab.geometry.addEventListener('dispose', () => (freed = true));
    // Nine sessions of one checkout take three pods: with the other two checkouts', the plan grows to three blocks.
    const grown = checkoutSpecs();
    grown[0]!.desks = Array.from({ length: 9 }, (_, k) => ({ id: `sw-${k}`, state: 'working' as const }));
    expect(fs.apply(makeFloor(grown))).toBe(true);
    expect(fs.shell).not.toBe(shell);
    expect(fs.shell!.desks.size).toBe(24);
    expect(shell.group.parent).toBeNull();
    expect(freed).toBe(true);
  });

  it('keeps no geometry of an old shell, however often the shell is rebuilt', () => {
    const floorOf = (count: number) =>
      makeFloor([
        { key: '/a', repo: 'a', color: 0, tie: 0, desks: Array.from({ length: count }, (_, k) => ({ id: `d${k}`, state: 'working' as const })) },
        { key: '/b', repo: 'b', color: 1, tie: 1, desks: [{ id: 'b0', state: 'idle' }] },
      ]);
    const fs = sceneOf(floorOf(1));
    for (let n = 2; n <= 28; n++) fs.apply(floorOf(n));
    for (let n = 27; n >= 1; n--) fs.apply(floorOf(n));
    expect(fs.geo.size).toBe(sceneOf(floorOf(1)).geo.size);
  });

  it('signs the layout by footprint, core, pods, the lounge and the room slots only', () => {
    const a = checkoutFloor();
    expect(layoutSignature(makeFloor(changedCheckouts()))).toBe(layoutSignature(a));
    const recoloured = checkoutSpecs();
    recoloured[0]!.color = 6;
    expect(layoutSignature(makeFloor(recoloured))).toBe(layoutSignature(a));
    // Rooms open and close in their slots: the plan stays as it was until a third run opens the second column.
    expect(layoutSignature(roomFloor())).toBe(layoutSignature(a));
    const third = roomFloor([...checkoutRooms(), { runId: 'wf_0000aaaa-003', host: 'oa-c3', slot: 2 }]);
    expect(layoutSignature(third)).not.toBe(layoutSignature(a));
    const moved = checkoutFloor();
    moved.lounge = { ...moved.lounge, rect: { ...moved.lounge.rect, y: moved.lounge.rect.y + 1 } };
    expect(layoutSignature(moved)).not.toBe(layoutSignature(a));
  });

  it('colours each pod\'s rug and lamp in place: the repo colour while its occupants share one, neutral otherwise', () => {
    const fs = sceneOf();
    const pods = fs.shell!.pods;
    expect([...pods.keys()]).toEqual(['p0', 'p1', 'p2', 'p3']);
    expect([pods.get('p0')!.rug.material, pods.get('p0')!.shade.material]).toEqual([fs.mats.rug(2), fs.mats.body(2)]);
    expect([pods.get('p3')!.rug.material, pods.get('p3')!.shade.material]).toEqual([fs.mats.surface.rug, fs.mats.surface.base]);
    const rug = pods.get('p0')!.rug;
    const recoloured = checkoutSpecs();
    recoloured[0]!.color = 6;
    expect(fs.apply(makeFloor(recoloured))).toBe(false);
    expect(fs.shell!.pods.get('p0')!.rug).toBe(rug);
    expect(rug.material).toBe(fs.mats.rug(6));
    const mixed = checkoutFloor();
    mixed.pods[0]!.color = null;
    fs.apply(mixed);
    expect(rug.material).toBe(fs.mats.surface.rug);
  });

  it('rebuilds a robot for new colours, sends it home when its session goes dormant, and back again', () => {
    const fs = sceneOf();
    const robot = fs.sessions.get('sw-a1')!.robot!;
    const recoloured = checkoutSpecs();
    recoloured[0]!.color = 6;
    fs.apply(makeFloor(recoloured));
    const next = fs.sessions.get('sw-a1')!.robot!;
    expect(next).not.toBe(robot);
    expect(robot.group.parent).toBeNull();
    expect(next.body).toBe(6);
    const asleep = checkoutSpecs();
    asleep[0]!.desks[0]!.state = 'dormant';
    fs.apply(makeFloor(asleep));
    expect(fs.sessions.get('sw-a1')!.robot).toBeNull();
    expect(next.group.parent).toBeNull();
    fs.apply(checkoutFloor());
    expect(fs.sessions.get('sw-a1')!.robot!.group.parent).toBe(fs.scene);
  });

  it('keeps one robot per session wherever its occupant is: at its desk, resting in the lounge, at the head of its room', () => {
    const fs = sceneOf();
    const rest = fs.sessions.get('sw-c3')!;
    const robot = rest.robot!;
    expect(at(robot)).toEqual(spot(seatSpot(rest.desk!)));
    const lounge = loungeFloor();
    fs.apply(lounge);
    expect(rest.robot).toBe(robot);
    expect(robot.group.parent).toBe(fs.scene);
    expect(at(robot)).toEqual(spot(loungeSpots(lounge.lounge.rect)[2]!));
    fs.apply(checkoutFloor());
    expect(at(robot)).toEqual(spot(seatSpot(rest.desk!)));
    // ps-d4 meets in the first room: its own robot sits at the head of the table, and no other robot stands for it.
    const rooms = roomFloor();
    fs.apply(rooms);
    const host = fs.sessions.get('ps-d4')!;
    expect(at(host.robot!)).toEqual(spot(headSpot(rooms.roomSlots[0]!)));
    expect(fs.scene.children.filter((o) => o.name === 'robot ps-d4')).toEqual([host.robot!.group]);
  });

  it('has no robot for a session that waits for a desk, and removes the robot of one that leaves the floor', () => {
    const fs = sceneOf(makeFloor(checkoutSpecs(), undefined, [], [{ id: 'sw-w1', state: 'working' }]));
    const waiting = fs.sessions.get('sw-w1')!;
    expect([waiting.desk, waiting.robot, fs.focusPoint(deskTarget('sw-w1'))]).toEqual([null, null, null]);
    const robot = fs.sessions.get('oa-d5')!.robot!;
    const checkouts = checkoutSpecs();
    checkouts[1]!.desks.pop();
    fs.apply(makeFloor(checkouts));
    expect([fs.sessions.has('oa-d5'), fs.sessions.has('sw-w1'), robot.group.parent]).toEqual([false, false, null]);
  });

  it('lets a click on a desk pick the session at it, and its robot pick it wherever it stands; a free desk picks nothing', () => {
    const fs = sceneOf(roomFloor());
    const picks = new Set(fs.pickables());
    for (const { desk, occupant } of seatsOf(roomFloor())) {
      const obj = fs.shell!.desks.get(desk.id)!;
      expect(obj.pickables.every((p) => picks.has(p.mesh!) && p.pick?.id === occupant.sessionId), desk.id).toBe(true);
    }
    const free = fs.shell!.desks.get('p0-3')!;
    expect(free.pickables.some((p) => p.pick)).toBe(false);
    const host = fs.sessions.get('ps-d4')!.robot!;
    expect(host.pickables.every((m) => picks.has(m))).toBe(true);
    expect(host.pickables[0]!.userData.pick).toEqual(deskTarget('ps-d4'));
    // A desk whose session leaves is free again, and picks nothing.
    const checkouts = checkoutSpecs();
    checkouts[0]!.desks.pop();
    fs.apply(makeFloor(checkouts, undefined, checkoutRooms()));
    const left = fs.shell!.desks.get('p0-2')!;
    expect(left.pickables.some((p) => p.pick)).toBe(false);
  });

  it('rings the selected session under its robot, or the chair of its desk when its robot has gone, and hides the ring otherwise', () => {
    const fs = sceneOf();
    expect(fs.ring.visible).toBe(false);
    fs.setSelected(deskTarget('oa-c3'));
    const stand = standSpot(fs.sessions.get('oa-c3')!.desk!);
    expect(fs.ring.visible).toBe(true);
    expect([fs.ring.position.x, fs.ring.position.z]).toEqual([stand.x, stand.z]);
    fs.setSelected(deskTarget('ps-f7'));
    const empty = seatSpot(fs.sessions.get('ps-f7')!.desk!);
    expect([fs.ring.position.x, fs.ring.position.z]).toEqual([empty.x, empty.z]);
    expect(fs.focusPoint(deskTarget('ps-f7'))).toEqual({ x: empty.x, z: empty.z });
    // In the lounge, the ring marks the robot there.
    fs.setSelected(deskTarget('sw-c3'));
    const lounge = loungeFloor();
    fs.apply(lounge);
    const seat = loungeSpots(lounge.lounge.rect)[2]!;
    expect([fs.ring.position.x, fs.ring.position.z]).toEqual([seat.x, seat.z]);
    fs.setSelected(deskTarget('nobody'));
    expect(fs.ring.visible).toBe(false);
    expect(fs.focusPoint(deskTarget('nobody'))).toBeNull();
    fs.setSelected(null);
    expect(fs.ring.visible).toBe(false);
  });

  it('outlines the selected room on its floor, and points the camera at its table', () => {
    const fs = sceneOf(roomFloor());
    const outline = fs.scene.getObjectByName('room-selection')!;
    expect(outline.visible).toBe(false);
    fs.setSelected(deskTarget('oa-c3'));
    fs.setSelected(roomTarget('wf_0000aaaa-002'));
    const second = fs.rooms.get(roomKey({ hostSessionId: 'sw-a1', runId: 'wf_0000aaaa-002' }))!.room;
    expect([outline.visible, fs.ring.visible]).toEqual([true, false]);
    expect(outline.position.x).toBe(second.rect.x);
    expect(outline.position.z).toBe(second.rect.y);
    expect(fs.focusPoint(roomTarget('wf_0000aaaa-002'))).toEqual(tableCenter(second.rect));
    // The outline runs inside the room's edges.
    outline.updateMatrixWorld(true);
    const box = new Box3().setFromObject(outline);
    expect(box.min.x).toBeGreaterThan(second.rect.x);
    expect(box.max.x).toBeLessThan(second.rect.x + second.rect.w);
    expect(box.min.z).toBeGreaterThan(second.rect.y);
    expect(box.max.z).toBeLessThan(second.rect.y + second.rect.h);
    expect(box.max.x - box.min.x).toBeGreaterThan(second.rect.w - 1);
    // It goes when the room closes.
    fs.apply(checkoutFloor());
    expect(outline.visible).toBe(false);
    expect(fs.focusPoint(roomTarget('wf_0000aaaa-002'))).toBeNull();
    fs.setSelected(null);
    expect([outline.visible, fs.ring.visible]).toEqual([false, false]);
  });

  it('keeps the selection across updates and drops the ring when the session leaves', () => {
    const fs = sceneOf();
    fs.setSelected(deskTarget('sw-c3'));
    fs.apply(checkoutFloor());
    expect(fs.ring.visible).toBe(true);
    fs.apply(makeFloor(changedCheckouts()));
    expect(fs.ring.visible).toBe(false);
  });

  it('cuts away the walls facing the camera, and keeps doing so after a rebuild', () => {
    const fs = sceneOf();
    const shown = () => Object.fromEntries(fs.shell!.walls.map((w) => [w.side, w.group.visible]));
    expect(shown()).toEqual({ north: true, east: false, south: false, west: true });
    expect(fs.setAzimuth(HOME_AZIMUTH + 0.2)).toBe(false);
    expect(fs.setAzimuth(HOME_AZIMUTH + Math.PI)).toBe(true);
    expect(shown()).toEqual({ north: false, east: true, south: true, west: false });
    expect(fs.apply(roomFloor([...checkoutRooms(), { runId: 'wf_0000aaaa-003', host: 'oa-c3', slot: 2 }]))).toBe(true);
    expect(shown()).toEqual({ north: false, east: true, south: true, west: false });
  });

  it('points the sun at the middle of the floor and fits its shadow to the floor', () => {
    const fs = sceneOf();
    const floor = checkoutFloor();
    expect(fs.sun.target.position.toArray()).toEqual([floor.size.w / 2, 0, floor.size.h / 2]);
    expect(fs.sun.shadow.camera.right).toBe(shadowExtent(floor.size));
  });

  it('recolours lights and materials in place on a theme change, and lights each screen in the new colour of its state', () => {
    const fs = sceneOf();
    const floorMat = fs.mats.surface.floor;
    const working = fs.shell!.desks.get(seatOf(checkoutFloor(), 'sw-a1').desk.id)!;
    const day = dayTheme();
    expect(paintOf(working.screen)).toEqual(rgb(new Color(day.colors['s-working']).multiplyScalar(day.numbers['screen-int'])));
    const night = dayTheme();
    night.colors['hemi-sky'] = '#8ea2d8';
    night.colors.sun = '#9db4ff';
    night.colors['scene-floor'] = '#3a3f55';
    night.colors['s-working'] = '#ffd27a';
    night.numbers['hemi-int'] = 0.6;
    night.numbers['sun-int'] = 0.55;
    night.numbers['screen-int'] = 2;
    fs.setTheme(night);
    expect(paintOf(working.screen)).toEqual(rgb(new Color('#ffd27a').multiplyScalar(2)));
    expect('#' + fs.hemi.color.getHexString()).toBe('#8ea2d8');
    expect('#' + fs.sun.color.getHexString()).toBe('#9db4ff');
    expect([fs.hemi.intensity, fs.sun.intensity]).toEqual([0.6, 0.55]);
    expect(fs.mats.surface.floor).toBe(floorMat);
    expect('#' + floorMat.color.getHexString()).toBe('#3a3f55');
  });

  it('frees every geometry and material it made on dispose', () => {
    const fs = sceneOf(roomFloor());
    expect(fs.rooms.size).toBe(2);
    const geometries = new Set<BufferGeometry>();
    const materials = new Set<Material>();
    fs.scene.traverse((o) => {
      if (o instanceof Mesh) {
        geometries.add(o.geometry);
        materials.add(o.material as Material);
      }
    });
    const freed = new Set<unknown>();
    for (const x of [...geometries, ...materials]) x.addEventListener('dispose', () => freed.add(x));
    fs.dispose();
    expect(freed.size).toBe(geometries.size + materials.size);
    expect(fs.scene.children).toHaveLength(0);
    expect(fs.sessions.size).toBe(0);
    expect(fs.rooms.size).toBe(0);
  });
});

describe('meeting rooms in the floor scene', () => {
  /** The scene's key of the n-th room of checkoutRooms(). */
  const keyOf = (n: number) => roomKey({ hostSessionId: checkoutRooms()[n]!.host, runId: checkoutRooms()[n]!.runId });
  const entryOf = (fs: FloorScene, n: number) => {
    const room = fs.rooms.get(keyOf(n))!;
    expect(room, `room ${n}`).toBeDefined();
    return room;
  };

  it('draws a room in every slot of the plan, open for each run that holds one and closed with its light down otherwise', () => {
    const fs = sceneOf(checkoutFloor());
    const rooms = fs.shell!.rooms;
    expect(rooms.map((r) => [r.slot, r.group.position.x, r.group.position.z])).toEqual(checkoutFloor().roomSlots.map((rect, slot) => [slot, rect.x, rect.y]));
    for (const r of rooms) expect([r.floor.material, r.door.visible, r.placard.visible]).toEqual([fs.mats.surface.roomDim, true, false]);
    fs.apply(roomFloor([checkoutRooms()[1]!]));
    expect(rooms.map((r) => [r.floor.material, r.door.visible])).toEqual([
      [fs.mats.surface.roomFloor, false],
      [fs.mats.surface.roomDim, true],
    ]);
    expect(fs.shell!.rooms).toBe(rooms);
  });

  it('seats the running agents at the table in hard hats, in floor coordinates, and puts the placard away while the host is at the head', () => {
    const fs = sceneOf(roomFloor());
    expect(fs.rooms.size).toBe(2);
    const first = entryOf(fs, 0);
    // Three agents run: each sits in its seat, in order, as a workflow robot in the room's colours.
    const seats = seatSpots(first.room.rect);
    expect([...first.agents.keys()]).toEqual(['wf_0000aaaa-001-a0', 'wf_0000aaaa-001-a1', 'wf_0000aaaa-001-a2']);
    [...first.agents.values()].forEach((robot, i) => {
      expect(robot.group.parent).toBe(fs.scene);
      expect([robot.kind, robot.group.scale.x, robot.body, robot.tie]).toEqual(['workflow', KIND_SCALE.workflow, first.room.look.body, first.room.look.tie]);
      expect(at(robot)).toEqual(spot(seats[i]!));
    });
    // ps-d4 is in the meeting, at the head: the placard is put away. sw-a1 works at its desk: its room shows the placard.
    expect(fs.shell!.rooms[0]!.placard.visible).toBe(false);
    const second = entryOf(fs, 1);
    expect(second.agents.size).toBe(8);
    expect(fs.shell!.rooms[1]!.placard.visible).toBe(true);
    expect(fs.scene.getObjectByName('agent wf_0000aaaa-002-a7')).toBeDefined();
    expect(fs.scene.getObjectByName('agent wf_0000aaaa-002-a8')).toBeUndefined();
  });

  it('keeps each agent that runs on in the seat it took, lets those that finish leave, and gives a freed seat to the next one', () => {
    const fs = sceneOf(roomFloor());
    const first = entryOf(fs, 0);
    const [a0, a1, a2] = [...first.agents.values()];
    const floor = roomFloor();
    const agents = floor.rooms[0]!.agents;
    // a0 finishes; a1 and a2 run on in their own seats: nobody moves up the table.
    floor.rooms[0] = { ...floor.rooms[0]!, agents: [agents[1]!, agents[2]!, { ...agents[0]!, running: false }, ...agents.slice(3)], counts: { running: 2, finished: 3 } };
    expect(fs.apply(floor)).toBe(false);
    const seats = seatSpots(first.room.rect);
    expect([...first.agents.values()]).toEqual([a1, a2]);
    expect([at(a1!), at(a2!)]).toEqual([spot(seats[1]!), spot(seats[2]!)]);
    expect(a0!.group.parent).toBeNull();
    // A new agent starts: it takes the seat a0 left.
    const next = { ...agents[0]!, agentId: 'wf_0000aaaa-001-a9' };
    floor.rooms[0] = { ...floor.rooms[0]!, agents: [agents[1]!, agents[2]!, next, { ...agents[0]!, running: false }, ...agents.slice(3)], counts: { running: 3, finished: 3 } };
    fs.apply(floor);
    expect([at(first.agents.get(next.agentId)!), at(a1!), at(a2!)]).toEqual([spot(seats[0]!), spot(seats[1]!), spot(seats[2]!)]);
  });

  it('brings the host back to its desk when it leaves the meeting, and puts the placard back', () => {
    const fs = sceneOf(roomFloor());
    const host = fs.sessions.get('ps-d4')!;
    const robot = host.robot!;
    const rooms = checkoutRooms();
    rooms[0] = { ...rooms[0]!, seated: false };
    fs.apply(roomFloor(rooms));
    expect(host.robot).toBe(robot);
    expect(at(robot)).toEqual(spot(seatSpot(host.desk!)));
    expect(fs.shell!.rooms[0]!.placard.visible).toBe(true);
  });

  it('rebuilds the robots of a room whose colours change', () => {
    const fs = sceneOf(roomFloor());
    const first = entryOf(fs, 0);
    const [before] = [...first.agents.values()];
    const floor = roomFloor();
    floor.rooms[0] = { ...floor.rooms[0]!, look: { body: 6, tie: 0 } };
    fs.apply(floor);
    const [after] = [...first.agents.values()];
    expect(after).not.toBe(before);
    expect(before!.group.parent).toBeNull();
    expect([after!.body, after!.tie]).toEqual([6, 0]);
  });

  it('closes the room of a run that ends in place, keeps the other in its slot, and lets the agents of the closed one go', () => {
    const fs = sceneOf(roomFloor());
    const agents = [...entryOf(fs, 0).agents.values()];
    const second = entryOf(fs, 1);
    const shell = fs.shell!;
    expect(fs.apply(roomFloor([{ ...checkoutRooms()[1]!, slot: 1 }]))).toBe(false);
    expect(fs.shell).toBe(shell);
    expect([fs.rooms.size, fs.rooms.get(keyOf(1)), second.room.slot]).toEqual([1, second, 1]);
    expect([shell.rooms[0]!.door.visible, shell.rooms[1]!.door.visible]).toEqual([true, false]);
    for (const a of agents) expect(a.group.parent).toBeNull();
    expect(fs.apply(checkoutFloor())).toBe(false);
    expect(fs.rooms.size).toBe(0);
  });

  it('lets a click on an open room, its table, its seats or its agents pick the room, and go through its glass and its door', () => {
    const fs = sceneOf(roomFloor());
    const picks = new Set(fs.pickables());
    const room = fs.shell!.rooms[0]!;
    const meshes: Mesh[] = [];
    room.group.traverse((o) => {
      if (o instanceof Mesh) meshes.push(o);
    });
    expect(meshes.length).toBeGreaterThan(30);
    const through = meshes.filter((m) => m.material === fs.mats.surface.glass || m === room.door);
    expect(through).toHaveLength(6);
    for (const m of meshes) {
      const skip = through.includes(m);
      expect([picks.has(m), m.userData.pick ?? null], m.name).toEqual(skip ? [false, null] : [true, roomTarget('wf_0000aaaa-001')]);
    }
    for (const agent of entryOf(fs, 0).agents.values()) expect(agent.pickables.every((m) => picks.has(m) && m.userData.pick?.id === 'wf_0000aaaa-001')).toBe(true);
    // A closed room picks nothing.
    fs.apply(checkoutFloor());
    const closed = new Set(fs.pickables());
    expect(meshes.some((m) => closed.has(m) || m.userData.pick)).toBe(false);
  });

  it('keeps no robot of a closed room, however often rooms open and close', () => {
    const fs = sceneOf(roomFloor());
    const count = () => {
      const names: string[] = [];
      fs.scene.traverse((o) => names.push(o.name.split(' ')[0]!));
      return { children: fs.scene.children.length, rooms: names.filter((n) => n === 'room').length, agents: names.filter((n) => n === 'agent').length };
    };
    const size = fs.geo.size;
    const open = count();
    fs.apply(checkoutFloor());
    const closed = count();
    expect([open.rooms, open.agents, closed.rooms, closed.agents]).toEqual([2, 11, 2, 0]);
    for (let n = 0; n < 5; n++) {
      fs.apply(checkoutFloor());
      expect(count()).toEqual(closed);
      fs.apply(roomFloor([{ ...checkoutRooms()[1]!, slot: 1 }]));
      fs.apply(roomFloor());
      expect(count()).toEqual(open);
    }
    expect(fs.geo.size).toBe(size);
  });

  it('places one robot per agent id, the first, however often a room that repeats an id is updated', () => {
    const floor = roomFloor();
    const room = floor.rooms[0]!;
    // Three agents that share one id, beside the others.
    room.agents = room.agents.map((a, i) => (i < 3 ? { ...a, agentId: 'same' } : a));
    const fs = sceneOf(floor);
    const agents = () => fs.scene.children.filter((o) => o.name.startsWith('agent wf_0000aaaa-001') || o.name === 'agent same').length;
    const first = agents();
    for (let i = 0; i < 5; i++) fs.apply(floor);
    expect([first, agents(), [...fs.rooms.values()][0]!.agents.size]).toEqual([1, 1, 1]);
  });

  it('takes away the interns of a session that leaves, also when two of them share an id', () => {
    const checkouts = checkoutSpecs();
    checkouts[0]!.desks[0] = { ...checkouts[0]!.desks[0]!, interns: ['same', 'same', 'other'].map((agentId) => ({ agentId, type: 'Explore', label: null, running: true })) };
    const fs = sceneOf(makeFloor(checkouts));
    for (let i = 0; i < 5; i++) fs.apply(makeFloor(checkouts));
    const interns = () => fs.scene.children.filter((o) => o.name.startsWith('intern ')).length;
    expect(interns()).toBe(2);
    checkouts[0]!.desks.shift();
    fs.apply(makeFloor(checkouts));
    expect(interns()).toBe(0);
  });

  it('outlines the first room of a run that two hosts name, in the order the floor lists them', () => {
    const rooms = checkoutRooms();
    const twin = { ...rooms[0]!, host: 'oa-c3', seated: false, slot: 2 };
    // The second host's room opens first; then the floor lists both, the first host's ahead.
    const fs = sceneOf(roomFloor([{ ...rooms[1]!, slot: 1 }, twin]));
    const floor = roomFloor([rooms[0]!, rooms[1]!, twin]);
    fs.apply(floor);
    fs.setSelected(roomTarget(rooms[0]!.runId));
    const first = floor.rooms[0]!;
    expect([fs.roomRing.visible, fs.roomRing.position.x, fs.roomRing.position.z]).toEqual([true, first.rect.x, first.rect.y]);
    expect(fs.focusPoint(roomTarget(rooms[0]!.runId))).toEqual(tableCenter(first.rect));
  });
});

describe('interns', () => {
  const intern = (agentId: string, running = true): Intern => ({ agentId, type: 'Explore', label: 'Find the callers', running });
  /** The checkout floor with these interns at sw-a1's desk, sw-a1 in this state, and on this lounge seat if given. */
  const withInterns = (interns: Intern[], state: CheckoutSpec['desks'][number]['state'] = 'working', lounge?: number) => {
    const checkouts = checkoutSpecs();
    checkouts[0]!.desks[0] = { ...checkouts[0]!.desks[0]!, state, interns, ...(lounge === undefined ? {} : { lounge }) };
    return makeFloor(checkouts);
  };

  it('flies the running interns over its desk, small and in its robot\'s colours, and none that finished', () => {
    const fs = sceneOf(withInterns([intern('i1'), intern('i2', false), intern('i3')]));
    const entry = fs.sessions.get('sw-a1')!;
    expect([...entry.interns.keys()]).toEqual(['i1', 'i3']);
    const spots = internSpots(entry.desk!);
    [...entry.interns.values()].forEach((robot, k) => {
      expect(robot.group.parent).toBe(fs.scene);
      expect([robot.kind, robot.body, robot.tie]).toEqual(['intern', entry.robot!.body, entry.robot!.tie]);
      expect(at(robot)).toEqual(spot(spots[k]!));
    });
    expect(fs.scene.getObjectByName('intern i3')).toBe(entry.interns.get('i3')!.group);
    expect(fs.sessions.get('sw-b2')!.interns.size).toBe(0);
  });

  it('lets a click on an intern pick its session', () => {
    const fs = sceneOf(withInterns([intern('i1')]));
    const robot = fs.sessions.get('sw-a1')!.interns.get('i1')!;
    const picks = new Set(fs.pickables());
    expect(robot.pickables.every((m) => picks.has(m))).toBe(true);
    expect(robot.pickables[0]!.userData.pick).toEqual(deskTarget('sw-a1'));
  });

  it('keeps each intern that flies on at the spot it took, gives a freed spot to the next, and lands the ones that finish or leave with their session', () => {
    const fs = sceneOf(withInterns([intern('i1'), intern('i2')]));
    const entry = fs.sessions.get('sw-a1')!;
    const [i1, i2] = [...entry.interns.values()];
    const spots = internSpots(entry.desk!);
    fs.apply(withInterns([intern('i1', false), intern('i2')]));
    expect([...entry.interns.values()]).toEqual([i2]);
    expect(at(i2!)).toEqual(spot(spots[1]!));
    expect(i1!.group.parent).toBeNull();
    fs.apply(withInterns([intern('i2'), intern('i3')]));
    expect([at(entry.interns.get('i3')!), at(i2!)]).toEqual([spot(spots[0]!), spot(spots[1]!)]);
    const checkouts = checkoutSpecs();
    checkouts[0]!.desks.shift();
    fs.apply(makeFloor(checkouts));
    expect(i2!.group.parent).toBeNull();
  });

  it('flies a new intern straight from the elevator to its spot, at hover height, and back out when it finishes', () => {
    const fs = sceneOf(withInterns([]));
    const floor = withInterns([intern('i1')]);
    fs.apply(floor, 1000);
    const entry = fs.sessions.get('sw-a1')!;
    const robot = entry.interns.get('i1')!;
    const to = internSpots(entry.desk!)[0]!;
    const elevator = elevatorSpot(floor.core);
    const flight = startTrip(elevator, [to], 1000 + DOOR_MS, FLY_SPEED);
    const where = () => [robot.group.visible, robot.group.position.x, robot.group.position.y, robot.group.position.z];
    expect(where()).toEqual([false, elevator.x, HOVER_Y, elevator.z]);
    fs.frame(1000 + DOOR_MS + 500);
    expect(where()).toEqual([true, tripAt(flight, 1000 + DOOR_MS + 500).x, HOVER_Y, tripAt(flight, 1000 + DOOR_MS + 500).z]);
    fs.frame(tripEnd(flight));
    expect([...where(), robot.group.rotation.y]).toEqual([true, to.x, HOVER_Y, to.z, to.facing]);
    // It finishes: it flies straight back to the elevator, and is gone once there.
    const t = tripEnd(flight) + 100;
    fs.apply(withInterns([intern('i1', false)]), t);
    expect(entry.interns.size).toBe(0);
    const back = startTrip(to, [elevator], t, FLY_SPEED);
    fs.frame(t + 300);
    expect(where()).toEqual([true, tripAt(back, t + 300).x, HOVER_Y, tripAt(back, t + 300).z]);
    fs.frame(tripEnd(back));
    expect(robot.group.parent).toBeNull();
  });

  it('lets a flying intern cast no shadow, and lays a small disc on the floor under it instead, unseen while it waits inside the elevator', () => {
    const fs = sceneOf(withInterns([]));
    fs.apply(withInterns([intern('i1')]), 1000);
    const robot = fs.sessions.get('sw-a1')!.interns.get('i1')!;
    const disc = fs.scene.children.find((o) => o.name === 'contact')!;
    expect(disc.visible).toBe(false);
    const step = fs.frame(1000 + DOOR_MS + 500);
    expect([disc.visible, disc.position.x, disc.position.y, disc.position.z, disc.scale.x]).toEqual([true, robot.group.position.x, CONTACT_Y, robot.group.position.z, KIND_SCALE.intern]);
    expect(step.shadows).toBe(false);
    // At its spot it casts no shadow either: the shadow map need not be drawn for it.
    expect(fs.frame(20_000).shadows).toBe(false);
    expect(robot.pickables.some((m) => m.castShadow)).toBe(false);
    expect(fs.scene.children.some((o) => o.name === 'contact')).toBe(false);
  });

  it('keeps the interns over the desk while their session rests in the lounge, and flies none for a dormant one', () => {
    const fs = sceneOf(withInterns([intern('i1')], 'idle', 0));
    const entry = fs.sessions.get('sw-a1')!;
    expect(at(entry.interns.get('i1')!)).toEqual(spot(internSpots(entry.desk!)[0]!));
    expect(at(entry.robot!)).not.toEqual(spot(seatSpot(entry.desk!)));
    fs.apply(withInterns([intern('i1')], 'dormant'));
    expect(entry.interns.size).toBe(0);
  });
});

describe('walking', () => {
  /** A walk over this floor, from `from` to `to`, setting off at `start`. */
  const walk = (floor: Parameters<typeof walkGrid>[0], from: Point, to: Point, start: number): Trip => startTrip(from, findPath(walkGrid(floor), from, to), start, WALK_SPEED);
  const xz = (o: { group: { position: { x: number; z: number } } }) => [o.group.position.x, o.group.position.z];
  const along = (trip: Trip, now: number) => [tripAt(trip, now).x, tripAt(trip, now).z];
  const free = (grid: WalkGrid, p: { x: number; z: number }) => grid.blocked[Math.floor(p.z / WALK_CELL) * grid.cols + Math.floor(p.x / WALK_CELL)] === 0;

  it('walks a robot from its desk to the lounge and back, striding on its way, and rests at its place once there', () => {
    const fs = sceneOf();
    const entry = fs.sessions.get('sw-c3')!;
    const robot = entry.robot!;
    const seat = seatSpot(entry.desk!);
    const lounge = loungeFloor();
    const sofa = loungeSpots(lounge.lounge.rect)[2]!;
    const there = walk(lounge, seat, sofa, 1000);
    expect(fs.apply(lounge, 1000)).toBe(false);
    // It sets off at once, from its chair, on its feet.
    expect(xz(robot)).toEqual(along(there, 1000));
    expect(robot.group.position.y).toBeCloseTo(0.03, 10);
    // A long walk goes faster than WALK_SPEED, and its legs keep pace.
    expect(there.speed).toBeGreaterThan(WALK_SPEED);
    for (const t of [1400, 2600]) {
      expect(fs.frame(t).moving).toBe(true);
      expect(xz(robot)).toEqual(along(there, t));
      expect(robot.rig.legL.rotation.x).toBeCloseTo(Math.sin((((t - 1000) / 1000) * there.speed * STRIDE.rate) / WALK_SPEED) * STRIDE.swing, 10);
    }
    expect(fs.frame(tripEnd(there)).moving).toBe(false);
    expect(at(robot)).toEqual(spot(sofa));
    expect([robot.group.position.y, robot.rig.legL.rotation.x]).toEqual([rootHeight('resting'), POSES.resting.legs]);
    // At the next prompt it walks back to its chair.
    const start = tripEnd(there) + 500;
    const back = walk(lounge, sofa, seat, start);
    fs.apply(checkoutFloor(), start);
    fs.frame(start + 700);
    expect(xz(robot)).toEqual(along(back, start + 700));
    fs.frame(tripEnd(back));
    expect(at(robot)).toEqual(spot(seat));
    expect(entry.robot).toBe(robot);
    expect(fs.frame(tripEnd(back) + 1000).moving).toBe(false);
  });

  it('stands a robot up from its chair in one straight step, and sits it back down the same way', () => {
    const fs = sceneOf();
    const entry = fs.sessions.get('sw-a1')!;
    const robot = entry.robot!;
    const seat = seatSpot(entry.desk!);
    const stand = standSpot(entry.desk!);
    const checkouts = checkoutSpecs();
    checkouts[0]!.desks[0]!.state = 'needs_you';
    const up = startTrip(seat, [{ x: stand.x, z: stand.z }], 1000, WALK_SPEED);
    expect(tripEnd(up) - 1000).toBeLessThan(400);
    fs.apply(makeFloor(checkouts), 1000);
    fs.frame(1200);
    expect(xz(robot)).toEqual(along(up, 1200));
    fs.frame(tripEnd(up));
    expect(at(robot)).toEqual(spot(stand));
    const down = startTrip(stand, [{ x: seat.x, z: seat.z }], 3000, WALK_SPEED);
    fs.apply(checkoutFloor(), 3000);
    fs.frame(3200);
    expect(xz(robot)).toEqual(along(down, 3200));
    fs.frame(tripEnd(down));
    expect(at(robot)).toEqual(spot(seat));
  });

  it("walks a host to the head of its room's table through the door, never across glass, a table or a desk, and back", () => {
    const fs = sceneOf();
    const host = fs.sessions.get('ps-d4')!;
    const robot = host.robot!;
    const rooms = roomFloor();
    const grid = walkGrid(rooms);
    const head = headSpot(rooms.roomSlots[0]!);
    const there = walk(rooms, seatSpot(host.desk!), head, 0);
    fs.apply(rooms, 0);
    // Getting off its chair and onto the head seat it may cross a seat's cells; every step between them is clear.
    const near = (p: Point, q: Point) => Math.hypot(p.x - q.x, p.z - q.z) < 1;
    let checked = 0;
    for (let t = 0; t < tripEnd(there); t += 50) {
      fs.frame(t);
      const p = robot.group.position;
      if (near(p, there.from) || near(p, head)) continue;
      expect(free(grid, p), `at ${t}`).toBe(true);
      checked++;
    }
    expect(checked).toBeGreaterThan(40);
    fs.frame(tripEnd(there));
    expect(at(robot)).toEqual(spot(head));
    const back = walk(rooms, head, seatSpot(host.desk!), 10_000);
    fs.apply(checkoutFloor(), 10_000);
    fs.frame(tripEnd(back));
    expect(at(robot)).toEqual(spot(seatSpot(host.desk!)));
  });

  it('turns a robot on its way when its place changes again, from where it got to', () => {
    const fs = sceneOf();
    const entry = fs.sessions.get('sw-c3')!;
    const robot = entry.robot!;
    const seat = seatSpot(entry.desk!);
    const lounge = loungeFloor();
    const there = walk(lounge, seat, loungeSpots(lounge.lounge.rect)[2]!, 1000);
    fs.apply(lounge, 1000);
    fs.frame(2000);
    const halfway = { x: tripAt(there, 2000).x, z: tripAt(there, 2000).z };
    expect(xz(robot)).toEqual([halfway.x, halfway.z]);
    fs.apply(checkoutFloor(), 2000);
    expect(xz(robot)).toEqual([halfway.x, halfway.z]);
    const back = walk(lounge, halfway, seat, 2000);
    fs.frame(2300);
    expect(xz(robot)).toEqual(along(back, 2300));
    fs.frame(tripEnd(back));
    expect(at(robot)).toEqual(spot(seat));
  });

  it('brings the robot of a new session out of the elevator once its doors are open, and walks the robot of one that left out to it, then lets it go', () => {
    const fs = sceneOf();
    const gone = fs.sessions.get('sw-c3')!.robot!;
    const goneFrom = seatSpot(fs.sessions.get('sw-c3')!.desk!);
    const changed = makeFloor(changedCheckouts());
    const elevator = elevatorSpot(changed.core);
    fs.apply(changed, 1000);
    // sw-c3 left: it no longer has an entry, nor can it be picked, but it walks out first.
    expect(fs.sessions.has('sw-c3')).toBe(false);
    expect(gone.group.parent).toBe(fs.scene);
    const picks = new Set(fs.pickables());
    expect(gone.pickables.some((m) => picks.has(m))).toBe(false);
    const out = walk(changed, goneFrom, elevator, 1000);
    // sw-x9 waits inside the elevator, out of sight, until the doors are open.
    const fresh = fs.sessions.get('sw-x9')!;
    const robot = fresh.robot!;
    const seat = seatSpot(fresh.desk!);
    const comes = walk(changed, elevator, seat, 1000 + DOOR_MS);
    expect([robot.group.visible, ...xz(robot)]).toEqual([false, elevator.x, elevator.z]);
    fs.frame(1000 + DOOR_MS - 1);
    expect(robot.group.visible).toBe(false);
    fs.frame(1000 + DOOR_MS + 600);
    expect([robot.group.visible, ...xz(robot)]).toEqual([true, ...along(comes, 1000 + DOOR_MS + 600)]);
    expect(xz(gone)).toEqual(along(out, 1000 + DOOR_MS + 600));
    fs.frame(tripEnd(out) - 1);
    expect(gone.group.parent).toBe(fs.scene);
    fs.frame(tripEnd(out));
    expect(gone.group.parent).toBeNull();
    fs.frame(tripEnd(comes));
    expect(at(robot)).toEqual(spot(seat));
    expect(fs.frame(20_000).moving).toBe(false);
  });

  it('brings new robots out of the elevator BURST_GAP_MS apart, and walks a dormant session out while its desk stays its', () => {
    const fs = sceneOf();
    const checkouts = checkoutSpecs();
    checkouts[0]!.desks[0]!.state = 'dormant';
    checkouts[1]!.desks.push({ id: 'oa-n1', state: 'working' }, { id: 'oa-n2', state: 'working' });
    const floor = makeFloor(checkouts);
    const sleeper = fs.sessions.get('sw-a1')!;
    const robot = sleeper.robot!;
    fs.apply(floor, 0);
    expect([sleeper.robot, robot.group.parent, fs.focusPoint(deskTarget('sw-a1'))]).toEqual([null, fs.scene, { x: seatSpot(sleeper.desk!).x, z: seatSpot(sleeper.desk!).z }]);
    const first = fs.sessions.get('oa-n1')!.robot!;
    const second = fs.sessions.get('oa-n2')!.robot!;
    fs.frame(DOOR_MS);
    expect([first.group.visible, second.group.visible]).toEqual([true, false]);
    fs.frame(DOOR_MS + BURST_GAP_MS);
    expect([first.group.visible, second.group.visible]).toEqual([true, true]);
    fs.frame(10_000);
    expect(robot.group.parent).toBeNull();
    expect(fs.frame(10_000).moving).toBe(false);
  });

  it('finds new ways for the robots on their way when the plan grows, and moves a lounge sitter with its couch', () => {
    const resting = checkoutSpecs();
    resting[0]!.desks[2] = { ...resting[0]!.desks[2]!, lounge: 2 };
    const fs = sceneOf(makeFloor(resting));
    const sitter = fs.sessions.get('sw-c3')!.robot!;
    const walker = fs.sessions.get('oa-d5')!;
    const going = checkoutSpecs();
    going[0]!.desks[2] = { ...going[0]!.desks[2]!, lounge: 2 };
    going[1]!.desks[1] = { id: 'oa-d5', state: 'idle', lounge: 0 };
    const before = makeFloor(going);
    const there = walk(before, seatSpot(walker.desk!), loungeSpots(before.lounge.rect)[0]!, 1000);
    fs.apply(before, 1000);
    fs.frame(2000);
    // Four more checkouts, a pod each: the plan grows to four blocks and the lounge moves 16 m south.
    for (const n of [1, 2, 3, 4]) going.push({ key: `/demo/more-${n}`, repo: 'more', color: 5, tie: 4, desks: [{ id: `m${n}`, state: 'working' }] });
    const grown = makeFloor(going);
    const couch = loungeSpots(grown.lounge.rect);
    expect(couch[2]!.z).toBe(loungeSpots(before.lounge.rect)[2]!.z + 16);
    expect(fs.apply(grown, 2000)).toBe(true);
    expect(at(sitter)).toEqual(spot(couch[2]!));
    const from = { x: tripAt(there, 2000).x, z: tripAt(there, 2000).z };
    expect(xz(walker.robot!)).toEqual([from.x, from.z]);
    const again = walk(grown, from, couch[0]!, 2000);
    fs.frame(3000);
    expect(xz(walker.robot!)).toEqual(along(again, 3000));
    fs.frame(tripEnd(again));
    expect(at(walker.robot!)).toEqual(spot(couch[0]!));
  });

  it('brings the agents of a run that opens out of the elevator one after another to their seats, and walks them back out when it ends', () => {
    const fs = sceneOf();
    const rooms = roomFloor();
    fs.apply(rooms, 0);
    const key = (n: number) => roomKey({ hostSessionId: checkoutRooms()[n]!.host, runId: checkoutRooms()[n]!.runId });
    const room = fs.rooms.get(key(0))!;
    // The first room's three agents come first, then the second room's eight.
    const agents = [...room.agents.values(), ...fs.rooms.get(key(1))!.agents.values()];
    expect(agents).toHaveLength(11);
    agents.forEach((robot, k) => {
      const out = DOOR_MS + k * BURST_GAP_MS;
      fs.frame(out - 1);
      expect(robot.group.visible, `${k} before ${out}`).toBe(false);
      fs.frame(out);
      expect(robot.group.visible, `${k} at ${out}`).toBe(true);
    });
    fs.frame(20_000);
    const seats = seatSpots(room.room.rect);
    [...room.agents.values()].forEach((robot, i) => {
      expect(at(robot)).toEqual(spot(seats[i]!));
      expect(robot.group.position.y).toBeCloseTo(rootHeight('typing', 'workflow'), 10);
    });
    // The first run ends: its agents walk back to the elevator, BURST_GAP_MS apart, and are gone once there.
    const [a0, a1, a2] = [...room.agents.values()];
    fs.apply(roomFloor([{ ...checkoutRooms()[1]!, slot: 1 }]), 30_000);
    expect(fs.rooms.size).toBe(1);
    const picks = new Set(fs.pickables());
    expect([a0, a1, a2].some((a) => a!.pickables.some((m) => picks.has(m)))).toBe(false);
    const elevator = elevatorSpot(rooms.core);
    const outs = [a0, a1, a2].map((_, k) => walk(rooms, seats[k]!, elevator, 30_000 + k * BURST_GAP_MS));
    fs.frame(30_000 + BURST_GAP_MS);
    expect([xz(a0!), xz(a1!), xz(a2!)]).toEqual([along(outs[0]!, 30_000 + BURST_GAP_MS), along(outs[1]!, 30_000 + BURST_GAP_MS), [seats[2]!.x, seats[2]!.z]]);
    fs.frame(tripEnd(outs[2]!));
    expect([a0!.group.parent, a1!.group.parent, a2!.group.parent]).toEqual([null, null, null]);
  });

  it('opens the elevator doors for each robot that comes or goes and shuts them DOOR_HOLD_MS after it, moving only as they open and close', () => {
    const fs = sceneOf();
    const doors = fs.shell!.doors;
    const core = checkoutFloor().core;
    const gap = () => doors[1]!.position.x - doors[0]!.position.x;
    const open = DOOR_PANEL + 2 * DOOR_SLIDE;
    const half = DOOR_PANEL + DOOR_SLIDE;
    expect((doors[0]!.position.x + doors[1]!.position.x) / 2).toBeCloseTo(core.x + core.w / 2, 10);
    expect(gap()).toBeCloseTo(DOOR_PANEL, 10);
    // sw-x9 arrives: the doors open over DOOR_MS, it comes out as they are open, and they close after their hold.
    const checkouts = checkoutSpecs();
    checkouts[0]!.desks.push({ id: 'sw-x9', state: 'working' });
    const more = makeFloor(checkouts);
    fs.apply(more, 1000);
    expect(gap()).toBeCloseTo(DOOR_PANEL, 10);
    const comes = walk(more, elevatorSpot(core), seatSpot(seatOf(more, 'sw-x9').desk), 1000 + DOOR_MS);
    expect(tripEnd(comes)).toBeGreaterThan(1400 + DOOR_HOLD_MS + DOOR_MS);
    for (const [t, width] of [[1200, half], [1400, open], [1400 + DOOR_HOLD_MS, open], [1400 + DOOR_HOLD_MS + DOOR_MS / 2, half], [1400 + DOOR_HOLD_MS + DOOR_MS, DOOR_PANEL]] as const) {
      expect(fs.frame(t), `at ${t}`).toMatchObject({ moving: true, wake: null });
      expect(gap(), `at ${t}`).toBeCloseTo(width, 10);
    }
    expect(fs.frame(tripEnd(comes))).toMatchObject({ moving: false, wake: null });
    // It leaves again: the doors open as it reaches them, stay open while nothing moves, and close after their hold.
    const leaves = walk(more, seatSpot(seatOf(more, 'sw-x9').desk), elevatorSpot(core), 20_000);
    const last = tripEnd(leaves);
    fs.apply(checkoutFloor(), 20_000);
    expect(fs.frame(last - DOOR_MS - 1)).toMatchObject({ moving: true, wake: null });
    expect(gap()).toBeCloseTo(DOOR_PANEL, 10);
    expect(fs.frame(last - DOOR_MS / 2)).toMatchObject({ moving: true, wake: null });
    expect(gap()).toBeCloseTo(half, 10);
    expect(fs.frame(last)).toMatchObject({ moving: false, wake: last + DOOR_HOLD_MS });
    expect(gap()).toBeCloseTo(open, 10);
    expect(fs.frame(last + DOOR_HOLD_MS)).toMatchObject({ moving: true, wake: null });
    expect(fs.frame(last + DOOR_HOLD_MS + DOOR_MS / 2)).toMatchObject({ moving: true, wake: null });
    expect(gap()).toBeCloseTo(half, 10);
    expect(fs.frame(last + DOOR_HOLD_MS + DOOR_MS)).toMatchObject({ moving: false, wake: null });
    expect(gap()).toBeCloseTo(DOOR_PANEL, 10);
  });

  it('lets a robot on its way cast no shadow, with a soft disc under it instead, until it is at its place and casts again', () => {
    const fs = sceneOf();
    const robot = fs.sessions.get('sw-c3')!.robot!;
    const casters = robot.pickables.filter((m) => m.castShadow);
    expect(casters).toHaveLength(7);
    const discs = () => fs.scene.children.filter((o) => o.name === 'contact') as Mesh[];
    expect(discs()).toEqual([]);
    const lounge = loungeFloor();
    const there = walk(lounge, seatSpot(fs.sessions.get('sw-c3')!.desk!), loungeSpots(lounge.lounge.rect)[2]!, 1000);
    fs.apply(lounge, 1000);
    expect(robot.pickables.filter((m) => m.castShadow)).toEqual([]);
    expect(discs()).toHaveLength(1);
    const disc = discs()[0]!;
    expect([disc.material, disc.position.y, disc.scale.x, disc.visible]).toEqual([fs.mats.contact, CONTACT_Y, KIND_SCALE.session, true]);
    expect(fs.frame(2000).shadows).toBe(false);
    expect([disc.position.x, disc.position.z]).toEqual(along(there, 2000));
    // It sits down: it casts again, the same parts as before, and the shadow map must be drawn once more.
    expect(fs.frame(tripEnd(there)).shadows).toBe(true);
    expect(robot.pickables.filter((m) => m.castShadow)).toEqual(casters);
    expect(discs()).toEqual([]);
    expect(fs.frame(tripEnd(there) + 16).shadows).toBe(false);
  });

  it("tells where each session's tag hangs: over its robot on its way, at its place once there, and none for one leaving; the ring follows the robot", () => {
    const fs = sceneOf();
    fs.setSelected(deskTarget('sw-c3'));
    const checkouts = checkoutSpecs();
    checkouts[0]!.desks[2] = { ...checkouts[0]!.desks[2]!, lounge: 2 };
    checkouts[1]!.desks.pop();
    const floor = makeFloor(checkouts, undefined, checkoutRooms());
    const there = walk(floor, seatSpot(fs.sessions.get('sw-c3')!.desk!), loungeSpots(floor.lounge.rect)[2]!, 1000);
    fs.apply(floor, 1000);
    const step = fs.frame(2000);
    // oa-d5 walks out and ps-f7 is dormant: neither has a tag to move. Agents and interns have none.
    expect([...step.tags.keys()].sort()).toEqual(['oa-c3', 'ps-d4', 'sw-a1', 'sw-b2', 'sw-c3']);
    const [x, z] = along(there, 2000);
    expect(step.tags.get('sw-c3')).toEqual({ x, y: LABEL_Y.standing, z });
    expect([fs.ring.position.x, fs.ring.position.z]).toEqual([x, z]);
    expect(fs.focusPoint(deskTarget('sw-c3'))).toEqual({ x: loungeSpots(floor.lounge.rect)[2]!.x, z: loungeSpots(floor.lounge.rect)[2]!.z });
    const { desk, occupant } = seatOf(floor, 'sw-b2');
    expect(step.tags.get('sw-b2')).toEqual(labelAnchor(floor, desk, occupant));
    const end = fs.frame(tripEnd(there));
    expect(end.tags.get('sw-c3')).toEqual(labelAnchor(floor, seatOf(floor, 'sw-c3').desk, seatOf(floor, 'sw-c3').occupant));
  });

  it('puts every robot in its place at once when it settles: those on their way arrive, those leaving are gone', () => {
    const fs = sceneOf();
    const entry = fs.sessions.get('sw-a1')!;
    const robot = entry.robot!;
    const leaving = fs.sessions.get('sw-c3')!.robot!;
    const checkouts = changedCheckouts();
    fs.apply(makeFloor(checkouts), 1000);
    fs.frame(1100);
    const fresh = fs.sessions.get('sw-x9')!.robot!;
    expect(fs.settle()).toBe(true);
    expect([at(robot), leaving.group.parent, fresh.group.visible, at(fresh)]).toEqual([spot(standSpot(entry.desk!)), null, true, spot(seatSpot(fs.sessions.get('sw-x9')!.desk!))]);
    expect(fs.settle()).toBe(false);
    expect(fs.frame(1200).moving).toBe(false);
    // Without a time, a floor puts its robots in their places at once too.
    fs.apply(loungeFloor());
    expect(at(fs.sessions.get('sw-a1')!.robot!)).toEqual(spot(seatSpot(entry.desk!)));
    expect(fs.frame(1300).moving).toBe(false);
  });
});

describe('loops at rest', () => {
  type Look = Pick<Robot, 'pose' | 'badge'>;
  const intern = (agentId: string): Intern => ({ agentId, type: 'Explore', label: 'Find the callers', running: true });
  /** The checkout floor with two interns over sw-a1's desk and both rooms open, ps-d4 at the head of the first. */
  function busyFloor() {
    const checkouts = checkoutSpecs();
    checkouts[0]!.desks[0] = { ...checkouts[0]!.desks[0]!, interns: [intern('i1'), intern('i2')] };
    return makeFloor(checkouts, undefined, checkoutRooms());
  }
  /** Every robot of the scene, with its walker's key and the look it rests in. */
  function robots(fs: FloorScene): Array<{ key: string; look: Look; robot: RobotObject }> {
    const out: Array<{ key: string; look: Look; robot: RobotObject }> = [];
    for (const [id, entry] of fs.sessions) {
      if (entry.robot) out.push({ key: JSON.stringify(['session', id]), look: entry.occupant.robot!, robot: entry.robot });
      for (const [agentId, robot] of entry.interns) out.push({ key: JSON.stringify(['intern', id, agentId]), look: { pose: 'still', badge: null }, robot });
    }
    for (const [room, entry] of fs.rooms) {
      for (const [agentId, robot] of entry.agents) out.push({ key: JSON.stringify(['agent', room, agentId]), look: { pose: 'typing', badge: null }, robot });
    }
    return out;
  }
  /** Where a robot stands, the way it faces, and its limbs. */
  const limbs = (o: RobotObject) => {
    const r = o.rig;
    return [o.group.position.x, o.group.position.y, o.group.position.z, o.group.rotation.y, r.armL.rotation.x, r.armL.rotation.z, r.armR.rotation.x, r.armR.rotation.z, r.legL.rotation.x, r.legR.rotation.x, r.neck.rotation.x, r.waist.rotation.x];
  };
  /** The same robot built anew where it stands, in its pose, and in its loop at `t` from `phase` when given. */
  function expected(o: RobotObject, look: Look, loop?: { t: number; phase: number }) {
    const ref = buildRobot('ref', { ...look, body: 0, tie: null }, new Geometries(), new Materials(dayTheme()), o.kind);
    poseRobot(ref, look, { x: o.group.position.x, z: o.group.position.z, facing: o.group.rotation.y });
    if (loop) animateRobot(ref, look, loop.t, loop.phase);
    return limbs(ref);
  }

  it('runs the loop of every robot at its place in each frame while loops are on, from the phase of its key, and none while they are off', () => {
    const fs = sceneOf(busyFloor());
    const all = robots(fs);
    expect(new Set(all.map((r) => r.robot.kind))).toEqual(new Set(['session', 'intern', 'workflow']));
    expect(fs.loops).toBe(false);
    expect(fs.frame(5250).ambient).toBe(false);
    for (const { key, look, robot } of all) expect(limbs(robot), key).toEqual(expected(robot, look));
    fs.loops = true;
    for (const now of [5250, 5300]) {
      const step = fs.frame(now);
      expect([step.moving, step.shadows, step.ambient]).toEqual([false, false, true]);
      for (const { key, look, robot } of all) expect(limbs(robot), key).toEqual(expected(robot, look, { t: now / 1000, phase: phaseOf(key) }));
    }
    const typist = all.find((r) => r.key === JSON.stringify(['session', 'sw-a1']))!;
    expect(limbs(typist.robot)).not.toEqual(expected(typist.robot, typist.look));
    fs.loops = false;
    expect(fs.frame(5350).ambient).toBe(false);
    for (const { key, look, robot } of all) expect(limbs(robot), key).toEqual(expected(robot, look));
  });

  it('strides a robot on its way while the others run their loops, and calls a frame ambient only while a robot at its place runs one', () => {
    const fs = sceneOf();
    fs.loops = true;
    const walker = fs.sessions.get('sw-c3')!.robot!;
    const typist = fs.sessions.get('sw-a1')!.robot!;
    const lounge = loungeFloor();
    const seat = seatSpot(fs.sessions.get('sw-c3')!.desk!);
    const there = startTrip(seat, findPath(walkGrid(lounge), seat, loungeSpots(lounge.lounge.rect)[2]!), 1000, WALK_SPEED);
    fs.apply(lounge, 1000);
    const step = fs.frame(1400);
    expect([step.moving, step.ambient]).toEqual([true, true]);
    expect(walker.rig.legL.rotation.x).toBeCloseTo(Math.sin((0.4 * there.speed * STRIDE.rate) / WALK_SPEED) * STRIDE.swing, 10);
    expect([walker.rig.neck.rotation.x, walker.rig.waist.rotation.x]).toEqual([0, 0]);
    expect(limbs(typist)).toEqual(expected(typist, { pose: 'typing', badge: 'typing' }, { t: 1.4, phase: phaseOf(JSON.stringify(['session', 'sw-a1'])) }));
    // At its seat in the lounge, it breathes.
    const end = tripEnd(there);
    fs.frame(end);
    expect(limbs(walker)).toEqual(expected(walker, { pose: 'resting', badge: null }, { t: end / 1000, phase: phaseOf(JSON.stringify(['session', 'sw-c3'])) }));
    // With no robot on the floor, or only hosts in meetings, no frame is ambient.
    const away = checkoutSpecs();
    for (const c of away) for (const d of c.desks) d.state = 'dormant';
    const meeting = checkoutSpecs();
    for (const c of meeting) for (const d of c.desks) if (d.state !== 'dormant') d.state = 'in_meeting';
    for (const floor of [makeFloor(away), makeFloor(meeting)]) {
      const quiet = sceneOf(floor);
      quiet.loops = true;
      expect(quiet.frame(1000).ambient).toBe(false);
    }
  });

  it('keeps the tag anchor of a robot at its place from frame to frame, and works it out again with each floor update', () => {
    const fs = sceneOf();
    fs.loops = true;
    const first = fs.frame(1000).tags.get('sw-a1')!;
    expect(fs.frame(1050).tags.get('sw-a1')).toBe(first);
    fs.apply(checkoutFloor(), 1100);
    const next = fs.frame(1150).tags.get('sw-a1')!;
    expect(next).not.toBe(first);
    expect(next).toEqual(first);
  });
});

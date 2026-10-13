import { describe, expect, it } from 'vitest';
import { Box3, Mesh, type BufferGeometry, type Material } from 'three';
import { FloorScene, layoutSignature } from '../../renderer/floor-scene';
import { KIND_SCALE } from '../../renderer/robot';
import { dayTheme } from '../../renderer/theme';
import type { Intern } from '../../../src/scene/types';
import type { Target } from '../../renderer/index';
import {
  HOME_AZIMUTH,
  deskAnchor,
  headSpot,
  internSpots,
  loungeSpots,
  roomKey,
  seatSpot,
  seatSpots,
  shadowExtent,
  standSpot,
  tableCenter,
} from '../../renderer/world';
import { checkoutFloor, checkoutIslands, checkoutRooms, makeFloor, roomFloor, seatsOf, type IslandSpec } from './fixtures';

/** The checkout floor after a change: sw-a1 needs you, sw-c3 left and sw-x9 sat down at its desk. */
function changedIslands(): IslandSpec[] {
  const islands = checkoutIslands();
  islands[0]!.desks = [
    { id: 'sw-a1', state: 'needs_you', agents: 1 },
    { id: 'sw-b2', state: 'done' },
    { id: 'sw-x9', state: 'working' },
  ];
  return islands;
}

/** The checkout floor with sw-c3, idle, resting on lounge seat 2. */
function loungeFloor() {
  const islands = checkoutIslands();
  islands[0]!.desks[2] = { ...islands[0]!.desks[2]!, lounge: 2 };
  return makeFloor(islands);
}

const deskTarget = (id: string): Target => ({ kind: 'desk', id });
const roomTarget = (id: string): Target => ({ kind: 'room', id });
/** Where a robot stands and the way it faces, as a spot lists them. */
const at = (o: { group: { position: { x: number; z: number }; rotation: { y: number } } }) => [o.group.position.x, o.group.position.z, o.group.rotation.y];
const spot = (s: { x: number; z: number; facing: number }) => [s.x, s.z, s.facing];

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
    for (const desk of checkoutFloor().pods.flatMap((p) => p.desks)) {
      const obj = fs.shell!.desks.get(desk.id)!;
      const a = deskAnchor(desk);
      expect([obj.group.position.x, obj.group.position.z, obj.group.rotation.y], desk.id).toEqual([a.x, a.z, desk.chair === 'north' ? Math.PI : 0]);
      expect(obj.screen.material, desk.id).toBe(fs.mats.screen(desk.occupant?.state ?? 'idle'));
      expect(obj.top.material, desk.id).toBe(desk.occupant?.state === 'dormant' ? fs.mats.surface.deskOff : fs.mats.surface.desk);
    }
    expect(fs.shell!.desks.get('p0-3')!.screen.material).toBe(fs.mats.screen('idle'));
    expect(fs.mats.screen('idle').emissiveIntensity).toBe(0);
  });

  it('keeps unchanged robots, places a changed one where it now belongs, adds the new and drops the gone', () => {
    const fs = sceneOf();
    const before = new Map([...fs.sessions].map(([id, e]) => [id, e.robot]));
    const gone = fs.sessions.get('sw-c3')!;
    expect(fs.apply(makeFloor(changedIslands()))).toBe(false);
    expect(fs.sessions.get('sw-b2')!.robot).toBe(before.get('sw-b2'));
    const changed = fs.sessions.get('sw-a1')!;
    expect(changed.robot).toBe(before.get('sw-a1'));
    expect(fs.shell!.desks.get(changed.desk!.id)!.screen.material).toBe(fs.mats.screen('needs_you'));
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
    expect(fs.apply(makeFloor(changedIslands()))).toBe(false);
    expect(fs.apply(roomFloor())).toBe(false);
    expect(fs.shell).toBe(shell);
    const slab = shell.group.children.find((c) => c instanceof Mesh && c.material === fs.mats.surface.floor) as Mesh;
    let freed = false;
    slab.geometry.addEventListener('dispose', () => (freed = true));
    // Nine sessions of one checkout take three pods: with the other two checkouts', the plan grows to three blocks.
    const grown = checkoutIslands();
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
    expect(layoutSignature(makeFloor(changedIslands()))).toBe(layoutSignature(a));
    const recoloured = checkoutIslands();
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
    const recoloured = checkoutIslands();
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
    const recoloured = checkoutIslands();
    recoloured[0]!.color = 6;
    fs.apply(makeFloor(recoloured));
    const next = fs.sessions.get('sw-a1')!.robot!;
    expect(next).not.toBe(robot);
    expect(robot.group.parent).toBeNull();
    expect(next.body).toBe(6);
    const asleep = checkoutIslands();
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
    const fs = sceneOf(makeFloor(checkoutIslands(), undefined, [], [{ id: 'sw-w1', state: 'working' }]));
    const waiting = fs.sessions.get('sw-w1')!;
    expect([waiting.desk, waiting.robot, fs.focusPoint(deskTarget('sw-w1'))]).toEqual([null, null, null]);
    const robot = fs.sessions.get('oa-d5')!.robot!;
    const islands = checkoutIslands();
    islands[1]!.desks.pop();
    fs.apply(makeFloor(islands));
    expect([fs.sessions.has('oa-d5'), fs.sessions.has('sw-w1'), robot.group.parent]).toEqual([false, false, null]);
  });

  it('lets a click on a desk pick the session at it, and its robot pick it wherever it stands; a free desk picks nothing', () => {
    const fs = sceneOf(roomFloor());
    const picks = new Set(fs.pickables());
    for (const { desk, occupant } of seatsOf(roomFloor())) {
      const obj = fs.shell!.desks.get(desk.id)!;
      expect(obj.pickables.every((m) => picks.has(m) && m.userData.pick?.id === occupant.sessionId), desk.id).toBe(true);
    }
    const free = fs.shell!.desks.get('p0-3')!;
    expect(free.pickables.some((m) => picks.has(m) || m.userData.pick)).toBe(false);
    const host = fs.sessions.get('ps-d4')!.robot!;
    expect(host.pickables.every((m) => picks.has(m))).toBe(true);
    expect(host.pickables[0]!.userData.pick).toEqual(deskTarget('ps-d4'));
    // A desk whose session leaves is free again, and picks nothing.
    const islands = checkoutIslands();
    islands[0]!.desks.pop();
    fs.apply(makeFloor(islands, undefined, checkoutRooms()));
    const left = fs.shell!.desks.get('p0-2')!;
    const now = new Set(fs.pickables());
    expect(left.pickables.some((m) => now.has(m) || m.userData.pick)).toBe(false);
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
    fs.apply(makeFloor(changedIslands()));
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

  it('recolours lights and materials in place on a theme change', () => {
    const fs = sceneOf();
    const floorMat = fs.mats.surface.floor;
    const night = dayTheme();
    night.colors['hemi-sky'] = '#8ea2d8';
    night.colors.sun = '#9db4ff';
    night.colors['scene-floor'] = '#3a3f55';
    night.numbers['hemi-int'] = 0.6;
    night.numbers['sun-int'] = 0.55;
    fs.setTheme(night);
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

  it('keeps the robots of agents that run on, moves them up the table, and lets those that finish leave', () => {
    const fs = sceneOf(roomFloor());
    const first = entryOf(fs, 0);
    const [a0, a1, a2] = [...first.agents.values()];
    const floor = roomFloor();
    const agents = floor.rooms[0]!.agents;
    // a0 finishes; a1 and a2 run on and move up to the first two seats.
    floor.rooms[0] = { ...floor.rooms[0]!, agents: [agents[1]!, agents[2]!, { ...agents[0]!, running: false }, ...agents.slice(3)], counts: { running: 2, finished: 3 } };
    expect(fs.apply(floor)).toBe(false);
    const seats = seatSpots(first.room.rect);
    expect([...first.agents.values()]).toEqual([a1, a2]);
    expect([a1!.group.position.x, a1!.group.position.z]).toEqual([seats[0]!.x, seats[0]!.z]);
    expect([a2!.group.position.x, a2!.group.position.z]).toEqual([seats[1]!.x, seats[1]!.z]);
    expect(a0!.group.parent).toBeNull();
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
    const islands = checkoutIslands();
    islands[0]!.desks[0] = { ...islands[0]!.desks[0]!, interns: ['same', 'same', 'other'].map((agentId) => ({ agentId, type: 'Explore', label: null, running: true })) };
    const fs = sceneOf(makeFloor(islands));
    for (let i = 0; i < 5; i++) fs.apply(makeFloor(islands));
    const interns = () => fs.scene.children.filter((o) => o.name.startsWith('intern ')).length;
    expect(interns()).toBe(2);
    islands[0]!.desks.shift();
    fs.apply(makeFloor(islands));
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
  const withInterns = (interns: Intern[], state: IslandSpec['desks'][number]['state'] = 'working', lounge?: number) => {
    const islands = checkoutIslands();
    islands[0]!.desks[0] = { ...islands[0]!.desks[0]!, state, interns, ...(lounge === undefined ? {} : { lounge }) };
    return makeFloor(islands);
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

  it('keeps an intern that flies on, moves it up the arc, and lands the ones that finish or leave with their session', () => {
    const fs = sceneOf(withInterns([intern('i1'), intern('i2')]));
    const entry = fs.sessions.get('sw-a1')!;
    const [i1, i2] = [...entry.interns.values()];
    fs.apply(withInterns([intern('i1', false), intern('i2')]));
    expect([...entry.interns.values()]).toEqual([i2]);
    const middle = internSpots(entry.desk!)[0]!;
    expect([i2!.group.position.x, i2!.group.position.z]).toEqual([middle.x, middle.z]);
    expect(i1!.group.parent).toBeNull();
    const islands = checkoutIslands();
    islands[0]!.desks.shift();
    fs.apply(makeFloor(islands));
    expect(i2!.group.parent).toBeNull();
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

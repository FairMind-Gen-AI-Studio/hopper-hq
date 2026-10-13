import { describe, expect, it } from 'vitest';
import { Box3, Mesh, type BufferGeometry, type Material } from 'three';
import { FloorScene, layoutSignature } from '../../renderer/floor-scene';
import { KIND_SCALE } from '../../renderer/robot';
import { dayTheme } from '../../renderer/theme';
import type { Intern } from '../../../src/scene/types';
import type { Target } from '../../renderer/index';
import { HOME_AZIMUTH, deskAnchor, headSpot, internSpots, robotSpot, roomKey, seatSpot, seatSpots, shadowExtent, tableCenter } from '../../renderer/world';
import { checkoutFloor, checkoutIslands, checkoutRooms, desksOf, makeFloor, roomFloor, type IslandSpec } from './fixtures';

/** The checkout floor after a change: sw-a1 needs you, sw-c3 left and sw-x9 sat down at the same island. */
function changedIslands(): IslandSpec[] {
  const islands = checkoutIslands();
  islands[0]!.desks = [
    { id: 'sw-a1', state: 'needs_you', agents: 1 },
    { id: 'sw-b2', state: 'done' },
    { id: 'sw-x9', state: 'working' },
  ];
  return islands;
}

const deskTarget = (id: string): Target => ({ kind: 'desk', id });
const roomTarget = (id: string): Target => ({ kind: 'room', id });

function sceneOf(floor = checkoutFloor()) {
  const fs = new FloorScene(dayTheme());
  fs.apply(floor);
  return fs;
}

describe('the floor scene', () => {
  it('builds the shell, a desk per session and a robot per desk that is not dormant, under two lights', () => {
    const fs = sceneOf();
    expect(fs.shell).not.toBeNull();
    expect(fs.shell!.group.parent).toBe(fs.scene);
    expect([...fs.desks.keys()]).toEqual(desksOf(checkoutFloor()).map((d) => d.sessionId));
    for (const entry of fs.desks.values()) {
      expect(entry.obj.group.parent).toBe(fs.scene);
      expect(entry.robot !== null, entry.desk.state).toBe(entry.desk.state !== 'dormant');
    }
    expect(fs.hemi.parent).toBe(fs.scene);
    expect(fs.sun.parent).toBe(fs.scene);
    expect(fs.sun.castShadow).toBe(true);
  });

  it('keeps unchanged desks, updates a changed one in place, adds the new and drops the gone', () => {
    const fs = sceneOf();
    const before = new Map([...fs.desks].map(([id, e]) => [id, { group: e.obj.group, robot: e.robot }]));
    const gone = fs.desks.get('sw-c3')!;
    const rebuilt = fs.apply(makeFloor(changedIslands()));
    expect(rebuilt).toBe(false);
    expect(fs.desks.get('sw-b2')!.obj.group).toBe(before.get('sw-b2')!.group);
    expect(fs.desks.get('sw-b2')!.robot).toBe(before.get('sw-b2')!.robot);
    const changed = fs.desks.get('sw-a1')!;
    expect(changed.obj.group).toBe(before.get('sw-a1')!.group);
    expect(changed.robot).toBe(before.get('sw-a1')!.robot);
    expect(changed.obj.screen.material).toBe(fs.mats.screen('needs_you'));
    expect(changed.robot!.group.position.x).toBe(robotSpot(changed.desk)!.x);
    expect(changed.robot!.group.rotation.y).toBe(0);
    expect(fs.desks.has('sw-c3')).toBe(false);
    expect(gone.obj.group.parent).toBeNull();
    expect(gone.robot!.group.parent).toBeNull();
    const picks = new Set(fs.pickables());
    expect(gone.obj.pickables.some((m) => picks.has(m))).toBe(false);
    expect(fs.desks.get('sw-x9')!.obj.group.parent).toBe(fs.scene);
    expect(fs.desks.get('sw-x9')!.obj.group.position.x).toBe(deskAnchor({ rect: gone.desk.rect, chair: 'south' }).x);
  });

  it('rebuilds the shell only when the layout changes, and frees the old one', () => {
    const fs = sceneOf();
    const shell = fs.shell!;
    expect(fs.apply(checkoutFloor())).toBe(false);
    expect(fs.shell).toBe(shell);
    const slab = shell.group.children.find((c) => c instanceof Mesh && c.material === fs.mats.surface.floor) as Mesh;
    let freed = false;
    slab.geometry.addEventListener('dispose', () => (freed = true));
    const grown = checkoutIslands();
    grown[2]!.desks.push({ id: 'ps-z1', state: 'working' });
    expect(fs.apply(makeFloor(grown))).toBe(true);
    expect(fs.shell).not.toBe(shell);
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
    for (let n = 2; n <= 20; n++) fs.apply(floorOf(n));
    for (let n = 19; n >= 1; n--) fs.apply(floorOf(n));
    expect(fs.geo.size).toBe(sceneOf(floorOf(1)).geo.size);
  });

  it('signs the layout by footprint, core, island rectangles, keys and colours, and room rectangles only', () => {
    const a = checkoutFloor();
    const b = makeFloor(changedIslands());
    expect(layoutSignature(b)).toBe(layoutSignature(a));
    const recoloured = checkoutIslands();
    recoloured[0]!.color = 6;
    expect(layoutSignature(makeFloor(recoloured))).not.toBe(layoutSignature(a));
    const rooms = roomFloor();
    expect(layoutSignature(rooms)).not.toBe(layoutSignature(a));
    const moved = roomFloor();
    moved.rooms[1] = { ...moved.rooms[1]!, rect: { ...moved.rooms[1]!.rect, y: moved.rooms[1]!.rect.y + 1 } };
    expect(moved.size).toEqual(rooms.size);
    expect(layoutSignature(moved)).not.toBe(layoutSignature(rooms));
    // What happens in a room leaves the layout as it was.
    const busier = checkoutRooms();
    busier[0] = { ...busier[0]!, running: 1, finished: 4, seated: false };
    expect(layoutSignature(roomFloor(busier))).toBe(layoutSignature(rooms));
  });

  it('rebuilds a robot for new colours, sends it home when the desk goes dormant, and back again', () => {
    const fs = sceneOf();
    const robot = fs.desks.get('sw-a1')!.robot!;
    const recoloured = checkoutIslands();
    recoloured[0]!.color = 6;
    fs.apply(makeFloor(recoloured));
    const next = fs.desks.get('sw-a1')!.robot!;
    expect(next).not.toBe(robot);
    expect(robot.group.parent).toBeNull();
    expect(next.body).toBe(6);
    const asleep = checkoutIslands();
    asleep[0]!.desks[0]!.state = 'dormant';
    fs.apply(makeFloor(asleep));
    expect(fs.desks.get('sw-a1')!.robot).toBeNull();
    expect(next.group.parent).toBeNull();
    fs.apply(checkoutFloor());
    expect(fs.desks.get('sw-a1')!.robot!.group.parent).toBe(fs.scene);
  });

  it('rings the selected desk under its robot, or its chair when empty, and hides the ring otherwise', () => {
    const fs = sceneOf();
    expect(fs.ring.visible).toBe(false);
    fs.setSelected(deskTarget('oa-c3'));
    const desk = fs.desks.get('oa-c3')!.desk;
    expect(fs.ring.visible).toBe(true);
    expect([fs.ring.position.x, fs.ring.position.z]).toEqual([robotSpot(desk)!.x, robotSpot(desk)!.z]);
    fs.setSelected(deskTarget('ps-f7'));
    const empty = seatSpot({ rect: fs.desks.get('ps-f7')!.desk.rect, chair: 'south' });
    expect([fs.ring.position.x, fs.ring.position.z]).toEqual([empty.x, empty.z]);
    expect(fs.focusPoint(deskTarget('ps-f7'))).toEqual({ x: empty.x, z: empty.z });
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
    // It follows the room when the room moves, and goes when the room closes.
    fs.apply(roomFloor(checkoutRooms().slice(1)));
    expect(outline.position.z).toBe(fs.rooms.get(roomKey({ hostSessionId: 'sw-a1', runId: 'wf_0000aaaa-002' }))!.room.rect.y);
    fs.apply(checkoutFloor());
    expect(outline.visible).toBe(false);
    expect(fs.focusPoint(roomTarget('wf_0000aaaa-002'))).toBeNull();
    fs.setSelected(null);
    expect([outline.visible, fs.ring.visible]).toEqual([false, false]);
  });

  it('keeps the selection across updates and drops the ring when the desk leaves', () => {
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
    const grown = checkoutIslands();
    grown[0]!.desks.push({ id: 'sw-z1', state: 'idle' });
    fs.apply(makeFloor(grown));
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
    expect(fs.desks.size).toBe(0);
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
  const local = (rect: { w: number; h: number }) => ({ x: 0, y: 0, w: rect.w, h: rect.h });

  it('builds each room with its furniture, its running agents at the table in hard hats, and its host at the head', () => {
    const fs = sceneOf(roomFloor());
    expect(fs.rooms.size).toBe(2);
    const first = entryOf(fs, 0);
    expect(first.obj.group.parent).toBe(fs.scene);
    expect(first.obj.group.position.toArray()).toEqual([first.room.rect.x, 0, first.room.rect.y]);
    // Three agents run: each sits in its seat, in order, as a workflow robot in the room's colours.
    const seats = seatSpots(local(first.room.rect));
    expect([...first.agents.keys()]).toEqual(['wf_0000aaaa-001-a0', 'wf_0000aaaa-001-a1', 'wf_0000aaaa-001-a2']);
    [...first.agents.values()].forEach((robot, i) => {
      expect(robot.group.parent).toBe(first.obj.group);
      expect([robot.kind, robot.group.scale.x, robot.body, robot.tie]).toEqual(['workflow', KIND_SCALE.workflow, first.room.look.body, first.room.look.tie]);
      expect([robot.group.position.x, robot.group.position.z, robot.group.rotation.y]).toEqual([seats[i]!.x, seats[i]!.z, seats[i]!.facing]);
    });
    // ps-d4 is in the meeting: its robot sits at the head, and the placard is put away.
    const head = headSpot(local(first.room.rect));
    expect(first.host!.kind).toBe('session');
    expect(first.host!.group.parent).toBe(first.obj.group);
    expect([first.host!.group.position.x, first.host!.group.position.z, first.host!.group.rotation.y]).toEqual([head.x, head.z, head.facing]);
    expect(first.obj.placard.visible).toBe(false);
    // Ten agents run in the second room: eight sit, and sw-a1 works at its desk, so the head seat holds the placard.
    const second = entryOf(fs, 1);
    expect(second.agents.size).toBe(8);
    expect(second.host).toBeNull();
    expect(second.obj.placard.visible).toBe(true);
    expect(fs.scene.getObjectByName('agent wf_0000aaaa-002-a7')).toBeDefined();
    expect(fs.scene.getObjectByName('agent wf_0000aaaa-002-a8')).toBeUndefined();
    expect(fs.scene.getObjectByName('host wf_0000aaaa-001')).toBe(first.host!.group);
  });

  it('keeps the robots of agents that run on, moves them up the table, and lets those that finish leave', () => {
    const fs = sceneOf(roomFloor());
    const first = entryOf(fs, 0);
    const [a0, a1, a2] = [...first.agents.values()];
    const rooms = checkoutRooms();
    // a0 finishes; a1 and a2 run on and move up to the first two seats.
    rooms[0] = { ...rooms[0]!, running: 3, finished: 2 };
    const floor = roomFloor(rooms);
    const agents = floor.rooms[0]!.agents;
    floor.rooms[0] = { ...floor.rooms[0]!, agents: [agents[1]!, agents[2]!, { ...agents[0]!, running: false }, ...agents.slice(3)], counts: { running: 2, finished: 3 } };
    expect(fs.apply(floor)).toBe(false);
    const seats = seatSpots(local(first.room.rect));
    expect([...first.agents.values()]).toEqual([a1, a2]);
    expect([a1!.group.position.x, a1!.group.position.z]).toEqual([seats[0]!.x, seats[0]!.z]);
    expect([a2!.group.position.x, a2!.group.position.z]).toEqual([seats[1]!.x, seats[1]!.z]);
    expect(a0!.group.parent).toBeNull();
  });

  it('takes the host away from the head when it leaves the meeting, and puts the placard back', () => {
    const fs = sceneOf(roomFloor());
    const first = entryOf(fs, 0);
    const host = first.host!;
    const rooms = checkoutRooms();
    rooms[0] = { ...rooms[0]!, seated: false };
    fs.apply(roomFloor(rooms));
    expect(first.host).toBeNull();
    expect(host.group.parent).toBeNull();
    expect(first.obj.placard.visible).toBe(true);
  });

  it('rebuilds the robots of a room whose colours change', () => {
    const fs = sceneOf(roomFloor());
    const first = entryOf(fs, 0);
    const [before] = [...first.agents.values()];
    const floor = roomFloor();
    floor.rooms[0] = { ...floor.rooms[0]!, look: { body: 6, tie: 0 }, host: { ...floor.rooms[0]!.host!, body: 6, tie: 0 } };
    fs.apply(floor);
    const [after] = [...first.agents.values()];
    expect(after).not.toBe(before);
    expect(before!.group.parent).toBeNull();
    expect([after!.body, after!.tie, first.host!.body]).toEqual([6, 0, 6]);
  });

  it('keeps a room that stays, moves it when the rooms above it close, and drops the rooms that close', () => {
    const fs = sceneOf(roomFloor());
    const first = entryOf(fs, 0);
    const second = entryOf(fs, 1);
    const group = second.obj.group;
    // The first run ends: the second room moves up to the top of the wing, and the shell follows the new layout.
    expect(fs.apply(roomFloor(checkoutRooms().slice(1)))).toBe(true);
    expect(fs.rooms.size).toBe(1);
    expect(fs.rooms.get(keyOf(1))).toBe(second);
    expect(second.obj.group).toBe(group);
    expect(second.obj.group.position.toArray()).toEqual([first.room.rect.x, 0, first.room.rect.y]);
    expect(first.obj.group.parent).toBeNull();
    expect(fs.apply(checkoutFloor())).toBe(true);
    expect(fs.rooms.size).toBe(0);
    expect(group.parent).toBeNull();
  });

  it('lets a click on a room, its table, its seats, its agents or its host pick the room, and go through its glass', () => {
    const fs = sceneOf(roomFloor());
    const picks = new Set(fs.pickables());
    const entry = [...fs.rooms.values()][0]!;
    const meshes: Mesh[] = [];
    entry.obj.group.traverse((o) => {
      if (o instanceof Mesh) meshes.push(o);
    });
    expect(meshes.length).toBeGreaterThan(30);
    const glass = meshes.filter((m) => m.material === fs.mats.surface.glass);
    expect(glass).toHaveLength(5);
    for (const m of meshes) {
      const pane = glass.includes(m);
      expect([picks.has(m), m.userData.pick ?? null], m.name).toEqual(pane ? [false, null] : [true, roomTarget('wf_0000aaaa-001')]);
    }
    expect(entry.host!.pickables.every((m) => picks.has(m))).toBe(true);
  });

  it('gives each of two hosts naming the same run a room of its own', () => {
    const rooms = checkoutRooms();
    rooms[1] = { ...rooms[1]!, runId: rooms[0]!.runId };
    const fs = sceneOf(roomFloor(rooms));
    expect(fs.rooms.size).toBe(2);
    const groups = [...fs.rooms.values()].map((r) => r.obj.group);
    expect(groups[0]).not.toBe(groups[1]);
    expect(groups[0]!.position.z).not.toBe(groups[1]!.position.z);
  });

  it('keeps no geometry, group or robot of a closed room, however often rooms open and close', () => {
    const fs = sceneOf(roomFloor());
    const count = () => {
      const names: string[] = [];
      fs.scene.traverse((o) => names.push(o.name.split(' ')[0]!));
      return { children: fs.scene.children.length, rooms: names.filter((n) => n === 'room').length, agents: names.filter((n) => n === 'agent').length, hosts: names.filter((n) => n === 'host').length };
    };
    const size = fs.geo.size;
    const open = count();
    fs.apply(checkoutFloor());
    const closed = count();
    expect([open.rooms, open.agents, open.hosts, closed.rooms, closed.agents, closed.hosts]).toEqual([2, 11, 1, 0, 0, 0]);
    for (let n = 0; n < 5; n++) {
      fs.apply(checkoutFloor());
      expect(count()).toEqual(closed);
      fs.apply(roomFloor(checkoutRooms().slice(1)));
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
    const agents = () => {
      let n = 0;
      [...fs.rooms.values()][0]!.obj.group.traverse((o) => (n += o.name.startsWith('agent ') ? 1 : 0));
      return n;
    };
    const first = agents();
    for (let i = 0; i < 5; i++) fs.apply(floor);
    expect([first, agents(), [...fs.rooms.values()][0]!.agents.size]).toEqual([first, first, first]);
  });

  it('takes away the interns of a desk that leaves, also when two of them share an id', () => {
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
    const twin = { ...rooms[0]!, host: 'oa-c3', seated: false };
    // The second host's room opens first; then the floor lists both, the first host's ahead.
    const fs = sceneOf(roomFloor([rooms[1]!, twin]));
    const floor = roomFloor([rooms[0]!, rooms[1]!, twin]);
    fs.apply(floor);
    fs.setSelected(roomTarget(rooms[0]!.runId));
    const first = floor.rooms[0]!;
    expect([fs.roomRing.visible, fs.roomRing.position.x, fs.roomRing.position.z]).toEqual([true, first.rect.x, first.rect.y]);
    expect(fs.focusPoint(roomTarget(rooms[0]!.runId))).toEqual(tableCenter(first.rect));
  });
});

describe('interns and away desks', () => {
  const intern = (agentId: string, running = true): Intern => ({ agentId, type: 'Explore', label: 'Find the callers', running });
  /** The checkout floor with these interns at sw-a1's desk. */
  const withInterns = (interns: Intern[], state: IslandSpec['desks'][number]['state'] = 'working') => {
    const islands = checkoutIslands();
    islands[0]!.desks[0] = { ...islands[0]!.desks[0]!, state, interns };
    return makeFloor(islands);
  };

  it('flies the running interns in an arc over the desk, small and in the desk robot colours, and none that finished', () => {
    const fs = sceneOf(withInterns([intern('i1'), intern('i2', false), intern('i3')]));
    const entry = fs.desks.get('sw-a1')!;
    expect([...entry.interns.keys()]).toEqual(['i1', 'i3']);
    const spots = internSpots({ rect: entry.desk.rect, chair: 'south' });
    [...entry.interns.values()].forEach((robot, k) => {
      expect(robot.group.parent).toBe(fs.scene);
      expect([robot.kind, robot.body, robot.tie]).toEqual(['intern', entry.robot!.body, entry.robot!.tie]);
      expect([robot.group.position.x, robot.group.position.z, robot.group.rotation.y]).toEqual([spots[k]!.x, spots[k]!.z, spots[k]!.facing]);
    });
    expect(fs.scene.getObjectByName('intern i3')).toBe(entry.interns.get('i3')!.group);
    expect(fs.desks.get('sw-b2')!.interns.size).toBe(0);
  });

  it('lets a click on an intern pick its desk', () => {
    const fs = sceneOf(withInterns([intern('i1')]));
    const robot = fs.desks.get('sw-a1')!.interns.get('i1')!;
    const picks = new Set(fs.pickables());
    expect(robot.pickables.every((m) => picks.has(m))).toBe(true);
    expect(robot.pickables[0]!.userData.pick).toEqual(deskTarget('sw-a1'));
  });

  it('keeps an intern that flies on, moves it up the arc, and lands the ones that finish or leave with their desk', () => {
    const fs = sceneOf(withInterns([intern('i1'), intern('i2')]));
    const entry = fs.desks.get('sw-a1')!;
    const [i1, i2] = [...entry.interns.values()];
    fs.apply(withInterns([intern('i1', false), intern('i2')]));
    expect([...entry.interns.values()]).toEqual([i2]);
    const middle = internSpots({ rect: entry.desk.rect, chair: 'south' })[0]!;
    expect([i2!.group.position.x, i2!.group.position.z]).toEqual([middle.x, middle.z]);
    expect(i1!.group.parent).toBeNull();
    const islands = checkoutIslands();
    islands[0]!.desks.shift();
    fs.apply(makeFloor(islands));
    expect(i2!.group.parent).toBeNull();
  });

  it('flies no interns at a dormant desk, which has no robot to take its colours from', () => {
    const fs = sceneOf(withInterns([intern('i1')], 'dormant'));
    expect(fs.desks.get('sw-a1')!.interns.size).toBe(0);
  });

  it('hides the robot of a desk whose session sits at the head of a meeting, and shows it again when it comes back', () => {
    const fs = sceneOf(roomFloor());
    const entry = fs.desks.get('ps-d4')!;
    expect(entry.desk.away).toBe(true);
    const robot = entry.robot!;
    expect(robot.group.visible).toBe(false);
    expect(fs.desks.get('sw-a1')!.robot!.group.visible).toBe(true);
    // The ring still marks the empty chair.
    fs.setSelected(deskTarget('ps-d4'));
    const chair = seatSpot({ rect: entry.desk.rect, chair: 'south' });
    expect([fs.ring.position.x, fs.ring.position.z]).toEqual([chair.x, chair.z]);
    fs.apply(checkoutFloor());
    expect(entry.robot).toBe(robot);
    expect(robot.group.visible).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { BoxGeometry, Group, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial, OrthographicCamera, Vector2, Vector3 } from 'three';
import { FloorScene } from '../../renderer/floor-scene';
import { pickTarget, toNdc } from '../../renderer/pick';
import { dayTheme } from '../../renderer/theme';
import { deskAnchor, doorGap, seatSpots, tableCenter } from '../../renderer/world';
import { checkoutFloor, checkoutSpecs, isoCamera, makeFloor, roomFloor, seatsOf } from './fixtures';

/** A camera 10 m above the origin looking straight down, 10 m wide and tall: world x is screen x, world z is screen down. */
function topDown(): OrthographicCamera {
  const camera = new OrthographicCamera(-5, 5, 5, -5, 0.1, 100);
  camera.position.set(0, 10, 0);
  camera.up.set(0, 0, -1);
  camera.lookAt(0, 0, 0);
  return camera;
}

function box(sessionId: string | null, x: number, y: number, z: number): Mesh {
  const m = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
  m.position.set(x, y, z);
  if (sessionId) m.userData.pick = { kind: 'desk', id: sessionId };
  m.updateMatrixWorld();
  return m;
}

const desk = (id: string) => ({ kind: 'desk', id });

/** Where a world point shows through a camera, in normalised device coordinates. */
function ndcOf(camera: OrthographicCamera, x: number, y: number, z: number): Vector2 {
  const p = new Vector3(x, y, z).project(camera);
  return new Vector2(p.x, p.y);
}

describe('picking', () => {
  it('turns a pointer position into normalised device coordinates', () => {
    const rect = { left: 100, top: 50, width: 400, height: 200 };
    expect(toNdc(300, 150, rect)!.toArray()).toEqual([0, 0]);
    expect(toNdc(100, 50, rect)!.toArray()).toEqual([-1, 1]);
    expect(toNdc(500, 250, rect)!.toArray()).toEqual([1, -1]);
    expect(toNdc(1, 1, { left: 0, top: 0, width: 0, height: 10 })).toBeNull();
  });

  it('picks the desk under a known point, and nothing on empty floor', () => {
    const camera = topDown();
    const a = box('a', 2, 0, 0);
    const b = box('b', -2, 0, 1);
    expect(pickTarget(camera, new Vector2(0.4, 0), [a, b])).toEqual(desk('a'));
    expect(pickTarget(camera, new Vector2(-0.4, -0.2), [a, b])).toEqual(desk('b'));
    expect(pickTarget(camera, new Vector2(0, 0), [a, b])).toBeNull();
  });

  it('takes the nearest hit, and skips what is hidden or carries no pick', () => {
    const camera = topDown();
    const low = box('low', 0, 0, 0);
    const high = box('high', 0, 2, 0);
    const plain = box(null, 0, 4, 0);
    const at = new Vector2(0, 0);
    expect(pickTarget(camera, at, [low, high, plain])).toEqual(desk('high'));
    high.visible = false;
    expect(pickTarget(camera, at, [low, high])).toEqual(desk('low'));
    const parent = new Group();
    parent.add(low);
    parent.visible = false;
    expect(pickTarget(camera, at, [low, high])).toBeNull();
    // What carries no desk or room is passed over too.
    const odd = box(null, 0, 6, 0);
    odd.userData.pick = { kind: 'lamp', id: 'x' };
    low.removeFromParent();
    low.updateMatrixWorld();
    expect(pickTarget(camera, at, [odd, low])).toEqual(desk('low'));
  });

  it('picks what the instance under the pointer picks, and lets an instance that picks nothing through', () => {
    const camera = topDown();
    const mesh = new InstancedMesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial(), 3);
    [[2, 2, 0], [-2, 2, 1], [0, 2, 0]].forEach(([x, y, z], i) => mesh.setMatrixAt(i, new Matrix4().makeTranslation(x!, y!, z!)));
    mesh.userData.picks = [desk('a'), { kind: 'room', id: 'wf_0000aaaa-001' }, undefined];
    mesh.updateMatrixWorld();
    const low = box('low', 0, 0, 0);
    expect(pickTarget(camera, new Vector2(0.4, 0), [mesh, low])).toEqual(desk('a'));
    expect(pickTarget(camera, new Vector2(-0.4, -0.2), [mesh, low])).toEqual({ kind: 'room', id: 'wf_0000aaaa-001' });
    // The third instance stands over `low` and picks nothing: the click goes through it.
    expect(pickTarget(camera, new Vector2(0, 0), [mesh, low])).toEqual(desk('low'));
    // An instance is read from its mesh's picks, never from the mesh's own pick.
    mesh.userData.picks = undefined;
    mesh.userData.pick = desk('whole');
    expect(pickTarget(camera, new Vector2(0.4, 0), [mesh])).toBeNull();
  });

  it('picks the session at each desk of a floor through the home camera, and nothing at a free desk', () => {
    const fs = new FloorScene(dayTheme());
    const floor = checkoutFloor();
    fs.apply(floor);
    fs.scene.updateMatrixWorld(true);
    const camera = isoCamera(floor.size);
    for (const { desk: d, occupant } of seatsOf(floor)) {
      const a = deskAnchor(d);
      expect(pickTarget(camera, ndcOf(camera, a.x, 0.74, a.z), fs.pickables()), d.id).toEqual(desk(occupant.sessionId));
    }
    const free = floor.pods[3]!.desks[0]!;
    expect(free.occupant).toBeNull();
    expect(pickTarget(camera, ndcOf(camera, deskAnchor(free).x, 0.74, deskAnchor(free).z), fs.pickables())).toBeNull();
    expect(pickTarget(camera, new Vector2(0.98, 0.98), fs.pickables())).toBeNull();
  });

  it('picks a room by its table, its floor, its posts or its agents, and its host as the host\'s desk', () => {
    const fs = new FloorScene(dayTheme());
    const floor = roomFloor();
    fs.apply(floor);
    fs.scene.updateMatrixWorld(true);
    const camera = isoCamera(floor.size);
    const room = floor.rooms[0]!;
    const target = { kind: 'room', id: room.runId };
    const t = tableCenter(room.rect);
    const pick = (x: number, y: number, z: number) => pickTarget(camera, ndcOf(camera, x, y, z), fs.pickables());
    expect(pick(t.x, 0.78, t.z)).toEqual(target);
    expect(pick(room.rect.x + room.rect.w - 0.5, 0.01, room.rect.y + 0.8)).toEqual(target);
    expect(pick(room.rect.x + 0.06, 1, doorGap(room.rect).from)).toEqual(target);
    const entry = [...fs.rooms.values()][0]!;
    for (const robot of entry.agents.values()) {
      const head = robot.group.localToWorld(new Vector3(0, 0.8, 0));
      expect(pick(head.x, head.y, head.z), robot.group.name).toEqual(target);
    }
    const host = fs.sessions.get(room.hostSessionId)!.robot!.group.localToWorld(new Vector3(0, 0.8, 0));
    expect(pick(host.x, host.y, host.z)).toEqual(desk(room.hostSessionId));
    expect(pick(floor.rooms[1]!.rect.x + 4, 0.78, floor.rooms[1]!.rect.y + 3.3)).toEqual({ kind: 'room', id: floor.rooms[1]!.runId });
  });

  it('picks nothing at the table or a seat of a closed room, and the run at a free seat of an open one', () => {
    const fs = new FloorScene(dayTheme());
    const floor = checkoutFloor();
    fs.apply(floor);
    fs.scene.updateMatrixWorld(true);
    const camera = isoCamera(floor.size);
    const pick = (x: number, y: number, z: number) => pickTarget(camera, ndcOf(camera, x, y, z), fs.pickables());
    const rect = floor.roomSlots[0]!;
    const t = tableCenter(rect);
    // The south-east seat, nearest the camera: nobody sits there in either room.
    const seat = seatSpots(rect)[7]!;
    expect([pick(t.x, 0.78, t.z), pick(seat.x, 0.475, seat.z)]).toEqual([null, null]);
    const open = roomFloor();
    fs.apply(open);
    fs.scene.updateMatrixWorld(true);
    expect(open.rooms[0]!.slot).toBe(0);
    expect(pick(seat.x, 0.475, seat.z)).toEqual({ kind: 'room', id: open.rooms[0]!.runId });
  });

  it('goes through the glass of the room in front to the room behind it', () => {
    const fs = new FloorScene(dayTheme());
    const floor = roomFloor();
    fs.apply(floor);
    fs.scene.updateMatrixWorld(true);
    const camera = isoCamera(floor.size);
    const [back, front] = floor.rooms;
    // The far room's floor along its south edge, seen through the north glass of the room in front of it, east of that
    // room's whiteboard: the board, opaque, picks the room in front.
    const hits = [5, 6, 7].map((dx) => pickTarget(camera, ndcOf(camera, back!.rect.x + dx, 0.01, back!.rect.y + back!.rect.h - 0.3), fs.pickables()));
    expect(hits).toEqual(Array(3).fill({ kind: 'room', id: back!.runId }));
    expect(front!.rect.y).toBeGreaterThan(back!.rect.y);
  });

  it('picks the session of an intern hovering over its desk', () => {
    const fs = new FloorScene(dayTheme());
    const checkouts = checkoutSpecs();
    checkouts[0]!.desks[0]!.interns = [{ agentId: 'i1', type: 'Explore', label: null, running: true, inRoom: false }];
    const floor = makeFloor(checkouts);
    fs.apply(floor);
    fs.scene.updateMatrixWorld(true);
    const camera = isoCamera(floor.size);
    const intern = fs.sessions.get('sw-a1')!.interns.get('i1')!;
    const head = intern.group.localToWorld(new Vector3(0, 0.85, 0));
    expect(pickTarget(camera, ndcOf(camera, head.x, head.y, head.z), fs.pickables())).toEqual(desk('sw-a1'));
  });
});

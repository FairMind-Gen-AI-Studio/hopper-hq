import { describe, expect, it } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshBasicMaterial, OrthographicCamera, Vector2, Vector3 } from 'three';
import { FloorScene } from '../../renderer/floor-scene';
import { pickTarget, toNdc } from '../../renderer/pick';
import { dayTheme } from '../../renderer/theme';
import { deskAnchor, doorGap, tableCenter } from '../../renderer/world';
import { checkoutFloor, checkoutIslands, desksOf, isoCamera, makeFloor, roomFloor } from './fixtures';

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

  it('picks each desk of a floor through the home camera', () => {
    const fs = new FloorScene(dayTheme());
    const floor = checkoutFloor();
    fs.apply(floor);
    fs.scene.updateMatrixWorld(true);
    const camera = isoCamera(floor.size);
    for (const d of desksOf(floor)) {
      const a = deskAnchor(d.rect);
      expect(pickTarget(camera, ndcOf(camera, a.x, 0.74, a.z), fs.pickables()), d.sessionId).toEqual(desk(d.sessionId));
    }
    expect(pickTarget(camera, new Vector2(0.98, 0.98), fs.pickables())).toBeNull();
  });

  it('picks a room by its table, its floor, its glass or anyone sitting in it, the host included', () => {
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
    expect(pick(room.rect.x + 0.03, 1, doorGap(room.rect).from - 0.5)).toEqual(target);
    const entry = [...fs.rooms.values()][0]!;
    for (const robot of [...entry.agents.values(), entry.host!]) {
      const head = robot.group.localToWorld(new Vector3(0, 0.8, 0));
      expect(pick(head.x, head.y, head.z), robot.group.name).toEqual(target);
    }
    expect(pick(floor.rooms[1]!.rect.x + 4, 0.78, floor.rooms[1]!.rect.y + 3.3)).toEqual({ kind: 'room', id: floor.rooms[1]!.runId });
  });

  it('picks the desk of an intern hovering behind it', () => {
    const fs = new FloorScene(dayTheme());
    const islands = checkoutIslands();
    islands[0]!.desks[0]!.interns = [{ agentId: 'i1', type: 'Explore', label: null, running: true }];
    const floor = makeFloor(islands);
    fs.apply(floor);
    fs.scene.updateMatrixWorld(true);
    const camera = isoCamera(floor.size);
    const intern = fs.desks.get('sw-a1')!.interns.get('i1')!;
    const head = intern.group.localToWorld(new Vector3(0, 0.85, 0));
    expect(pickTarget(camera, ndcOf(camera, head.x, head.y, head.z), fs.pickables())).toEqual(desk('sw-a1'));
  });
});

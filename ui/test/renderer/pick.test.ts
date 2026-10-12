import { describe, expect, it } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshBasicMaterial, OrthographicCamera, Vector2, Vector3 } from 'three';
import { FloorScene } from '../../renderer/floor-scene';
import { pickSession, toNdc } from '../../renderer/pick';
import { dayTheme } from '../../renderer/theme';
import { deskAnchor } from '../../renderer/world';
import { checkoutFloor, desksOf, isoCamera } from './fixtures';

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
  if (sessionId) m.userData.pick = { sessionId };
  m.updateMatrixWorld();
  return m;
}

describe('picking', () => {
  it('turns a pointer position into normalised device coordinates', () => {
    const rect = { left: 100, top: 50, width: 400, height: 200 };
    expect(toNdc(300, 150, rect)!.toArray()).toEqual([0, 0]);
    expect(toNdc(100, 50, rect)!.toArray()).toEqual([-1, 1]);
    expect(toNdc(500, 250, rect)!.toArray()).toEqual([1, -1]);
    expect(toNdc(1, 1, { left: 0, top: 0, width: 0, height: 10 })).toBeNull();
  });

  it('picks the session under a known point, and nothing on empty floor', () => {
    const camera = topDown();
    const a = box('a', 2, 0, 0);
    const b = box('b', -2, 0, 1);
    expect(pickSession(camera, new Vector2(0.4, 0), [a, b])).toBe('a');
    expect(pickSession(camera, new Vector2(-0.4, -0.2), [a, b])).toBe('b');
    expect(pickSession(camera, new Vector2(0, 0), [a, b])).toBeNull();
  });

  it('takes the nearest hit, and skips what is hidden or carries no pick', () => {
    const camera = topDown();
    const low = box('low', 0, 0, 0);
    const high = box('high', 0, 2, 0);
    const plain = box(null, 0, 4, 0);
    const at = new Vector2(0, 0);
    expect(pickSession(camera, at, [low, high, plain])).toBe('high');
    high.visible = false;
    expect(pickSession(camera, at, [low, high])).toBe('low');
    const parent = new Group();
    parent.add(low);
    parent.visible = false;
    expect(pickSession(camera, at, [low, high])).toBeNull();
  });

  it('picks each desk of a floor through the home camera', () => {
    const fs = new FloorScene(dayTheme());
    const floor = checkoutFloor();
    fs.apply(floor);
    fs.scene.updateMatrixWorld(true);
    const camera = isoCamera(floor.size);
    for (const desk of desksOf(floor)) {
      const a = deskAnchor(desk.rect);
      const p = new Vector3(a.x, 0.74, a.z).project(camera);
      expect(pickSession(camera, new Vector2(p.x, p.y), fs.pickables()), desk.sessionId).toBe(desk.sessionId);
    }
    expect(pickSession(camera, new Vector2(0.98, 0.98), fs.pickables())).toBeNull();
  });
});

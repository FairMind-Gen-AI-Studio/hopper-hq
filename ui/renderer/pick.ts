/**
 * What a click on the canvas lands on: a ray from the camera through the pointer, against the desks, the robots and
 * interns, and the meeting rooms with everyone in them. A hit on an instanced mesh picks what its instance picks.
 */
import { Raycaster, Vector2, type Camera, type Object3D } from 'three';
import type { Target } from './index';
import type { PickData } from './props';

/** A pointer position in an element's box, in normalised device coordinates (-1..1, y up); null for an empty box. */
export function toNdc(clientX: number, clientY: number, box: { left: number; top: number; width: number; height: number }): Vector2 | null {
  if (!(box.width > 0 && box.height > 0)) return null;
  return new Vector2(((clientX - box.left) / box.width) * 2 - 1, -((clientY - box.top) / box.height) * 2 + 1);
}

/**
 * The desk or room of the nearest shown object under `ndc` that picks one, or null on empty floor: a mesh's
 * `userData.pick`, or an instance's entry in its instanced mesh's `userData.picks`. What picks nothing lets the click
 * through.
 */
export function pickTarget(camera: Camera, ndc: Vector2, objects: readonly Object3D[], raycaster = new Raycaster()): Target | null {
  camera.updateMatrixWorld();
  raycaster.setFromCamera(ndc, camera);
  for (const hit of raycaster.intersectObjects(objects as Object3D[], false)) {
    const data = hit.object.userData;
    const pick = (hit.instanceId === undefined ? data.pick : (data.picks as Array<PickData | undefined> | undefined)?.[hit.instanceId]) as PickData | undefined;
    if (pick && (pick.kind === 'desk' || pick.kind === 'room') && typeof pick.id === 'string' && shown(hit.object)) return { kind: pick.kind, id: pick.id };
  }
  return null;
}

/** Visible, and so are all its parents. */
function shown(o: Object3D | null): boolean {
  for (let x = o; x; x = x.parent) if (!x.visible) return false;
  return true;
}

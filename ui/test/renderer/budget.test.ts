import { describe, expect, it } from 'vitest';
import type { InstancedMesh, Mesh, Object3D } from 'three';
import { BLOCKS_MAX, BLOCK_DESKS, INTERNS_MAX, LOUNGE_SEATS, ROOMS_MAX, SEATS_MAX } from '../../../src/scene/layout';
import { FloorScene } from '../../renderer/floor-scene';
import { dayTheme } from '../../renderer/theme';
import { fullestFloor } from './fixtures';

/**
 * What a frame of the fullest floor costs (design §7.1): the fullest floor's counts, as measured, with a tenth to spare,
 * rounded down. It shows 2,871 meshes and 26 instanced meshes, which draw 554 instances, in 2,897 draw calls, and 437 of
 * them cast a shadow.
 */
const BUDGET = { meshes: 3158, draws: 3186, casters: 480 };
/**
 * What its furniture alone costs, the shell, as measured, with a tenth to spare, rounded down: 176 draw calls, 150 meshes
 * and 26 instanced meshes drawing 554 instances, and 23 of them cast a shadow. Robots make most of a frame's draws, so the
 * floor's budget alone would pass furniture drawn as plain meshes.
 */
const SHELL_BUDGET = { draws: 193, casters: 25 };

/** Shown, and so are all its parents. */
function shown(o: Object3D | null): boolean {
  for (let x = o; x; x = x.parent) if (!x.visible) return false;
  return true;
}

/**
 * What the renderer draws of `root`, counted from the scene graph:
 * - meshes: the shown meshes that are not instanced, each drawn on its own;
 * - instanced: the shown instanced meshes with an instance to draw, and instances, how many they draw;
 * - draws: the draw calls of the main pass, one per mesh and one per instanced mesh, every mesh having one material;
 * - casters: the draw calls of the shadow pass, one per shown mesh or instanced mesh that casts a shadow.
 */
function costOf(root: Object3D) {
  let meshes = 0;
  let instanced = 0;
  let instances = 0;
  let casters = 0;
  root.traverse((o) => {
    const mesh = o as Mesh & Partial<InstancedMesh>;
    if (!mesh.isMesh || !shown(mesh)) return;
    if (mesh.isInstancedMesh) {
      if (mesh.count === 0) return;
      instanced++;
      instances += mesh.count!;
    } else meshes++;
    if (mesh.castShadow) casters++;
  });
  return { meshes, instanced, instances, draws: meshes + instanced, casters };
}

/** The fullest floor in a scene, every robot at its place, the camera at home: the two walls that face it are cut away. */
function fullestScene() {
  const fs = new FloorScene(dayTheme());
  fs.apply(fullestFloor());
  return fs;
}

describe('the budget of the fullest floor', () => {
  it('fills every desk of every block, the lounge and every room, with a full table and three interns at every desk but a dormant one, which has its nameplate', () => {
    const fs = fullestScene();
    const floor = fullestFloor();
    const desks = floor.pods.flatMap((p) => p.desks);
    expect([floor.pods.length, desks.length, desks.every((d) => d.occupant !== null)]).toEqual([2 * BLOCKS_MAX, BLOCKS_MAX * BLOCK_DESKS, true]);
    const sessions = [...fs.sessions.values()];
    expect(sessions.filter((e) => e.robot).length).toBe(BLOCKS_MAX * BLOCK_DESKS - 1);
    expect(sessions.filter((e) => e.occupant.state === 'dormant').map((e) => e.desk!.id)).toEqual(['p7-3']);
    expect(fs.scene.children.filter((o) => o.name.startsWith('nameplate ')).map((o) => o.name)).toEqual(['nameplate p7-3']);
    expect(sessions.filter((e) => e.occupant.at.kind === 'lounge').length).toBe(LOUNGE_SEATS);
    expect(sessions.filter((e) => e.occupant.at.kind === 'room').length).toBe(ROOMS_MAX);
    expect(sessions.map((e) => e.interns.size)).toEqual(desks.map((d) => (d.occupant!.state === 'dormant' ? 0 : INTERNS_MAX)));
    expect([...fs.rooms.values()].map((r) => r.agents.size)).toEqual(Array.from({ length: ROOMS_MAX }, () => SEATS_MAX));
  });

  it('draws it within its budget of meshes, draw calls and shadow casters', () => {
    const cost = costOf(fullestScene().scene);
    expect(cost.meshes).toBeLessThanOrEqual(BUDGET.meshes);
    expect(cost.draws).toBeLessThanOrEqual(BUDGET.draws);
    expect(cost.casters).toBeLessThanOrEqual(BUDGET.casters);
  });

  it('draws its furniture within a budget of its own, of draw calls and shadow casters', () => {
    const cost = costOf(fullestScene().shell!.group);
    expect(cost.draws).toBeLessThanOrEqual(SHELL_BUDGET.draws);
    expect(cost.casters).toBeLessThanOrEqual(SHELL_BUDGET.casters);
  });

  it('lets no intern cast a shadow', () => {
    const fs = fullestScene();
    const interns = [...fs.sessions.values()].flatMap((e) => [...e.interns.values()]);
    expect(interns).toHaveLength((BLOCKS_MAX * BLOCK_DESKS - 1) * INTERNS_MAX);
    expect(interns.reduce((n, robot) => n + costOf(robot.group).casters, 0)).toBe(0);
  });
});

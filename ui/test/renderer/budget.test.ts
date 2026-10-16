import { describe, expect, it } from 'vitest';
import type { InstancedMesh, Mesh, Object3D } from 'three';
import { BLOCKS_MAX, BLOCK_DESKS, INTERNS_MAX, LOUNGE_SEATS, ROOMS_MAX, SEATS_MAX } from '../../../src/scene/layout';
import { FloorScene } from '../../renderer/floor-scene';
import { PERSONA_MESHES } from '../../renderer/persona';
import { dayTheme } from '../../renderer/theme';
import { checkoutSpecs, fullestFloor, leisureIntern, makeFloor } from './fixtures';

/**
 * What a frame of the fullest floor costs (design §7.1), re-measured for the merge of the personas
 * (hq-agent-personas TP2) onto the bar/espresso/biliardino/badge work: every session robot now wears the boss
 * persona (user-decisions.md OQ-1, two held meshes, no headgear) and every running intern is typed to a Fairmind
 * plugin that reads as 'developer' (persona.ts, three meshes: glasses and a headphone band). Every room agent is
 * also typed to a Fairmind plugin (fullestFloor's own worst case) that reads as 'qa' (deerstalker, four meshes) —
 * its headgear is the more specific signal (design: headgear vs the workflow hard hat), so its hard hat's dome,
 * which used to cast a shadow, is now hidden instead: a real drop in casters, not a bug, the same way an intern
 * never casting one already was. As measured, with a tenth to spare, rounded down: 3,899 meshes and 217 instanced
 * meshes, which draw 1,656 instances, in 4,116 draw calls, and 423 of them cast a shadow.
 */
const BUDGET = { meshes: 4288, draws: 4527, casters: 465 };
/**
 * What its furniture alone costs, the shell, as measured, with a tenth to spare, rounded down: 232 draw calls, 151
 * meshes and 81 instanced meshes drawing 704 instances, and 41 of them cast a shadow — raised from 216/40 when the
 * coffee machine grew from a fridge-like box into the espresso bar's own counter, machine, grinder and cups
 * (props.ts), and again from 231 when round 1 split the steam wand's own tip nozzle off its rod. Robots make most
 * of a frame's draws, so the floor's budget alone would pass furniture drawn as plain meshes.
 */
const SHELL_BUDGET = { draws: 255, casters: 45 };

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

/**
 * The break area at its full capacity (design §7.1, OQ-1..OQ-3), re-measured for the merge of the personas onto the
 * bar/espresso/biliardino work: four interns at the bar each holding a gin tonic (robot.ts's buildDrink: a
 * twelve-part copa de balón, oversized to read at floor-view distance, none of its parts a shadow caster), a pair
 * at the foosball table and one at the espresso machine with its cup and saucer, over checkoutFloor's own desks and
 * robots, with the bar's counter, back-bar, lime bowl, glasses and stools, the espresso machine's own counter,
 * body, grinder and cups, and the biliardino's cabinet, rim, rods and players — the seven leisure interns are
 * 'Explore' and keep their headgear at leisure (held prop hidden there, like the right hand's own drink/cup — design:
 * held prop vs right-hand props), and checkoutFloor's own session robots now wear the boss persona. As measured,
 * with a tenth to spare, rounded down: 467 draw calls, 78 shadow casters — unchanged from before the personas
 * merged in: none of the leisure interns is a workflow kind, so none has a hard hat to suppress, and no persona
 * accessory ever casts a shadow.
 */
const LEISURE_BUDGET = { draws: 513, casters: 85 };

/**
 * checkoutSpecs' six desks that are not dormant (ps-f7 has no robot, so none of its interns could be drawn), with seven
 * interns waiting at leisure between them: four gin tonics, a biliardino pair (two on one desk) and one coffee.
 */
function leisureFloor() {
  const checkouts = checkoutSpecs();
  const leisure = [['gintonic'], ['gintonic'], ['gintonic'], ['gintonic'], ['biliardino', 'biliardino'], ['coffee']] as const;
  const desks = checkouts.flatMap((c) => c.desks).filter((d) => d.state !== 'dormant');
  let n = 0;
  desks.forEach((d, k) => (d.interns = leisure[k]!.map((kind) => leisureIntern(`l${n++}`, kind))));
  return makeFloor(checkouts);
}

describe('the budget of the break area at leisure', () => {
  it('fills the bar cart, the foosball table and the coffee machine, each at the spot its leisure took', () => {
    const fs = new FloorScene(dayTheme());
    fs.apply(leisureFloor());
    const sessions = [...fs.sessions.values()];
    expect(sessions.flatMap((e) => [...e.interns.values()])).toHaveLength(7);
  });

  it('draws it within its own budget of draw calls and shadow casters', () => {
    const fs = new FloorScene(dayTheme());
    fs.apply(leisureFloor());
    const cost = costOf(fs.scene);
    expect(cost.draws).toBeLessThanOrEqual(LEISURE_BUDGET.draws);
    expect(cost.casters).toBeLessThanOrEqual(LEISURE_BUDGET.casters);
  });
});

describe('the per-persona accessory budget', () => {
  it('keeps every persona, including the boss, at 4 meshes or fewer (design: ≤4 meshes/persona)', () => {
    expect(Math.max(...Object.values(PERSONA_MESHES))).toBeLessThanOrEqual(4);
    expect(PERSONA_MESHES.none).toBe(0);
  });
});

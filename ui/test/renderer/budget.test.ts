import { describe, expect, it } from 'vitest';
import type { InstancedMesh, Mesh, Object3D } from 'three';
import { BLOCKS_MAX, BLOCK_DESKS, INTERNS_MAX, LOUNGE_SEATS, ROOMS_MAX, SEATS_MAX } from '../../../src/scene/layout';
import { FloorScene } from '../../renderer/floor-scene';
import { PERSONA_MESHES } from '../../renderer/persona';
import { dayTheme } from '../../renderer/theme';
import { checkoutSpecs, fullestFloor, fullestFloorOnBrainCall, fullestFloorOnCall, leisureIntern, makeFloor } from './fixtures';

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
 *
 * Re-measured again for the 2026-10-16 boss fix (user-decisions.md OQ-1 revision, "Cappello + cravatta"): the boss
 * traded its hat-less two held meshes (a mug and a 2 cm watch, both invisible whenever a held prop hides or the
 * robot walks) for a bowler hat that is always shown (two headgear meshes, like every other persona) plus the one
 * gold mug held prop — the tie also grew wider and longer for this persona, but as a resize of the same two
 * existing meshes, not a mesh-count change. Net mesh count up by 35 across every boss-persona session robot on
 * the floor (desks, the lounge and seated room hosts): instanced meshes/instances are untouched (no persona ever
 * adds one), and casters are unchanged — the hat and the resized tie are still `{ cast: false }`, same as before.
 * As measured, with a tenth to spare, rounded down: 3,934 meshes and 217 instanced meshes, which draw 1,656
 * instances, in 4,151 draw calls, and 423 of them cast a shadow.
 */
const BUDGET = { meshes: 4327, draws: 4566, casters: 465 };
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
 * The fullest floor again, with every robot that has one also on an MCP call (hq-mcp-switchboard proposal.md §4
 * "Budget impact": "Worst case = every robot on the fullest floor on a call simultaneously"), including a
 * Fairmind call on every intern and room agent `fullestFloor` already types to a Fairmind plugin, so the
 * headset's extra Fairmind-mark mesh (robot.ts HEADSET) is pinned too. As measured, with a tenth to spare,
 * rounded down: 4,121 meshes and 217 instanced meshes, which draw 1,656 instances, in 4,338 draw calls, and 423
 * of them cast a shadow — the same 423 as BUDGET above: the headset's hook and bead, and every per-family VIP
 * form (fairmind-forms.ts), are all `cast: false` (robot.ts), so showing a call on every robot simultaneously
 * raises meshes and draws alone, never casters.
 *
 * Re-measured again for the round-2 enlargement (fairmind-forms.ts, robot.ts FAIRMIND_FORM_Y): every one of
 * these entities is *also* typed to a Fairmind plugin (`fullestFloor`'s own worst case), so each now carries its
 * big call form above the head *and* its own Fairmind badge (fairmind-badge.ts) — and floor-scene.ts hides that
 * badge for as long as the call's own form shows, since the two would otherwise double up the same brand mark in
 * the same screen slot. Net effect per such entity: the badge's own 2 meshes (disc + mark) drop out; the one-mesh
 * default-form mark the MVP already pinned here stays (now bigger, not a new mesh) — two fewer meshes and draws
 * per intern/room-agent entity than before this round (125 of them, 250 meshes), which is why this budget is
 * *lower* than its own pre-round-2 numbers (4,371 / 4,588) rather than higher: enlarging these forms cost no new
 * meshes at all, and replacing the badge with the form saved two.
 *
 * Re-measured a third time for round 3 (robot.ts HEADSET/BOOM_MIC: a dispatched note that the on-call headset
 * itself, not only FairMind's own forms, read as a speck at the floor's own default zoom — the band and the ear
 * cup grew, and a boom mic with a glowing tip joined them, two new meshes per shown headset, Fairmind's call or
 * any other's alike). As measured, with a tenth to spare, rounded down: 4,433 meshes and 217 instanced meshes,
 * which draw 1,656 instances, in 4,650 draw calls, and 423 of them cast a shadow — still the same 423 (the boom's
 * rod and its tip are both `cast: false`, like every other headset mesh). Up by 312 meshes and draws from round 2
 * (4,121 / 4,338): 156 robots carry a call here (every kind the fixture gives one to, Fairmind's or not — the
 * boom mic is the generic headset's own feature, not gated on `call.fairmind` the way `fairmindForms` is), each
 * two meshes heavier.
 */
const SWITCHBOARD_BUDGET = { meshes: 4876, draws: 5115, casters: BUDGET.casters };

describe('the budget of the fullest floor, every robot also on a call', () => {
  it('draws it within its own budget of meshes and draw calls, and never raises the shadow casters', () => {
    const fs = new FloorScene(dayTheme());
    fs.apply(fullestFloorOnCall());
    const cost = costOf(fs.scene);
    expect(cost.meshes).toBeLessThanOrEqual(SWITCHBOARD_BUDGET.meshes);
    expect(cost.draws).toBeLessThanOrEqual(SWITCHBOARD_BUDGET.draws);
    expect(cost.casters).toBeLessThanOrEqual(SWITCHBOARD_BUDGET.casters);
  });
});

/**
 * The same fullest-floor-every-robot-on-a-call worst case, but every Fairmind call is the Brain family — the one
 * per-family VIP form with two meshes instead of one (`fairmind-forms.ts`, hq-mcp-switchboard proposal.md §5
 * Phase 3), the real worst case for Phase 3's own added meshes (every other form costs the same single mesh the
 * MVP's own brand-mark default already did). Re-measured directly, with a tenth to spare, rounded down: 4,246
 * meshes and 217 instanced meshes, which draw 1,656 instances, in 4,463 draw calls, and 423 of them cast a
 * shadow — unchanged from `fullestFloorOnCall`'s own 423 (every form mesh is `cast: false`, so swapping the
 * default mark for the Brain orb on every Fairmind-plugin intern and room agent raises meshes and draws alone,
 * never casters), and still exactly 125 meshes and draws past `fullestFloorOnCall` itself — the same 125
 * Fairmind-plugin interns and room agents, each now one mesh heavier for the Brain orb's own extra gold ring,
 * unaffected by the round-2 badge-hide-while-on-a-call change (that saving, and this one's cost, are independent
 * of each other).
 *
 * Re-measured again for round 3 (HEADSET/BOOM_MIC, SWITCHBOARD_BUDGET's own comment above): the same +312
 * meshes/draws `fullestFloorOnCall` itself picked up (156 robots on a call, two boom-mic meshes each) land here
 * too, independently of the Brain orb's own +125 — 4,246 + 312 = 4,558 meshes, 4,463 + 312 = 4,775 draws, 423
 * casters still (the boom is `cast: false` like everything else on the headset). Comfortably under
 * `SWITCHBOARD_BUDGET` itself (4,876 / 5,115 / 465) — not a new, higher cap, since this worst case never needed
 * one: it is checked against the existing budget, not a raised one.
 */
describe('the budget of the fullest floor, every call the Brain-core orb (hq-mcp-switchboard proposal.md §5 Phase 3)', () => {
  it('draws it within the same switchboard budget, and never raises the shadow casters', () => {
    const fs = new FloorScene(dayTheme());
    fs.apply(fullestFloorOnBrainCall());
    const cost = costOf(fs.scene);
    expect(cost.meshes).toBeLessThanOrEqual(SWITCHBOARD_BUDGET.meshes);
    expect(cost.draws).toBeLessThanOrEqual(SWITCHBOARD_BUDGET.draws);
    expect(cost.casters).toBeLessThanOrEqual(SWITCHBOARD_BUDGET.casters);
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
 *
 * Re-measured again for the 2026-10-16 boss fix (user-decisions.md OQ-1 revision): checkoutSpecs' own session
 * robots now carry the boss's always-shown bowler hat instead of its old hat-less two held meshes, the same net
 * +1-mesh-per-robot trade as the fullest-floor budget above; casters unchanged (the hat and the widened tie still
 * cast none). As measured, with a tenth to spare, rounded down: 474 draw calls, 78 shadow casters.
 */
const LEISURE_BUDGET = { draws: 521, casters: 85 };

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

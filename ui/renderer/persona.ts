/**
 * A sub-agent's costume (design: hq-agent-personas, conductor-plan.md, user-decisions.md): headgear or a face part on
 * its head, a chunky prop in its left hand, and (OQ-3, overriding the original accessories-only plan) its torso
 * recoloured to the role's outfit — the tie stays in the feature colour, the desk's own cue. `src/scene/persona.ts`
 * classifies *which* persona a type string gets; this module only draws it, so the scene model never has to carry one.
 *
 * Every mesh here casts no shadow ({ cast: false }): at a persona's size it would cost a draw for a texel or two of
 * it, same as the hard hat's brim or the cigar. The held prop lives in the left hand (armL) because the right already
 * holds the paper, the gin-tonic glass and lime, or the coffee cup (robot.ts); headgear lives on the neck (the
 * monitor head) and, unlike the held prop, is never hidden by a pose — it is the persona's primary silhouette cue,
 * read at floor distance and on a 0.55-scale intern alike.
 */
import { CylinderGeometry, Group, SphereGeometry, type Material, type Mesh } from 'three';
import { type Persona } from '../../src/scene/persona';
import type { Materials, Surface } from './materials';
import { part, type Geometries, type PartOptions } from './props';

/** Every part is built with this: no persona accessory is worth a shadow draw at its size. */
const NO_CAST: PartOptions = { cast: false };

/**
 * The accessory meshes of one robot's persona: headgear/face parts under `headgearGroup` (parented to the neck,
 * always shown) and the one held prop's meshes under `heldGroup` (parented to armL, hidden in some poses —
 * setPersonaVisible). The flat `headgear`/`held` arrays are the same meshes, for counting (PERSONA_MESHES) and for
 * asserting none of them casts a shadow, without having to traverse two groups to do it.
 */
export interface PersonaRig {
  headgearGroup: Group;
  heldGroup: Group;
  headgear: Mesh[];
  held: Mesh[];
}

/**
 * Mesh count per persona, headgear and held together: the per-persona budget (design: ≤4, none a shadow caster).
 * Exported so the budget test imports it rather than re-counting the cast by hand (ui/test/renderer/budget.test.ts).
 */
export const PERSONA_MESHES: Record<Persona, number> = {
  security: 2,
  techlead: 2,
  reviewer: 3,
  qa: 4,
  debugger: 3,
  librarian: 3,
  designer: 3,
  developer: 3,
  explorer: 3,
  planner: 2,
  generalist: 3,
  boss: 2,
  none: 0,
};

/**
 * The role colour a persona recolours a sub-agent's torso to (OQ-3): a `Surface` of materials.ts. Absent for `boss`
 * and `none` — their body stays the repo colour (materials.ts `body(slot)`), 'boss' because the session's desk
 * identity is the cue there, 'none' because it is today's plain look. Most personas reuse an existing surface
 * outright, already shared with other furniture and robots; only the five with no close enough token get their own
 * (materials.ts, appended at the end of SURFACES).
 */
export const PERSONA_BODY: Partial<Record<Persona, Surface>> = {
  security: 'monitor',
  techlead: 'outfitTechlead',
  reviewer: 'leg',
  qa: 'wood',
  debugger: 'outfitDebugger',
  librarian: 'outfitLibrarian',
  designer: 'outfitDesigner',
  developer: 'jet',
  explorer: 'outfitExplorer',
  planner: 'outfitPlanner',
  generalist: 'chair',
};

/** Personas whose headgear should suppress the workflow hard hat (robot.ts): every persona but 'none' and 'boss' (hat-less by design, user-decisions.md OQ-1) has one. */
const HEADGEAR_PERSONAS = new Set<Persona>(['security', 'techlead', 'reviewer', 'qa', 'debugger', 'librarian', 'designer', 'developer', 'explorer', 'planner', 'generalist']);

/** `true` when this persona's headgear should suppress the workflow hard hat (robot.ts). */
export function hasHeadgear(persona: Persona): boolean {
  return HEADGEAR_PERSONAS.has(persona);
}

/** A half-dome, shared by every headgear built from one (campaign hat, deerstalker, pith helmet, cap). */
function halfDome(geo: Geometries, key: string, r: number) {
  return geo.shared(key, () => new SphereGeometry(r, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2));
}

/** A flattened half-dome, for a beret or a judge's wig: a half-dome squashed in y. */
function flatDome(geo: Geometries, key: string, r: number, squash: number) {
  return geo.shared(key, () => new SphereGeometry(r, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, squash, 1));
}

/** A flat disc, for a palette or a hat's brim: a short, wide cylinder. */
function disc(geo: Geometries, key: string, r: number, h = 0.012) {
  return geo.shared(key, () => new CylinderGeometry(r, r, h, 20));
}

/**
 * Builds a persona's accessories under `neck` (headgear) and `armL` (the held prop), 'none' building nothing. Every
 * part is `{ cast: false }` (no persona is worth a shadow draw at its size) and both groups start visible —
 * `setPersonaVisible` and the pose functions in robot.ts toggle `heldGroup` per pose; `headgearGroup` never hides.
 */
export function buildPersona(neck: Group, armL: Group, persona: Persona, geo: Geometries, mats: Materials): PersonaRig {
  const s = mats.surface;
  const headgearGroup = new Group();
  headgearGroup.name = 'persona-headgear';
  neck.add(headgearGroup);
  const heldGroup = new Group();
  heldGroup.name = 'persona-held';
  armL.add(heldGroup);
  const headgear: Mesh[] = [];
  const held: Mesh[] = [];
  const head = (geometry: Parameters<typeof part>[1], material: Material, x: number, y: number, z: number, opts?: PartOptions) =>
    headgear.push(part(headgearGroup, geometry, material, x, y, z, { ...NO_CAST, ...opts }));
  const hand = (geometry: Parameters<typeof part>[1], material: Material, x: number, y: number, z: number, opts?: PartOptions) =>
    held.push(part(heldGroup, geometry, material, x, y, z, { ...NO_CAST, ...opts }));
  // The hand's rest, by the spot armR already holds the paper/glass/cup at (robot.ts): the mirror spot on armL.
  const HAND = { y: -0.29, z: 0.05 };

  switch (persona) {
    case 'security':
      // Wraparound sunglasses over the visor — a lighter, glossier bar than the near-black face plate behind it, or
      // the two would blend into one dark smear — and a single metal earpiece at the side of the head. Shrunk to
      // 0.04 tall (was 0.052) so its bottom edge (0.19) clears the cigar rod's top edge (0.187, robot.ts CIGAR) —
      // the two would otherwise interpenetrate by a few millimetres whenever this persona is also smoking.
      head(geo.box(0.21, 0.04, 0.018), s.frame, 0, 0.21, 0.142);
      head(geo.ball(0.022), s.frame, 0.2, 0.215, 0.07);
      break;
    case 'techlead':
      // A campaign ("Smokey Bear") hat: a wide flat brim and a dome, wood-tan like a ranger's felt.
      head(disc(geo, 'campaign brim', 0.22, 0.018), s.wood, 0, 0.325, 0);
      head(halfDome(geo, 'campaign dome', 0.15), s.wood, 0, 0.345, 0);
      break;
    case 'reviewer':
      // A judge's white wig, and a gavel (a wood handle, a dark head) in the left hand.
      head(flatDome(geo, 'wig', 0.165, 0.6), s.paper, 0, 0.32, 0);
      hand(geo.rod(0.012, 0.012, 0.16), s.wood, 0, HAND.y, HAND.z, { rx: Math.PI / 2.4 });
      hand(geo.box(0.045, 0.035, 0.045), s.leg, 0, HAND.y - 0.07, HAND.z + 0.06);
      break;
    case 'qa':
      // A deerstalker (tweed dome and one squashed ear flap) and a magnifying glass (a metal ring, a wood handle).
      head(halfDome(geo, 'deerstalker dome', 0.145), s.wood, 0, 0.335, 0);
      head(flatDome(geo, 'deerstalker flap', 0.08, 0.6), s.wood, 0, 0.3, -0.13);
      hand(geo.ring(0.03, 0.045), s.frame, 0, HAND.y + 0.08, HAND.z + 0.05);
      hand(geo.rod(0.014, 0.014, 0.1), s.wood, 0, HAND.y - 0.02, HAND.z + 0.05, { rx: Math.PI / 2.6 });
      break;
    case 'debugger':
      // Gas-mask goggles over the visor — lighter than the near-black face plate behind them, or the two blend into
      // one dark smear — and a filter canister on the cheek (a NATO-mask side filter, not a front-facing one: its
      // straight-ahead mouth position used to sit right in the cigar's path, robot.ts CIGAR — so it moved to the
      // side, whose x-range (0.084–0.136) clears the cigar's (-0.022–0.022) outright whenever this persona smokes);
      // a thin spray wand in the left hand. The goggles are shrunk to 0.04 tall (was 0.06) so their bottom edge
      // (0.19) also clears the cigar rod's top edge (0.187) — the same fix as security's/developer's own glasses.
      head(geo.box(0.22, 0.04, 0.02), s.frame, 0, 0.21, 0.14);
      head(geo.rod(0.026, 0.026, 0.05, 12), s.leg, 0.11, 0.19, 0.14, { rx: Math.PI / 2 });
      hand(geo.rod(0.013, 0.013, 0.18), s.frame, 0, HAND.y, HAND.z, { rx: Math.PI / 2.2 });
      break;
    case 'librarian':
      // Small reading glasses on the visor — lighter than the face plate behind them, for contrast — and an open
      // book (two angled pages) in the left hand. At the visor's own height (0.21, like security's/developer's own
      // glasses) rather than lower (0.185): lower put their bottom edge inside the cigar rod's span (robot.ts
      // CIGAR, y 0.143–0.187) whenever this persona is also smoking; 0.21 clears it by a margin.
      head(geo.box(0.17, 0.035, 0.012), s.frame, 0, 0.215, 0.14);
      hand(geo.box(0.1, 0.012, 0.13), s.paper, -0.04, HAND.y, HAND.z, { ry: -0.35, rx: 0.2 });
      hand(geo.box(0.1, 0.012, 0.13), s.paper, 0.04, HAND.y, HAND.z, { ry: 0.35, rx: 0.2 });
      break;
    case 'designer':
      // A flat beret with its little stalk, and a palette (a flat disc) in the left hand.
      head(flatDome(geo, 'beret', 0.155, 0.5), s.couch, 0.02, 0.33, -0.02);
      head(geo.ball(0.014), s.couch, 0.03, 0.365, -0.02);
      hand(disc(geo, 'palette', 0.07, 0.015), s.board, 0, HAND.y, HAND.z, { rx: 0.3 });
      break;
    case 'developer':
      // Thick glasses over the visor — lighter than the face plate behind them, for contrast — and a dark headphone
      // cup either side of the head, against the light shell there. Shrunk to 0.04 tall (was 0.048) so its bottom
      // edge (0.19) clears the cigar rod's top edge (0.187, robot.ts CIGAR), the same fix as security's sunglasses.
      head(geo.box(0.2, 0.04, 0.016), s.frame, 0, 0.21, 0.139);
      head(geo.ball(0.035), s.leg, 0.195, 0.21, 0.05);
      head(geo.ball(0.035), s.leg, -0.195, 0.21, 0.05);
      break;
    case 'explorer':
      // A pith helmet, cream-pale (not the techlead's campaign-hat brown, or the two would read as the same tan hat
      // at a distance): a dome and a thin wide brim. Binoculars, one bridging box, in the left hand.
      head(halfDome(geo, 'pith dome', 0.15), s.board, 0, 0.335, 0);
      head(disc(geo, 'pith brim', 0.2, 0.014), s.board, 0, 0.3, 0);
      hand(geo.box(0.1, 0.045, 0.05), s.leg, 0, HAND.y, HAND.z, { rx: Math.PI / 2 });
      break;
    case 'planner':
      // A pencil behind the ear — bolder than a real one (design: avoid thin details under ~2cm, interns scale to
      // 0.55) so it still reads at a distance — and a blueprint roll (a pale blue tube) under the left arm. `s.blueprint`
      // is opaque (materials.ts) — `s.glass`, the gin-tonic glass's own 28%-opacity recipe, made the roll nearly
      // invisible, the persona's only held-prop cue gone (QA + code review, both independently).
      head(geo.rod(0.013, 0.013, 0.15), s.frame, 0.2, 0.24, 0.04, { rx: Math.PI / 2.3, ry: 0.3 });
      hand(geo.rod(0.025, 0.025, 0.22), s.blueprint, 0, HAND.y, HAND.z, { rx: Math.PI / 2 });
      break;
    case 'generalist':
      // A cap (half-dome and a peak) and a wrench, both in the handyman's own blue.
      head(halfDome(geo, 'cap dome', 0.145), s.chair, 0, 0.335, 0);
      head(geo.box(0.1, 0.03, 0.05), s.chair, 0, 0.32, 0.12);
      hand(geo.rod(0.016, 0.022, 0.16), s.frame, 0, HAND.y, HAND.z, { rx: Math.PI / 2.4 });
      break;
    case 'boss':
      // No headgear (hat-less, user-decisions.md OQ-1): a gold mug and a gold watch in the left hand.
      hand(geo.rod(0.045, 0.04, 0.07), s.bossGold, 0, HAND.y, HAND.z);
      hand(geo.rod(0.02, 0.02, 0.014), s.bossGold, 0, HAND.y - 0.09, HAND.z);
      break;
    case 'none':
      break;
  }
  return { headgearGroup, heldGroup, headgear, held };
}

/** Toggles a persona's two groups; robot.ts only ever asks for `headgear: true` — it is the primary silhouette cue. */
export function setPersonaVisible(rig: PersonaRig, visible: { headgear: boolean; held: boolean }): void {
  rig.headgearGroup.visible = visible.headgear;
  rig.heldGroup.visible = visible.held;
}

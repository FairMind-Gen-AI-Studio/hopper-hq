/**
 * A session's robot, from primitives (prototypes/floor-3d-mockup.html, dressBot): a monitor head with a glowing
 * visor, a body in the repo colour and a tie in the feature colour. At its place, each state has one pose (outline
 * §2.6), set by rotating the limb pivots, and a small loop it runs there (design §6.2); on its way there, it strides,
 * swinging its legs and arms.
 * Two smaller kinds share the build: a workflow agent wears a hard hat, and an intern flies on a jetpack, without legs.
 */
import { CylinderGeometry, Euler, Group, InstancedMesh, LatheGeometry, Mesh, Object3D, Quaternion, SphereGeometry, Vector2, type Material } from 'three';
import { type Persona } from '../../src/scene/persona';
import type { OnCallView, Pose, Robot } from '../../src/scene/types';
import { BADGE } from './fairmind-badge';
import { attachFairmindForms, orientFairmindForms, setFairmindForm, type FairmindForms } from './fairmind-forms';
import type { Materials } from './materials';
import { PERSONA_BODY, buildPersona, hasHeadgear, setPersonaVisible, type PersonaRig } from './persona';
import { part, type Geometries, type PickData } from './props';
import { SEAT_Y, isStanding, type Spot } from './world';

/** Body measures: hip and torso heights, shoulder and leg offsets from the middle, and arm length. */
export const BOT = { hip: 0.34, torso: 0.36, shoulderX: 0.22, legX: 0.09, arm: 0.32 } as const;

/** A session's own robot, a workflow agent at a meeting table, or an intern hovering by its desk. */
export type RobotKind = 'session' | 'intern' | 'workflow';

/**
 * A robot's look, as the renderer builds and poses it: `Robot` (the wire type, outline §2.6) plus
 * whether it holds a lit cigar, and which persona's costume it wears. Neither stays in the shared
 * `Robot` type — `smoking` never goes over the wire on its own (the server sends it as
 * `Occupant`/`Intern`/`MeetingAgent.smoking`, src/scene/types.ts); `persona` is never sent at all
 * (src/scene/persona.ts, a pure function of the agent-type string the renderer already has). `call`
 * (hq-mcp-switchboard proposal.md §4) does go over the wire, as `Occupant`/`Intern`/`MeetingAgent.call`
 * (src/scene/types.ts `OnCallView`), carried through here only so `floor-scene.ts`'s one `cast()` pass can read
 * it off the same `look` it already builds, next to `smoking`. All three optional, so every existing look literal
 * reads as not smoking, persona 'none', and no call.
 */
export type Look = Robot & { smoking?: boolean; persona?: Persona; call?: OnCallView | null };
/** How big each kind stands. */
export const KIND_SCALE: Readonly<Record<RobotKind, number>> = { session: 1, intern: 0.55, workflow: 0.8 };
/** How high an intern floats: its feet would be here, and its body above the top of the desk's monitor. */
export const HOVER_Y = 1.2;

/**
 * Pivot rotations of a pose, in radians. Arms are [x, z]: a negative x swings a limb forward and z splays an arm.
 * A positive neck bows the head; a negative lean tips the upper body back.
 */
export interface PoseSpec {
  armL: readonly [number, number];
  armR: readonly [number, number];
  legs: number;
  neck: number;
  lean: number;
  /** Holds a sheet of paper: the result, ready for review. */
  paper: boolean;
}

export const POSES: Record<Pose, PoseSpec> = {
  typing: { armL: [-1.25, -0.02], armR: [-1.25, 0.02], legs: -1.45, neck: 0, lean: 0, paper: false },
  waving: { armL: [0.05, -0.1], armR: [-2.8, 0.25], legs: 0, neck: 0, lean: 0, paper: false },
  holding: { armL: [-1, 0.18], armR: [-1, -0.18], legs: 0, neck: 0, lean: 0, paper: true },
  still: { armL: [-1.1, -0.1], armR: [-1.1, 0.1], legs: -1.45, neck: 0, lean: 0, paper: false },
  resting: { armL: [-0.3, -0.25], armR: [-0.3, 0.25], legs: -1.45, neck: -0.1, lean: -0.22, paper: false },
  /**
   * At the bar cart (design §7.1, leisure): standing, relaxed, its forearm raised forward and a little out
   * from the body — a "cheers"/about-to-sip angle — so the glass (buildDrink, GLASS.hand) stands in clear
   * space in front of its chest and shoulder, well clear of the head's own box. The head sits in roughly
   * [-0.19, 0.19] x, [0.42, 0.70] y, [-0.13, 0.13] z of the waist frame (BOT, buildRobot's own head part);
   * this swing (checked against GLASS.hand's own anchor point, armR's pivot plus its rotation) puts the
   * glass's anchor at about (0.38, 0.09, 0.25) in that same frame — clear of the head on all three axes,
   * independently, with the glass's own belly (half as wide again) still short of the head's x bound —
   * before the rest of the glass's own height is even added on top of the anchor.
   */
  gintonic: { armL: [-0.3, -0.25], armR: [-0.8, 0.45], legs: 0, neck: -0.1, lean: -0.15, paper: false },
  /**
   * Leaning over the foosball table's handle, both forearms reaching out and down; the table's rods are props.ts's
   * furniture, at world.ts's FOOSBALL_ROD_Y. A session's hand lands there at this bend, and an intern's (floating
   * at FOOSBALL_HOVER_Y below, rather than standing) matches it too — checked by forward kinematics, not
   * eyeballed: bending the forearm further, past this, would only lower the hand again. A workflow robot, smaller
   * (KIND_SCALE.workflow), needs a deeper bend of its own (BILIARDINO_BY_KIND, below) to reach the same height;
   * every kind's remaining horizontal gap to the handle is closed separately, by BILIARDINO_REACH.
   */
  biliardino: { armL: [-1.6, 0.14], armR: [-1.6, -0.14], legs: 0, neck: 0.1, lean: 0.12, paper: false },
  /** At the coffee machine: standing, its cup in its right hand. */
  coffee: { armL: [-0.25, -0.2], armR: [-0.9, -0.15], legs: 0, neck: -0.08, lean: -0.1, paper: false },
};

/**
 * The biliardino pose, per kind. Session and intern reach `FOOSBALL_ROD_Y` with `POSES.biliardino`'s own bend
 * (`armX` -1.6 rad) unchanged: intern plays from `FOOSBALL_HOVER_Y` instead of standing (`rootHeight`, below), so
 * at its own scale the same bend lands its hand at the same height session's does, standing. A workflow robot, at
 * `KIND_SCALE.workflow` = 0.8, cannot reach as high with that bend — the same rotation swings a shorter arm a
 * shorter vertical distance — so it bends further still, to -2.104 rad (reaching further overhead, not further
 * down): checked by forward kinematics against `FOOSBALL_ROD_Y` (robot.test.ts), not eyeballed, for every kind,
 * not just session as the pose's own comment used to claim. `BILIARDINO_REACH` (below) separately closes each
 * kind's remaining horizontal gap; this table only closes the vertical one.
 */
const BILIARDINO_BY_KIND: Readonly<Record<RobotKind, PoseSpec>> = {
  session: POSES.biliardino,
  intern: POSES.biliardino,
  workflow: { ...POSES.biliardino, armL: [-2.104, POSES.biliardino.armL[1]], armR: [-2.104, POSES.biliardino.armR[1]] },
};

/** A still robot with no signal (the clock badge) hangs its head; one in a meeting does not. */
export const HEAD_DOWN = 0.3;
const DOZING: PoseSpec = { ...POSES.still, neck: HEAD_DOWN };

/**
 * The pose of a robot's look: one object per look (and, at the biliardino pose, per kind too), so that posing a
 * robot in every frame allocates nothing.
 */
export function poseOf(robot: Pick<Robot, 'pose' | 'badge'>, kind: RobotKind = 'session'): PoseSpec {
  if (robot.pose === 'still' && robot.badge === 'clock') return DOZING;
  return robot.pose === 'biliardino' ? BILIARDINO_BY_KIND[kind] : POSES[robot.pose];
}

/**
 * How high an intern floats while it plays foosball: low enough that its hand, at its own small scale and the
 * biliardino pose's bend, meets the table's rods at FOOSBALL_ROD_Y (world.ts) — nothing like its desk's HOVER_Y,
 * which would leave its hands a metre above the handles. Measured the same way as the pose itself (by forward
 * kinematics, not eyeballed): an intern has no legs to stand on, so unlike session and workflow it needs a root
 * height of its own at this one pose.
 */
export const FOOSBALL_HOVER_Y = 0.28;

/**
 * How high an intern floats at the coffee machine: low enough that its body, and the cup in its hand (the coffee
 * pose's own bend), sit at about the counter's own top (world.ts's COFFEE_COUNTER_H), not its desk's HOVER_Y — a
 * hover meant for floating over a desk and its monitor, a good half a metre above any counter. Without it an intern
 * at this pose floats at head height over the machine instead of standing at it, the same mismatch FOOSBALL_HOVER_Y
 * fixes at the table.
 */
export const COFFEE_HOVER_Y = 0.3;

/**
 * How far past its stand spot (`foosballSpots`, world.ts) each kind leans in, in z, to put its hand on the near
 * handle at the biliardino pose: the pose's own bend (`BILIARDINO_BY_KIND`) and a standing kind's floor-level root
 * both leave a shorter kind further from the handle than a taller one — closing the same vertical gap by bending
 * the arm further still would, past a point, only lower the hand again (POSES.biliardino's own comment), so the
 * rest of the gap is closed here instead, by standing closer in. Checked against `FOOSBALL_REACH` (world.ts) by
 * forward kinematics (robot.test.ts), not eyeballed; zero at every pose but this one.
 */
export const BILIARDINO_REACH: Readonly<Record<RobotKind, number>> = { session: 0.072, workflow: 0.163, intern: 0.231 };

/** Height of the robot's feet: a seated robot sinks until its hips, at its size, rest on the chair; an intern hovers,
 * low over the foosball table's own rods or the coffee counter's own top, desk-high everywhere else. */
export function rootHeight(pose: Pose, kind: RobotKind = 'session'): number {
  if (kind === 'intern') return pose === 'biliardino' ? FOOSBALL_HOVER_Y : pose === 'coffee' ? COFFEE_HOVER_Y : HOVER_Y;
  return isStanding(pose) ? 0 : SEAT_Y - BOT.hip * KIND_SCALE[kind];
}

export interface RobotRig {
  legL: Group;
  legR: Group;
  /** Holds the torso, the arms, the head and the tie; leans from the hips. */
  waist: Group;
  armL: Group;
  armR: Group;
  neck: Group;
  paper: Mesh;
  /** A laptop on the meeting table in front of the robot: shown only while it sits at a room's table. */
  laptop: Group;
  /** The cigar at the monitor-head's mouth, its lit tip and its smoke puff: shown while its look holds one (setSmoking), in any pose. */
  cigar: Group;
  /** The smoke above the cigar's tip, a column of puffs (PUFF) that rise, grow and vanish (animateRobot) while the cigar shows; a still column otherwise. */
  puff: InstancedMesh;
  /** The on-call headset's band, ear cup and boom mic (HEADSET, BOOM_MIC), at the ear: shown and recoloured by
   * `setOnCall`, in any pose, without rebuilding. Round-2 enlargement (see `FAIRMIND_FORM_Y`) moved FairMind's own
   * big per-family read to `fairmindForms`, above the head; round-3 enlargement grew this headset itself — every
   * call, not only FairMind's — into a proper gaming-headset silhouette (band, cup, boom, glowing tip), legible at
   * the floor's own default zoom on its own. */
  headset: Group;
  /** The headset's band: `setOnCall` recolours it together with the cup and the boom's own tip, so the whole headset reads as one colour. */
  headsetHook: Mesh;
  /** The headset's ear cup alone: `setOnCall` recolours it (with the band and the boom's tip) and resets its pulse scale; `animateRobot` pulses it while it shows. */
  headsetBead: Mesh;
  /** The boom mic's own rod (BOOM_MIC): the robot's own plastic (`s.shell`), never recoloured by the call — a
   * physical boom, not a signal. */
  headsetMic: Mesh;
  /** The boom mic's own tip (BOOM_MIC.tip): the "glowing on-air bead" a dispatched note asked for — `setOnCall`
   * recolours it the same as the band and the cup, the third and last mesh that colour touches. */
  headsetMicTip: Mesh;
  /** The default (family-less) VIP form — the Fairmind mark alone, at the real badge's own mark scale
   * (`fairmind-badge.ts` `BADGE.mark`, reused by `fairmind-forms.ts`): `fairmindForms.byKey.default`, kept under
   * its own field name since `ui/test/renderer/robot.test.ts` already addresses it this way (the MVP's own field,
   * unchanged name, enlarged and relocated meaning). No longer "on the bead" — like every other form, it now sits
   * on `fairmindForms.group`, above the head. */
  headsetMark: Mesh;
  /** The call's family-specific VIP form (hq-mcp-switchboard proposal.md §5 Phase 3; `fairmind-forms.ts`), shown
   * instead of `headsetMark` once the call's family picks one. Parented directly on the robot's own top-level
   * group, not the neck and not `headset` (round-2 enlargement): at `FAIRMIND_FORM_Y`, the same screen slot and
   * the same "never tips or nods with the head" reasoning `fairmind-badge.ts` gives its own badge — a form that
   * rode the neck would bow with `POSES`' own neck tilt and `LOOPS.breathe`/`doze`'s nod, which a brand display
   * above the head should not. `animateRobot` pulses this whole group the same way it pulses `headsetBead`, so a
   * shown form reads its call's read/write direction too; `floor-scene.ts` turns it to face the camera every
   * frame (`orientFairmindForms`), the same billboard the badge gets. */
  fairmindForms: FairmindForms;
  /** `true` while the shown call is a write (animateRobot's pulse direction): meaningless while `headset` is hidden. Not part of the wire `OnCallView`
   * itself — the one bit `animateRobot` needs that `headset.visible` does not already carry. */
  headsetWrite: boolean;
  /** `true` while the shown call is Fairmind's (animateRobot pulses `fairmindForms.group` only then): meaningless
   * while `headset` is hidden — `setOnCall` always toggles the two together, even though `fairmindForms.group` no
   * longer lives under `headset` in the scene graph. */
  headsetFairmind: boolean;
  /** The headset's own colour, by the call it is given (materials.ts `lineColor`, with the dropped-call flash and Fairmind's fixed teal both folded in):
   * closed over `mats` at build time so `setOnCall(obj, call)` stays the same two-argument shape as `setSmoking`. */
  headsetColor: (call: OnCallView) => Material;
  /** Its gin tonic (buildDrink), in its right hand: shown only in the gintonic pose. */
  drink: Group;
  /** Its coffee cup and saucer, in its right hand, counter-rotated against the coffee pose's own arm swing the same
   * way the drink is against gintonic's: shown only in the coffee pose. */
  cup: Group;
  /** Its persona's accessories (persona.ts): headgear on the neck, always shown, and a held prop on armL, hidden in some poses. */
  persona: PersonaRig;
  /** A workflow agent's hard-hat meshes (empty for every other kind): hidden when its persona has its own headgear. */
  hardHat: Mesh[];
}

/**
 * The cigar at the monitor-head's mouth, in the neck's frame (prototypes/floor-3d-mockup.html has
 * no equivalent: a running joke, "mega sigaro"): a short fat cylinder jutting forward from below
 * the visor, a small glowing tip at its end, sized to clear the head's own front face (the visor
 * reaches to z 0.141) without pushing a robot's bounding box past its desk cell.
 */
export const CIGAR = { r: 0.022, len: 0.08, y: 0.165, z: 0.16 } as const;
/** The lit tip, just past the cigar's far end. */
export const CIGAR_TIP = { r: 0.013, z: CIGAR.z + CIGAR.len / 2 + 0.006 } as const;
/**
 * The smoke above the tip, smoke-signal style: `puffs` balls, one instanced mesh, each rising `rise` m over `1/rate`
 * seconds, a `1/puffs` of a cycle apart, drifting `drift` m forward as it goes. A puff grows as it rises, by up to
 * `grow` times its size, and its scale is also a sine of its cycle so it starts from and shrinks back to nothing —
 * the only way to "fade" a mesh that shares its material with every other robot's smoke (materials.ts), and the reset
 * at each cycle's ends is never seen (it is scaled to ~0 there).
 */
export const PUFF = { puffs: 7, r: 0.045, rise: 0.8, grow: 1.6, drift: 0.06, rate: 0.45, y: CIGAR.y + 0.03, z: CIGAR_TIP.z + 0.01 } as const;

/**
 * The on-call headset (hq-mcp-switchboard proposal.md §4 "Meshes"): an earpiece at the robot's own left ear — "an
 * earpiece bead at the ear" (singular) reads as one bluetooth-style earpiece, not a double-sided over-head band,
 * so persona.ts's own single-earpiece precedent (security's `head(geo.ball(0.022), s.frame, 0.2, 0.215, 0.07)`,
 * the mirror side) is the template, not the hard hat's dome. `x` is negative (persona.ts's security earpiece sits
 * at the positive mirror) so the two never share one spot when both show; `y`/`z` lift it a little above and in
 * front of the visor's own height (0.21, z 0.137) — just past where `typing`'s forearm swings (POSES.typing: the
 * shoulder's own waist-local y tops out at 0.31, well under this) — so it clears the camera's default
 * `HOME_AZIMUTH` (world.ts, π/4) view of a working robot's own arm, the floor's single most common pose. `x` sits
 * 0.04 past the head's own half-width (0.19, robot.ts `rbox`), a deliberately generous protrusion: a sliver as
 * thin as the head's own silhouette margin (the first-cut 0.01) read, at floor distance, as nothing at most
 * azimuths — confirmed by rendering it (ui/lab, hq-mcp-switchboard round 1) before this round's numbers.
 *
 * Round-3 enlargement (a dispatched note: "la cuffietta non si vede molto" — the generic on-call headset, not
 * only FairMind's own forms, read as a speck at the floor's own default zoom): `beadR` (the ear cup) grew from
 * 0.03 to 0.052 and `hookTube` (the band's own thickness) from 0.01 to 0.02, a visibly chunkier cup and band.
 * `hookR` (the band's own radius) only grew a little, from 0.04 to 0.05 — not nearly double, like the cup and the
 * tube — because the band's own *peak* (`y + hookR`) is the one measurement here that has to clear a hat: it
 * moves from 0.27 to 0.28, still under 0.293, explorer's pith brim (the lowest hat edge in the codebase,
 * persona.ts) — so "taller" spent its whole budget on 0.01 of headroom and put the rest of the size increase into
 * thickness instead, exactly the fallback a bigger band without more headroom calls for. `beadR`'s own new 0.052
 * needs no such ceiling: the cup sits at `y` (0.23), its top at 0.23 + 0.052 = 0.282, still under 0.293 by 0.011 —
 * a cup can grow up to that same ceiling with room to spare, since (unlike the band's own apex) a ball's widest
 * point is at its own centre height, not above it. `BOOM_MIC` (below) carries the rest of this round's own
 * visibility past the band and the cup alone: a boom mic toward the mouth, lit at its own tip — the "glowing
 * on-air bead" the note asked for — needs no hat clearance either, sitting at or below the visor's own height,
 * the same safe zone the MVP's small bead already occupied.
 *
 * Only one ear cup, not two: a second cup on the right ear, at `persona.ts`'s own `x: 0.2` mirror, would sit
 * almost exactly where the security persona's own sunglasses earpiece already does (`head(geo.ball(0.022), ...,
 * 0.2, 0.215, 0.07)`) — the very collision the single-earpiece design was chosen to dodge in round 1. "Bigger ear
 * cups" (plural, in the note) reads as the style this is reaching for — a proper headset silhouette, not a
 * literal second cup — which the boom mic (the other half of a real gaming headset's own silhouette) carries
 * the rest of the way without having to add a second cup and reopen that collision.
 */
export const HEADSET = { x: -0.23, y: 0.23, z: 0.08, beadR: 0.052, hookR: 0.05, hookTube: 0.02, hookArc: Math.PI * 1.3 } as const;

/**
 * The boom mic (round-3 enlargement, HEADSET's own doc comment): a thin rod from the ear cup toward the mouth,
 * tipped with a bright bead in the call's own colour — the "glowing on-air bead" a dispatched note asked for,
 * reusing the same material the cup and the band already recolour with (`setOnCall`), so it needs no material of
 * its own and no extra step to stay in step with them. The rod itself (`s.shell`, the robot's own plastic, never
 * recoloured by the call) is a physical boom, not a signal; only its tip lights up. Placed and tilted by eye (ui/
 * lab, hq-mcp-switchboard round 3) to run from the ear cup down and forward, its tip landing just past the
 * visor's own front face (z 0.137, robot.ts head) and short of the face's own centreline (x 0), the way a real
 * boom mic reaches toward the corner of the mouth, not across it — clear of the cigar (CIGAR, x 0 ± 0.011, z
 * 0.12-0.2) at every x past -0.04, which the tip's own -0.075 keeps to. Neither the rod nor its tip needs to
 * clear a hat: both sit at or below the visor's own height (0.21), the same safe zone the MVP's small bead
 * already occupied, well under every hat's own lowest edge (0.293).
 */
export const BOOM_MIC = { rod: { r: 0.011, len: 0.18 }, x: -0.15, y: 0.19, z: 0.13, rx: 1.25, ry: -0.6, tip: { r: 0.027, x: -0.075, y: 0.165, z: 0.172 } } as const;

/**
 * Where the enlarged per-family call form (`fairmind-forms.ts`) sits, above the head — round-2 enlargement: the
 * MVP drew these forms on the headset bead itself (HEADSET), small enough there to read as a stray dot at the
 * floor's own default zoom. Built on `fairmind-badge.ts`'s own `BADGE.y.workflow`, the height that already clears
 * the tallest headgear in the codebase: a persona's headgear sits on `neck` at the same local offset whichever
 * `RobotKind` wears it (`buildPersona(neck, ...)` is kind-agnostic; `KIND_SCALE` is a transform on the whole
 * robot group, applied *after* this local frame, not a per-kind change to it), so the one number `fairmind-
 * badge.ts` already measured to clear `workflow`'s own hard hat (dome top at 1.195) also clears `techlead`'s
 * campaign hat, tied with it at the same 1.195 — the global maximum, taller than `boss`'s bowler at 1.17, `qa`'s
 * deerstalker and `generalist`'s cap at 1.18, or `explorer`'s pith helmet at 1.185 — for every kind alike,
 * including `'session'`, which never gets the badge itself (`fairmind-badge.ts` `attachFairmindBadge` returns
 * null for it) but can wear any of those personas, and show a call form here, all the same.
 *
 * `+0.05` past that reused number: the badge's own margin over the tallest hat (0.145, `BADGE.y.workflow` 1.34
 * less the hat's 1.195) was tuned for its own 0.14-radius disc; the biggest of these forms (General's pane, a
 * 0.22-tall standing box) reaches 0.11 either way from its own centre, almost as much as the disc's whole radius,
 * so the same margin number would leave it only ~0.035 clear of the tallest hat instead of the disc's own 0.145 —
 * the extra 0.05 restores a comparable margin (General's own form bottom then clears every hat by ~0.085; the
 * Studio roll, tilted, by a similar amount; every other form, smaller still, by more).
 */
export const FAIRMIND_FORM_Y = BADGE.y.workflow + 0.05;

/**
 * The bead's pulse while a call is live (hq-mcp-switchboard proposal.md §2 "a gentle bead pulse; read vs write is
 * shown as pulse direction"): a forward-only sine, like `LOOPS.breathe`, so it never dips below its resting size.
 * `amp` is the fraction of the resting scale it pulses by, shrinking for a read (inward) and growing for a write
 * (outward, animateRobot's own `dir`).
 */
export const CALL_PULSE = { rate: 2.4, amp: 0.3 } as const;

/** A puff `frac` of the way through its cycle: how high above PUFF.y, how far ahead of PUFF.z, and how big. */
export function puffAt(frac: number): { y: number; z: number; scale: number } {
  return { y: frac * PUFF.rise, z: frac * PUFF.drift, scale: (1 + frac * PUFF.grow) * Math.sin(frac * Math.PI) };
}

const puffDummy = new Object3D();

/**
 * Places each of the smoke's puffs at its point of the cycle, `base` (a fraction of a cycle) on, or, with `base` null,
 * shrinks them all to nothing at the tip: a robot that does not smoke keeps no tall column in its bounds. It allocates
 * nothing.
 */
function placePuffs(puff: InstancedMesh, base: number | null): void {
  for (let i = 0; i < PUFF.puffs; i++) {
    const frac = base === null ? 0 : (((base + i / PUFF.puffs) % 1) + 1) % 1;
    const p = puffAt(frac);
    puffDummy.position.set(0, PUFF.y + p.y, PUFF.z + p.z);
    puffDummy.scale.setScalar(p.scale);
    puffDummy.updateMatrix();
    puff.setMatrixAt(i, puffDummy.matrix);
  }
  puff.instanceMatrix.needsUpdate = true;
  puff.boundingBox = null;
  puff.boundingSphere = null;
}

/** The foot's own height, and the stem's, named ahead of GLASS so GLASS.hand (below) can anchor to the stem's own
 * midpoint — where the fist closes round it. */
const FOOT_H = 0.014;
const STEM_H = 0.07;
/** The stem's own midpoint, up from the foot's bottom. */
const STEM_MID = FOOT_H + STEM_H / 2;

/**
 * The gin tonic's glass: a copa de balón, the Spanish balloon glass that tells a gin tonic from any other drink — a
 * thin stem on a foot, under a bowl that swells out from the stem to a round belly, then pinches in again to a
 * narrower rim (bowlLathe: a real LatheGeometry revolve, not a stack of straight frustums, so the belly actually
 * curves). Oversized like the cigar (CIGAR): a real copa stands about half this tall, but at this size it would
 * vanish at the orbit camera's floor-view distance. Every radius and height here is local to the glass's own
 * foot-up frame (glassLevels, bowlRadiusAt); `hand` is where that frame sits in the arm that holds it (robot.ts's
 * armR): `y` puts the stem's own midpoint (STEM_MID) exactly at the fist's ball joint (-BOT.arm), so the closed
 * fist reads as gripping the stem rather than floating beside it; `z` is a hair's own grip offset, not a reach —
 * it's POSES.gintonic's own forward swing of the forearm that carries the whole glass out past the head, not a
 * static offset here (see that pose's own doc comment for the clearance maths).
 */
export const GLASS = {
  hand: { y: -BOT.arm - STEM_MID, z: 0.015 },
  footR: 0.05,
  footH: FOOT_H,
  stemR: 0.016,
  stemH: STEM_H,
  /** The bowl's total height, stem to rim. */
  bowlH: 0.17,
  /** The belly: the balloon's widest point, a little over halfway up the bowl. */
  bellyR: 0.13,
  /** The rim, narrower than the belly — the pinch that makes this a balloon glass, not a tumbler. */
  rimR: 0.048,
} as const;
/** The bowl's own radius where it meets the stem: a little wider, for a smooth joint. */
const BOWL_FOOT_R = GLASS.stemR * 1.3;
/** How thick the glass's wall reads as: the tonic and its ice sit this much inside the shell around them. */
const GLASS_WALL = 0.014;
/** How high up the bowl the tonic's level sits, a fraction of `bowlH`: a generous pour — about two thirds of the
 * bowl — with the pinch to the rim still showing clear and empty above it, so the balloon's own silhouette reads
 * apart from the liquid inside it. */
const TONIC_LEVEL = 0.66;
/**
 * The bowl's own silhouette, bottom (the stem joint) to the rim, as radius at each named fraction of `bowlH`: a
 * swell out to the belly a little past the middle, then a pinch back in to the rim. `bowlRadiusAt` eases between
 * these points rather than drawing a straight line between them, and `bowlLathe` samples that eased curve densely
 * (BOWL_SAMPLES points, revolved in BOWL_SEGMENTS) — between them, a round balloon, not the five-point polygon the
 * named points alone would read as.
 */
const BOWL_PROFILE: ReadonlyArray<readonly [f: number, r: number]> = [
  [0, BOWL_FOOT_R],
  [0.3, GLASS.bellyR * 0.9],
  [0.55, GLASS.bellyR],
  [0.8, GLASS.bellyR * 0.68],
  [1, GLASS.rimR],
];
const BOWL_SAMPLES = 20;
const BOWL_SEGMENTS = 28;

/** Eases `t` (0..1) smoothly from 0 to 1, flat-sloped at both ends: between two of BOWL_PROFILE's named radii, so
 * the bowl's curve rounds through each rather than kinking there. */
function ease(t: number): number {
  return (1 - Math.cos(t * Math.PI)) / 2;
}

/** The bowl's own radius at `f` (0 at the stem joint, 1 at the rim), eased between BOWL_PROFILE's points either side of it. */
function bowlRadiusAt(f: number): number {
  for (let i = 1; i < BOWL_PROFILE.length; i++) {
    const [f0, r0] = BOWL_PROFILE[i - 1]!;
    const [f1, r1] = BOWL_PROFILE[i]!;
    if (f <= f1) return r0 + (r1 - r0) * ease((f - f0) / (f1 - f0));
  }
  return BOWL_PROFILE[BOWL_PROFILE.length - 1]![1];
}

/** The y, foot up from 0, of the top of the foot, the stem, and the bowl (its rim). */
function glassLevels() {
  const footTop = GLASS.footH;
  const stemTop = footTop + GLASS.stemH;
  const rimTop = stemTop + GLASS.bowlH;
  return { footTop, stemTop, rimTop };
}

/**
 * A lathed fill of the bowl's own curve (bowlRadiusAt) from the stem joint up to `maxF`, each radius `inset` less
 * than the shell's own (0 for the shell itself; GLASS_WALL for the tonic, which sits inside the glass's own wall).
 * `key` keeps the shell's lathe and the tonic's own apart in Geometries' shared cache (they differ in `inset` and
 * `maxF`, so they could never collide on the shared geometry they'd otherwise compute to, but a shared cache keys
 * only on the string it's given). Both ends are left open (no end caps): the bottom sits flush on the stem's own
 * flat top, and the shell's rim is meant to read as open, like a real glass's; the tonic's own top is capped
 * separately, as its liquid surface (buildDrink).
 */
function bowlLathe(geo: Geometries, key: string, maxF: number, inset: number) {
  return geo.shared(key, () => {
    const { stemTop } = glassLevels();
    const points = [new Vector2(Math.max(BOWL_FOOT_R - inset, 0.001), stemTop)];
    for (let i = 1; i <= BOWL_SAMPLES; i++) {
      const f = (i / BOWL_SAMPLES) * maxF;
      points.push(new Vector2(Math.max(bowlRadiusAt(f) - inset, 0.001), stemTop + f * GLASS.bowlH));
    }
    return new LatheGeometry(points, BOWL_SEGMENTS);
  });
}

/**
 * The gin tonic as it stands in the hand (GLASS, glassLevels, bowlLathe): the glass's own round shell (its foot, its
 * stem and its lathed balloon bowl, with a brighter rim ring traced on top so its silhouette reads against the
 * floor), the tonic inside it (also lathed, to the same curve, so it fills the belly rather than reading as a
 * straight-sided cone of liquid) capped at its own surface, three ice cubes breaking that surface, a lime wheel
 * wedged on the rim, and a straw — the lime and the straw are the strongest cues that this is a gin tonic and not
 * some other drink, so each gets its own bright, un-shared colour (materials.ts's `limeRind` and `straw`) rather
 * than reusing a token already doing duty elsewhere in the scene. One group, so that poseRobot shows or hides the
 * whole drink together, the same as the cigar's body, tip and puff. It sits at GLASS.hand in the arm that holds it
 * (armR), but counter-rotated against the pose's raised forearm (POSES.gintonic, the only pose that shows it, and
 * never itself animated — see LOOPS.breathe) so the glass stands upright in the hand instead of tipping over to
 * point wherever the arm does. None of its parts casts a shadow: at this size, each would cost a draw for a texel
 * or two of it.
 */
function buildDrink(parent: Group, geo: Geometries, mats: Materials): Group {
  const s = mats.surface;
  const drink = new Group();
  drink.name = 'drink';
  drink.visible = false;
  drink.position.set(0, GLASS.hand.y, GLASS.hand.z);
  drink.quaternion.copy(new Quaternion().setFromEuler(new Euler(POSES.gintonic.armR[0], 0, POSES.gintonic.armR[1])).invert());
  parent.add(drink);
  const { footTop, stemTop, rimTop } = glassLevels();
  // The foot and the stem: plain, round rods — only the bowl needs a lathe to read as a balloon, these are already
  // round in cross-section.
  part(drink, geo.rod(GLASS.footR, GLASS.footR, GLASS.footH, 24), s.gtGlass, 0, footTop - GLASS.footH / 2, 0, { cast: false });
  part(drink, geo.rod(GLASS.stemR, GLASS.stemR, GLASS.stemH, 24), s.gtGlass, 0, stemTop - GLASS.stemH / 2, 0, { cast: false });
  // The bowl's own round shell, and a brighter, more opaque ring traced right at its rim so the silhouette holds
  // against the floor even where the shell's own transparency would otherwise wash it out.
  part(drink, bowlLathe(geo, 'gin tonic bowl', 1, 0), s.gtGlass, 0, 0, 0, { cast: false });
  part(drink, geo.rod(GLASS.rimR, GLASS.rimR, 0.01, BOWL_SEGMENTS), s.gtRim, 0, rimTop, 0, { cast: false });
  // The tonic: the bowl's own curve, a wall's width inside it, filled to its level and capped flat there as its
  // own liquid surface (the lathe's own top is left open — a flat disc reads as a surface, an open cone does not).
  const level = stemTop + GLASS.bowlH * TONIC_LEVEL;
  const levelR = bowlRadiusAt(TONIC_LEVEL) - GLASS_WALL;
  part(drink, bowlLathe(geo, 'gin tonic tonic', TONIC_LEVEL, GLASS_WALL), s.tonic, 0, 0, 0, { cast: false });
  part(drink, geo.circle(levelR), s.tonic, 0, level, 0, { rx: -Math.PI / 2, cast: false });
  // Three ice cubes, poking clear above the tonic's own surface, turned off-square so none reads as a stray box.
  for (const [dx, dz, ry] of [[-0.03, -0.015, 0.3], [0.026, 0.02, -0.4], [0.002, -0.04, 0.9]] as const) {
    part(drink, geo.rbox(0.03, 0.03, 0.03, 0.006), s.ice, dx, level + 0.006, dz, { ry, cast: false });
  }
  // The lime wheel, wedged on the rim, overhanging it: its bright rind, and a lighter disc of flesh just inside —
  // with the straw, the strongest single cue that this is a gin tonic.
  const rimZ = GLASS.rimR * 0.85;
  part(drink, geo.rod(GLASS.rimR * 1.1, GLASS.rimR * 1.1, 0.016, 16), s.limeRind, 0, rimTop, rimZ, { rx: Math.PI / 2, cast: false });
  part(drink, geo.rod(GLASS.rimR * 0.72, GLASS.rimR * 0.72, 0.018, 16), s.limeFlesh, 0, rimTop, rimZ + 0.002, { rx: Math.PI / 2, cast: false });
  // A straw, through the rim and down into the tonic, tipped a little away from the glass.
  part(drink, geo.rod(0.011, 0.011, 0.26, 8), s.straw, 0.025, rimTop + 0.07, -0.02, { rx: 0.18, cast: false });
  return drink;
}

/** Where a seated robot's laptop stands, in metres: on the table (its top, 0.78 high), this far ahead of the robot's seat. */
export const LAPTOP = { top: 0.78, ahead: 0.6, w: 0.3, d: 0.22, tilt: 0.3 } as const;

export interface RobotObject {
  readonly sessionId: string;
  readonly kind: RobotKind;
  readonly group: Group;
  readonly rig: RobotRig;
  /** The colour slots it was built with; a change of either rebuilds the robot. */
  readonly body: number;
  readonly tie: number | null;
  /** The persona it was built with (persona.ts); a change rebuilds the robot (floor-scene.ts cast()). */
  readonly persona: Persona;
  readonly pickables: readonly Mesh[];
}

/**
 * Only the legs, the torso, the arms, the head, the hard hat and the paper cast shadows: joints, face, visor, tie, brim
 * and jetpack would cost a draw each for a texel or two of shadow. An intern casts none: small, and high above the floor,
 * it would leave only specks.
 */
export function buildRobot(sessionId: string, robot: Look, geo: Geometries, mats: Materials, kind: RobotKind = 'session'): RobotObject {
  const s = mats.surface;
  const small = { cast: false };
  const persona = robot.persona ?? 'none';
  // A persona's outfit recolours the torso (user-decisions.md OQ-3); 'none' and 'boss' keep the repo colour, the
  // desk's own cue (persona.ts PERSONA_BODY).
  const bodySurface = PERSONA_BODY[persona];
  const body = bodySurface ? s[bodySurface] : mats.body(robot.body);
  const joint = mats.joint(robot.body);
  const tie = mats.tie(robot.tie);
  const group = new Group();
  group.name = `robot ${sessionId}`;
  group.scale.setScalar(KIND_SCALE[kind]);
  const pivot = (parent: Group, x: number, y: number) => {
    const g = new Group();
    g.position.set(x, y, 0);
    parent.add(g);
    return g;
  };
  const legL = pivot(group, -BOT.legX, BOT.hip);
  const legR = pivot(group, BOT.legX, BOT.hip);
  const waist = pivot(group, 0, BOT.hip);
  const armL = pivot(waist, -BOT.shoulderX, BOT.torso - 0.05);
  const armR = pivot(waist, BOT.shoulderX, BOT.torso - 0.05);
  const neck = pivot(waist, 0, BOT.torso);

  // An intern keeps its leg pivots, so that every kind poses alike, but has nothing below the hip.
  for (const leg of kind === 'intern' ? [] : [legL, legR]) {
    part(leg, geo.rod(0.04, 0.04, BOT.hip), s.shell, 0, -BOT.hip / 2, 0);
    part(leg, geo.rbox(0.12, 0.07, 0.18, 0.03), joint, 0, -BOT.hip + 0.035, 0.03, small);
  }
  part(waist, geo.rbox(0.36, BOT.torso, 0.24, 0.05), body, 0, BOT.torso / 2, 0);
  for (const arm of [armL, armR]) {
    part(arm, geo.ball(0.055), s.shell, 0, 0, 0, small);
    part(arm, geo.rod(0.032, 0.032, BOT.arm), s.shell, 0, -BOT.arm / 2, 0);
    part(arm, geo.ball(0.05), joint, 0, -BOT.arm, 0, small);
  }
  // Monitor head: shell, dark face, glowing visor bar.
  part(neck, geo.rod(0.04, 0.04, 0.07), s.shell, 0, 0.03, 0, small);
  part(neck, geo.rbox(0.38, 0.28, 0.26, 0.04), s.shell, 0, 0.2, 0);
  part(neck, geo.rbox(0.31, 0.2, 0.02, 0.008), s.monitor, 0, 0.2, 0.125, small);
  part(neck, geo.box(0.18, 0.035, 0.012), s.visor, 0, 0.21, 0.137, small);
  // A workflow agent's hard hat: a dome on the top of the head and a brim, longer at the front. Hidden, not left
  // unbuilt, when its persona has its own headgear: the more specific signal (persona.ts hasHeadgear).
  const hardHat: Mesh[] = [];
  if (kind === 'workflow') {
    hardHat.push(part(neck, dome(geo), s.hardhat, 0, 0.34, 0));
    hardHat.push(part(neck, geo.rod(0.205, 0.205, 0.025, 24), s.hardhat, 0, 0.34, 0.02, small));
    if (hasHeadgear(persona)) for (const m of hardHat) m.visible = false;
  }
  // An intern's jetpack: two tanks on its back, each with a nozzle under it.
  if (kind === 'intern') {
    for (const x of [-0.08, 0.08]) {
      part(waist, geo.rod(0.05, 0.05, 0.24), s.jet, x, BOT.torso / 2, -0.16, small);
      part(waist, geo.rod(0.03, 0.05, 0.08), s.shell, x, BOT.torso / 2 - 0.16, -0.16, small);
    }
  }
  // The cigar at the mouth, below the visor: its body, its lit tip, and the puff above it. One group so that
  // setSmoking toggles all three together; hidden until its look says otherwise.
  const cigar = new Group();
  cigar.name = 'cigar';
  cigar.visible = Boolean(robot.smoking);
  neck.add(cigar);
  part(cigar, geo.rod(CIGAR.r, CIGAR.r, CIGAR.len), s.cigarBody, 0, CIGAR.y, CIGAR.z, { rx: Math.PI / 2, cast: false });
  part(cigar, geo.ball(CIGAR_TIP.r), s.cigarTip, 0, CIGAR.y, CIGAR_TIP.z, small);
  const puff = new InstancedMesh(geo.ball(PUFF.r), s.smokePuff, PUFF.puffs);
  puff.name = 'smoke';
  puff.castShadow = false;
  // Its puffs move every frame and rise well above the head: never culled on a stale bounding sphere.
  puff.frustumCulled = false;
  placePuffs(puff, robot.smoking ? 0 : null);
  cigar.add(puff);
  // The on-call headset: a band over an ear cup at the left ear (HEADSET), in the call's line colour (or the
  // dropped-call flash, or Fairmind's fixed teal, materials.ts `lineColor`); hidden until setOnCall shows it. One
  // group so setOnCall toggles the band and the cup together, mirroring the cigar.
  const headsetColor = (call: OnCallView): Material => mats.lineColor(call);
  const headset = new Group();
  headset.name = 'headset';
  headset.visible = Boolean(robot.call);
  neck.add(headset);
  const initialHeadsetColor = robot.call ? headsetColor(robot.call) : mats.line(0);
  const headsetHook = part(headset, geo.arc(HEADSET.hookR, HEADSET.hookTube, HEADSET.hookArc), initialHeadsetColor, HEADSET.x, HEADSET.y, HEADSET.z, small);
  const headsetBead = part(headset, geo.ball(HEADSET.beadR), initialHeadsetColor, HEADSET.x, HEADSET.y, HEADSET.z, small);
  // The boom mic (BOOM_MIC, round-3 enlargement): the rod itself in the robot's own plastic, never recoloured by
  // the call; its tip is, the same "glowing on-air bead" material as the band and the cup — setOnCall recolours
  // all three together, the mic rod alone staying put.
  const headsetMic = part(headset, geo.rod(BOOM_MIC.rod.r, BOOM_MIC.rod.r, BOOM_MIC.rod.len), s.shell, BOOM_MIC.x, BOOM_MIC.y, BOOM_MIC.z, { ...small, rx: BOOM_MIC.rx, ry: BOOM_MIC.ry });
  const headsetMicTip = part(headset, geo.ball(BOOM_MIC.tip.r), initialHeadsetColor, BOOM_MIC.tip.x, BOOM_MIC.tip.y, BOOM_MIC.tip.z, small);
  // FairMind's per-family VIP forms (fairmind-forms.ts, hq-mcp-switchboard proposal.md §5 Phase 3), big, above the
  // head: the brand mark alone by default, or a family's own motif once the call carries one. Parented on `group`
  // itself (the robot's top-level group, like `fairmind-badge.ts`'s own badge), not on `headset` or `neck` — a
  // call form that rode the neck would bow with `POSES`' own neck tilt and `LOOPS.breathe`/`doze`'s nod, which a
  // brand display above the head should not, the same reasoning `fairmind-badge.ts` gives its own badge. The
  // headset's hook and bead (above) stay the small "a call is live, here" earpiece accent; this is the big,
  // family-specific read, in the badge's own screen slot (floor-scene.ts hides the badge itself while this
  // shows — the two would otherwise double up the same brand mark in the same spot).
  const fairmindFormsGroup = new Group();
  fairmindFormsGroup.name = 'fairmind-forms';
  fairmindFormsGroup.position.set(0, FAIRMIND_FORM_Y, 0);
  group.add(fairmindFormsGroup);
  const fairmindForms = attachFairmindForms(fairmindFormsGroup, geo, mats);
  setFairmindForm(fairmindForms, robot.call ?? null);
  const headsetMark = fairmindForms.byKey.default as Mesh;
  const headsetWrite = robot.call?.write ?? false;
  const headsetFairmind = robot.call?.fairmind ?? false;
  // The tie: a knot and a tapered blade, in the feature colour — clearly wider and longer for the boss persona only
  // (user-decisions.md OQ-1, 2026-10-16: "Cappello + cravatta"), its colour unchanged, the knot's bottom edge and
  // the blade's top edge kept flush at either size so the two never gap or overlap.
  const isBoss = persona === 'boss';
  const knotY = BOT.torso - 0.05;
  const knotH = isBoss ? 0.05 : 0.04;
  const bladeLen = isBoss ? 0.26 : 0.2;
  part(waist, geo.box(isBoss ? 0.075 : 0.05, knotH, 0.03), tie, 0, knotY, 0.125, small);
  part(waist, tieBlade(geo, isBoss), tie, 0, knotY - knotH / 2 - bladeLen / 2, 0.121, { rx: 0.08, cast: false });
  const paper = part(armR, geo.box(0.2, 0.015, 0.26), s.paper, -0.07, -BOT.arm - 0.03, 0.05, { rx: 2.6 });
  // Leisure props, in the hand that holds the paper: the gin tonic (buildDrink), or a coffee cup on its own saucer,
  // both in the paper's own white — small enough, at an espresso cup's own scale, that only the cup's shape (not a
  // second colour) has to read as "coffee". Like the drink, the cup is its own group, counter-rotated against the
  // coffee pose's own arm swing (POSES.coffee.armR) so it stands upright in the hand instead of lying on its side
  // wherever the raised forearm points; neither it nor the saucer casts a shadow, at this size each would cost a
  // draw for a texel or two of it, the drink's own parts built the same way.
  const drink = buildDrink(armR, geo, mats);
  const cup = new Group();
  cup.name = 'cup';
  cup.visible = false;
  cup.position.set(0, -BOT.arm - 0.04, 0.02);
  cup.quaternion.copy(new Quaternion().setFromEuler(new Euler(POSES.coffee.armR[0], 0, POSES.coffee.armR[1])).invert());
  armR.add(cup);
  part(cup, geo.rod(0.036, 0.029, 0.05), s.paper, 0, 0.025, 0, small);
  part(cup, geo.rod(0.058, 0.058, 0.009), s.paper, 0, -0.0045, 0, small);
  // The persona's own accessories: headgear on the neck, a held prop in the left hand (persona.ts).
  const personaRig = buildPersona(neck, armL, persona, geo, mats);

  const laptop = buildLaptop(group, kind, geo, mats);

  const pickables: Mesh[] = [];
  const pick: PickData = { kind: 'desk', id: sessionId };
  group.traverse((o) => {
    if ((o as Mesh).isMesh) {
      o.userData.pick = pick;
      if (kind === 'intern') o.castShadow = false;
      pickables.push(o as Mesh);
    }
  });
  return {
    sessionId,
    kind,
    group,
    rig: {
      legL,
      legR,
      waist,
      armL,
      armR,
      neck,
      paper,
      laptop,
      cigar,
      puff,
      headset,
      headsetHook,
      headsetBead,
      headsetMic,
      headsetMicTip,
      headsetMark,
      fairmindForms,
      headsetWrite,
      headsetFairmind,
      headsetColor,
      drink,
      cup,
      persona: personaRig,
      hardHat,
    },
    body: robot.body,
    tie: robot.tie,
    persona,
    pickables,
  };
}

/** Shows or hides a robot's cigar (and its tip and puff with it), in any pose, without rebuilding it. */
export function setSmoking(obj: RobotObject, on: boolean): void {
  if (obj.rig.cigar.visible === on) return;
  obj.rig.cigar.visible = on;
  placePuffs(obj.rig.puff, on ? 0 : null);
}

/**
 * Shows or hides a robot's on-call headset — the band, the ear cup and the boom mic's own tip, in the call's line
 * colour, Fairmind's fixed teal, or the dropped-call flash (materials.ts `lineColor`, closed over as
 * `rig.headsetColor` at build time, hq-mcp-switchboard contract.md #renderer-setoncall) — mirroring `setSmoking`
 * above, in any pose, without rebuilding. Resets the cup's and the Fairmind forms group's pulse scale to their
 * resting size on every call (not just a fresh one): with motion off `animateRobot` never runs, so a cup (or
 * form) left mid-pulse from a stale call would otherwise show "simply lit" at the wrong size (proposal.md §4
 * "motion = off"). `setFairmindForm` (fairmind-forms.ts) picks the call's family's own VIP form (Phase 3) in
 * place of the brand mark alone (MVP); the boom mic's own rod never recolours — a physical boom, not a signal.
 */
export function setOnCall(obj: RobotObject, call: OnCallView | null): void {
  const r = obj.rig;
  r.headset.visible = call !== null;
  r.headsetBead.scale.setScalar(1);
  r.fairmindForms.group.scale.setScalar(1);
  if (!call) {
    setFairmindForm(r.fairmindForms, null);
    return;
  }
  r.headsetWrite = call.write;
  r.headsetFairmind = call.fairmind;
  const color = r.headsetColor(call);
  r.headsetHook.material = color;
  r.headsetBead.material = color;
  r.headsetMicTip.material = color;
  setFairmindForm(r.fairmindForms, call);
}

/**
 * How a walking robot swings its limbs (prototypes/floor-3d-mockup.html, Mascot.update): its legs `swing` radians either
 * way at `rate` radians a second, its arms 0.8 of that against them, and it bobs `bob` metres at its size.
 */
export const STRIDE = { rate: 9, swing: 0.6, bob: 0.03 } as const;

/**
 * The robot on its way, `t` seconds into its walk at walking pace (one walking faster is further into it): at `at`,
 * facing its way, legs and arms swinging, standing on the floor; an intern flies at HOVER_Y.
 */
export function strideRobot(obj: RobotObject, at: { x: number; z: number; facing: number }, t: number): void {
  const phase = t * STRIDE.rate;
  const swing = Math.sin(phase) * STRIDE.swing;
  const r = obj.rig;
  const y = obj.kind === 'intern' ? HOVER_Y : Math.abs(Math.cos(phase)) * STRIDE.bob * KIND_SCALE[obj.kind];
  obj.group.position.set(at.x, y, at.z);
  obj.group.rotation.y = at.facing;
  r.armL.rotation.set(0.05 - 0.8 * swing, 0, -0.1);
  r.armR.rotation.set(0.05 + 0.8 * swing, 0, 0.1);
  r.legL.rotation.x = swing;
  r.legR.rotation.x = -swing;
  r.neck.rotation.x = 0;
  r.waist.rotation.x = 0;
  r.paper.visible = false;
  r.laptop.visible = false;
  r.drink.visible = false;
  r.cup.visible = false;
  // Its held prop goes too, like the paper/glass/cup; its headgear, the persona's primary cue, stays shown.
  setPersonaVisible(r.persona, { headgear: true, held: false });
}

/**
 * Poses with a hand already busy (the gin tonic, the coffee cup, the foosball table's handle) or on the way
 * (strideRobot): a persona's held prop hides there too, same as the right hand's own props (design: held prop vs
 * right-hand props).
 */
const HELD_PROP_HIDDEN: ReadonlySet<Pose> = new Set(['holding', 'gintonic', 'biliardino', 'coffee']);

/**
 * Puts the robot on its spot, facing its way, in the pose of its state; with `laptop`, its laptop open before it.
 * At the biliardino pose, it leans `BILIARDINO_REACH` past its spot, toward what it faces, to put its hand on the
 * handle (the pose's own bend alone falls short, by a different amount for each kind).
 */
export function poseRobot(obj: RobotObject, robot: Pick<Robot, 'pose' | 'badge'>, spot: Spot, laptop = false): void {
  const spec = poseOf(robot, obj.kind);
  const r = obj.rig;
  const reach = robot.pose === 'biliardino' ? BILIARDINO_REACH[obj.kind] : 0;
  obj.group.position.set(spot.x + reach * Math.sin(spot.facing), rootHeight(robot.pose, obj.kind), spot.z + reach * Math.cos(spot.facing));
  obj.group.rotation.y = spot.facing;
  r.armL.rotation.set(spec.armL[0], 0, spec.armL[1]);
  r.armR.rotation.set(spec.armR[0], 0, spec.armR[1]);
  r.legL.rotation.x = spec.legs;
  r.legR.rotation.x = spec.legs;
  r.neck.rotation.x = spec.neck;
  r.waist.rotation.x = spec.lean;
  r.paper.visible = spec.paper;
  r.laptop.visible = laptop && !isStanding(robot.pose);
  r.drink.visible = robot.pose === 'gintonic';
  r.cup.visible = robot.pose === 'coffee';
  setPersonaVisible(r.persona, { headgear: true, held: !HELD_PROP_HIDDEN.has(robot.pose) });
}

/**
 * The loops robots run at their places (design §6.2), each a sine of `rate` radians a second: the forearms typing in
 * turn; the raised arm waving forward and back, clear of the head and of the chair; both arms swaying the held paper;
 * breathing, the upper body leaning and the head nodding with it, relaxed and only forward from the pose, an idle robot
 * leaning on its chair's back, or slower with the head down; an intern bobbing on its jetpack. Amplitudes are in
 * radians, the bob's in metres.
 */
export const LOOPS = {
  type: { rate: 15, arm: 0.08 },
  wave: { rate: 7, arm: 0.3 },
  sway: { rate: 2, arm: 0.06 },
  breathe: { rate: 1.6, lean: 0.03, neck: 0.03 },
  doze: { rate: 0.9, lean: 0.02, neck: 0.06 },
  hover: { rate: 3, bob: 0.03 },
  /** A biliardino robot's hands jiggling the table's rod, its forearms out of step with each other. */
  foosball: { rate: 6, arm: 0.12 },
} as const;

export type Loop = keyof typeof LOOPS;

/**
 * The loop a robot runs at its place: working sessions and workflow agents type, one that needs you waves, one that is
 * done sways its paper, one without a signal dozes, an idle one breathes, and an intern hovers — except at the
 * foosball table, where it floats low over its handle (rootHeight, FOOSBALL_HOVER_Y) and plays like any other
 * kind. A host in a meeting runs none.
 */
export function loopOf(robot: Pick<Robot, 'pose' | 'badge'>, kind: RobotKind = 'session'): Loop | null {
  if (kind === 'intern' && robot.pose !== 'biliardino') return 'hover';
  switch (robot.pose) {
    case 'typing':
      return 'type';
    case 'waving':
      return 'wave';
    case 'holding':
      return 'sway';
    case 'resting':
      return 'breathe';
    case 'still':
      return robot.badge === 'clock' ? 'doze' : null;
    case 'gintonic':
    case 'coffee':
      return 'breathe';
    case 'biliardino':
      return 'foosball';
  }
}

/** Where a robot's loop starts: a hash of its id spread over [0, 2π), so that robots side by side do not move in step. */
export function phaseOf(id: string): number {
  // FNV-1a over the UTF-16 code units, then a final mix so that ids that differ only at the end spread too.
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193);
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return ((h >>> 0) / 2 ** 32) * 2 * Math.PI;
}

/**
 * Runs the robot's loop at its place, `t` seconds on, from `phase`: the pivots its loop moves are set to the pose's
 * (poseRobot) plus the loop's offset, and nothing else changes. At t = 0 from phase 0 the robot is in its pose; a robot
 * that runs no loop stays in it. It allocates nothing.
 */
export function animateRobot(obj: RobotObject, robot: Pick<Robot, 'pose' | 'badge'>, t: number, phase: number): void {
  const loop = loopOf(robot, obj.kind);
  if (loop === null) return;
  const s = Math.sin(t * LOOPS[loop].rate + phase);
  const spec = poseOf(robot, obj.kind);
  const r = obj.rig;
  if (r.cigar.visible) {
    // The puffs rise PUFF.rise over 1/PUFF.rate seconds and start again, scaled to nothing at either end (puffAt):
    // the reset at the bottom is never seen. phase (radians, [0, 2π)) offsets them by the same fraction of a cycle
    // as it does the other loops' sines, so smoke columns next to each other stay out of step.
    placePuffs(r.puff, t * PUFF.rate + phase / (2 * Math.PI));
  }
  if (r.headset.visible) {
    // Forward-only, like LOOPS.breathe: the bead pulses out from its resting scale and back, never past it the
    // other way, so "simply lit" (motion off, which never calls this) is exactly its first frame.
    const forward = (1 - Math.cos(t * CALL_PULSE.rate + phase)) / 2;
    const dir = r.headsetWrite ? 1 : -1;
    r.headsetBead.scale.setScalar(1 + dir * forward * CALL_PULSE.amp);
    // The shown Fairmind VIP form pulses the same way, in step with the bead (hq-mcp-switchboard proposal.md §2
    // "the form pulses/emits outward on write"): a write grows outward past its resting size, a read shrinks
    // gently inward, never the other way — the same read/write "direction" the bead already carries, now on the
    // form a FairMind call is visibly senior enough to show.
    if (r.headsetFairmind) r.fairmindForms.group.scale.setScalar(1 + dir * forward * CALL_PULSE.amp);
  }
  switch (loop) {
    case 'type':
      r.armL.rotation.x = spec.armL[0] + s * LOOPS.type.arm;
      r.armR.rotation.x = spec.armR[0] - s * LOOPS.type.arm;
      return;
    case 'wave':
      r.armR.rotation.x = spec.armR[0] + s * LOOPS.wave.arm;
      return;
    case 'sway':
      r.armL.rotation.x = spec.armL[0] + s * LOOPS.sway.arm;
      r.armR.rotation.x = spec.armR[0] + s * LOOPS.sway.arm;
      return;
    case 'breathe': {
      // From the pose forward and back to it, never further back: the pose already leans on the chair's back.
      const forward = (1 - Math.cos(t * LOOPS.breathe.rate + phase)) / 2;
      r.waist.rotation.x = spec.lean + forward * LOOPS.breathe.lean;
      r.neck.rotation.x = spec.neck + forward * LOOPS.breathe.neck;
      return;
    }
    case 'doze':
      r.waist.rotation.x = spec.lean + s * LOOPS.doze.lean;
      r.neck.rotation.x = spec.neck + s * LOOPS.doze.neck;
      return;
    case 'hover':
      obj.group.position.y = HOVER_Y + s * LOOPS.hover.bob;
      return;
    case 'foosball':
      r.armL.rotation.x = spec.armL[0] + s * LOOPS.foosball.arm;
      r.armR.rotation.x = spec.armR[0] - s * LOOPS.foosball.arm;
      return;
  }
}

/**
 * A laptop, open, with its screen toward the robot, on the table ahead of it. It is placed in the robot's frame from
 * where the table is in the world, and scaled back up by its robot's size, so that every kind's laptop is the same.
 */
function buildLaptop(root: Group, kind: RobotKind, geo: Geometries, mats: Materials): Group {
  const s = mats.surface;
  const small = { cast: false };
  const scale = KIND_SCALE[kind];
  const laptop = new Group();
  laptop.name = 'laptop';
  laptop.scale.setScalar(1 / scale);
  laptop.position.set(0, (LAPTOP.top - (SEAT_Y - BOT.hip * scale)) / scale, LAPTOP.ahead / scale);
  laptop.visible = false;
  root.add(laptop);
  // An intern flies: it has no table to sit at, and so no laptop.
  if (kind === 'intern') return laptop;
  part(laptop, geo.box(LAPTOP.w, 0.02, LAPTOP.d), s.shell, 0, 0.01, 0, small);
  const lid = new Group();
  lid.position.set(0, 0.02, LAPTOP.d / 2);
  lid.rotation.x = LAPTOP.tilt;
  laptop.add(lid);
  part(lid, geo.box(LAPTOP.w, 0.2, 0.012), s.shell, 0, 0.1, 0, small);
  part(lid, geo.box(LAPTOP.w - 0.04, 0.16, 0.004), s.visor, 0, 0.1, -0.007, small);
  return laptop;
}

function dome(geo: Geometries) {
  return geo.shared('hard hat', () => new SphereGeometry(0.155, 20, 8, 0, Math.PI * 2, 0, Math.PI / 2));
}

/**
 * The tie's tapered blade: `wide` widens and lengthens it for the boss (user-decisions.md OQ-1, 2026-10-16: "Cappello
 * + cravatta") — the session's own feature-colour tie, widened for that one persona only, never recoloured. Shared
 * under its own key so the two sizes never collide in the geometry cache.
 */
function tieBlade(geo: Geometries, wide: boolean) {
  return geo.shared(wide ? 'tie blade boss' : 'tie blade', () => {
    const g = new CylinderGeometry(wide ? 0.055 : 0.03, wide ? 0.09 : 0.05, wide ? 0.26 : 0.2, 4);
    g.rotateY(Math.PI / 4);
    g.scale(1, 1, 0.35);
    return g;
  });
}

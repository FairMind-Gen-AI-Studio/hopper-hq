/**
 * A session's robot, from primitives (prototypes/floor-3d-mockup.html, dressBot): a monitor head with a glowing
 * visor, a body in the repo colour and a tie in the feature colour. At its place, each state has one pose (outline
 * §2.6), set by rotating the limb pivots, and a small loop it runs there (design §6.2); on its way there, it strides,
 * swinging its legs and arms.
 * Two smaller kinds share the build: a workflow agent wears a hard hat, and an intern flies on a jetpack, without legs.
 */
import { CylinderGeometry, Group, InstancedMesh, Object3D, SphereGeometry, type Mesh } from 'three';
import type { Pose, Robot } from '../../src/scene/types';
import type { Materials } from './materials';
import { part, type Geometries, type PickData } from './props';
import { SEAT_Y, isStanding, type Spot } from './world';

/** Body measures: hip and torso heights, shoulder and leg offsets from the middle, and arm length. */
export const BOT = { hip: 0.34, torso: 0.36, shoulderX: 0.22, legX: 0.09, arm: 0.32 } as const;

/** A session's own robot, a workflow agent at a meeting table, or an intern hovering by its desk. */
export type RobotKind = 'session' | 'intern' | 'workflow';

/**
 * A robot's look, as the renderer builds and poses it: `Robot` (the wire type, outline §2.6) plus
 * whether it holds a lit cigar. `smoking` stays out of the shared `Robot` type — it never goes over
 * the wire on its own; the server sends it as `Occupant`/`Intern`/`MeetingAgent.smoking` instead
 * (src/scene/types.ts) and the renderer folds it in here. Optional, so every existing look literal
 * that has no `smoking` field still reads as not smoking.
 */
export type Look = Robot & { smoking?: boolean };
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
  /** At the bar cart (design §7.1, leisure): standing, relaxed, its glass raised in its right hand. */
  gintonic: { armL: [-0.3, -0.25], armR: [-1, -0.15], legs: 0, neck: -0.1, lean: -0.15, paper: false },
  /**
   * Leaning over the foosball table's handle, both forearms reaching out and down; the table's rods are props.ts's
   * furniture, at world.ts's FOOSBALL_ROD_Y. A standing robot's hand lands there at this bend (checked by
   * forward kinematics, not eyeballed): bending the forearm further, past this, would only lower the hand again.
   */
  biliardino: { armL: [-1.6, 0.14], armR: [-1.6, -0.14], legs: 0, neck: 0.1, lean: 0.12, paper: false },
  /** At the coffee machine: standing, its cup in its right hand. */
  coffee: { armL: [-0.25, -0.2], armR: [-0.9, -0.15], legs: 0, neck: -0.08, lean: -0.1, paper: false },
};

/** A still robot with no signal (the clock badge) hangs its head; one in a meeting does not. */
export const HEAD_DOWN = 0.3;
const DOZING: PoseSpec = { ...POSES.still, neck: HEAD_DOWN };

/** The pose of a robot's look: one object per look, so that posing a robot in every frame allocates nothing. */
export function poseOf(robot: Pick<Robot, 'pose' | 'badge'>): PoseSpec {
  return robot.pose === 'still' && robot.badge === 'clock' ? DOZING : POSES[robot.pose];
}

/**
 * How high an intern floats while it plays foosball: low enough that its hand, at its own small scale and the
 * biliardino pose's bend, meets the table's rods at FOOSBALL_ROD_Y (world.ts) — nothing like its desk's HOVER_Y,
 * which would leave its hands a metre above the handles. Measured the same way as the pose itself (by forward
 * kinematics, not eyeballed): an intern has no legs to stand on, so unlike session and workflow it needs a root
 * height of its own at this one pose.
 */
export const FOOSBALL_HOVER_Y = 0.28;

/** Height of the robot's feet: a seated robot sinks until its hips, at its size, rest on the chair; an intern hovers. */
export function rootHeight(pose: Pose, kind: RobotKind = 'session'): number {
  if (kind === 'intern') return pose === 'biliardino' ? FOOSBALL_HOVER_Y : HOVER_Y;
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
  /** Its gin tonic glass and the lime on its rim, in its right hand: shown only in the gintonic pose. */
  glass: Mesh;
  lime: Mesh;
  /** Its coffee cup, in its right hand: shown only in the coffee pose. */
  cup: Mesh;
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
  const body = mats.body(robot.body);
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
  // A workflow agent's hard hat: a dome on the top of the head and a brim, longer at the front.
  if (kind === 'workflow') {
    part(neck, dome(geo), s.hardhat, 0, 0.34, 0);
    part(neck, geo.rod(0.205, 0.205, 0.025, 24), s.hardhat, 0, 0.34, 0.02, small);
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
  // The tie: a knot and a tapered blade, in the feature colour.
  const knotY = BOT.torso - 0.05;
  part(waist, geo.box(0.05, 0.04, 0.03), tie, 0, knotY, 0.125, small);
  part(waist, tieBlade(geo), tie, 0, knotY - 0.12, 0.121, { rx: 0.08, cast: false });
  const paper = part(armR, geo.box(0.2, 0.015, 0.26), s.paper, -0.07, -BOT.arm - 0.03, 0.05, { rx: 2.6 });
  // Leisure props, in the hand that holds the paper: a small glass with a lime on its rim, or a coffee cup. Neither
  // casts a shadow: at this size they would cost a draw each for a texel or two of it.
  const glass = part(armR, geo.rod(0.035, 0.03, 0.09), s.glass, 0, -BOT.arm + 0.05, 0.05, small);
  const lime = part(armR, geo.ball(0.02), s.plant, 0, -BOT.arm + 0.1, 0.05, small);
  const cup = part(armR, geo.rod(0.035, 0.03, 0.06), s.paper, 0, -BOT.arm + 0.04, 0.05, small);

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
  return { sessionId, kind, group, rig: { legL, legR, waist, armL, armR, neck, paper, laptop, cigar, puff, glass, lime, cup }, body: robot.body, tie: robot.tie, pickables };
}

/** Shows or hides a robot's cigar (and its tip and puff with it), in any pose, without rebuilding it. */
export function setSmoking(obj: RobotObject, on: boolean): void {
  if (obj.rig.cigar.visible === on) return;
  obj.rig.cigar.visible = on;
  placePuffs(obj.rig.puff, on ? 0 : null);
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
  r.glass.visible = false;
  r.lime.visible = false;
  r.cup.visible = false;
}

/** Puts the robot on its spot, facing its way, in the pose of its state; with `laptop`, its laptop open before it. */
export function poseRobot(obj: RobotObject, robot: Pick<Robot, 'pose' | 'badge'>, spot: Spot, laptop = false): void {
  const spec = poseOf(robot);
  const r = obj.rig;
  obj.group.position.set(spot.x, rootHeight(robot.pose, obj.kind), spot.z);
  obj.group.rotation.y = spot.facing;
  r.armL.rotation.set(spec.armL[0], 0, spec.armL[1]);
  r.armR.rotation.set(spec.armR[0], 0, spec.armR[1]);
  r.legL.rotation.x = spec.legs;
  r.legR.rotation.x = spec.legs;
  r.neck.rotation.x = spec.neck;
  r.waist.rotation.x = spec.lean;
  r.paper.visible = spec.paper;
  r.laptop.visible = laptop && !isStanding(robot.pose);
  r.glass.visible = robot.pose === 'gintonic';
  r.lime.visible = robot.pose === 'gintonic';
  r.cup.visible = robot.pose === 'coffee';
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
  const spec = poseOf(robot);
  const r = obj.rig;
  if (r.cigar.visible) {
    // The puffs rise PUFF.rise over 1/PUFF.rate seconds and start again, scaled to nothing at either end (puffAt):
    // the reset at the bottom is never seen. phase (radians, [0, 2π)) offsets them by the same fraction of a cycle
    // as it does the other loops' sines, so smoke columns next to each other stay out of step.
    placePuffs(r.puff, t * PUFF.rate + phase / (2 * Math.PI));
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

function tieBlade(geo: Geometries) {
  return geo.shared('tie blade', () => {
    const g = new CylinderGeometry(0.03, 0.05, 0.2, 4);
    g.rotateY(Math.PI / 4);
    g.scale(1, 1, 0.35);
    return g;
  });
}

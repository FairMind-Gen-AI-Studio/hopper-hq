/**
 * A session's robot, from primitives (prototypes/floor-3d-mockup.html, dressBot): a monitor head with a glowing
 * visor, a body in the repo colour and a tie in the feature colour. M2 robots do not move: each state has one static
 * pose (outline §2.6), set by rotating the limb pivots.
 */
import { CylinderGeometry, Group, type Mesh } from 'three';
import type { Pose, Robot } from '../../src/scene/types';
import type { Materials } from './materials';
import { part, type Geometries, type PickData } from './props';
import { SEAT_Y, isStanding, type Spot } from './world';

/** Body measures: hip and torso heights, shoulder and leg offsets from the middle, and arm length. */
export const BOT = { hip: 0.34, torso: 0.36, shoulderX: 0.22, legX: 0.09, arm: 0.32 } as const;

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
};

/** A still robot with no signal (the clock badge) hangs its head; one in a meeting does not. */
export const HEAD_DOWN = 0.3;

export function poseOf(robot: Pick<Robot, 'pose' | 'badge'>): PoseSpec {
  const spec = POSES[robot.pose];
  return robot.pose === 'still' && robot.badge === 'clock' ? { ...spec, neck: HEAD_DOWN } : spec;
}

/** Height of the robot's feet: a seated robot sinks until its hips rest on the chair. */
export function rootHeight(pose: Pose): number {
  return isStanding(pose) ? 0 : SEAT_Y - BOT.hip;
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
}

export interface RobotObject {
  readonly sessionId: string;
  readonly group: Group;
  readonly rig: RobotRig;
  /** The colour slots it was built with; a change of either rebuilds the robot. */
  readonly body: number;
  readonly tie: number | null;
  readonly pickables: readonly Mesh[];
}

export function buildRobot(sessionId: string, robot: Robot, geo: Geometries, mats: Materials): RobotObject {
  const s = mats.surface;
  const body = mats.body(robot.body);
  const joint = mats.joint(robot.body);
  const tie = mats.tie(robot.tie);
  const group = new Group();
  group.name = `robot ${sessionId}`;
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

  for (const leg of [legL, legR]) {
    part(leg, geo.rod(0.04, 0.04, BOT.hip), s.shell, 0, -BOT.hip / 2, 0);
    part(leg, geo.rbox(0.12, 0.07, 0.18, 0.03), joint, 0, -BOT.hip + 0.035, 0.03);
  }
  part(waist, geo.rbox(0.36, BOT.torso, 0.24, 0.05), body, 0, BOT.torso / 2, 0);
  for (const arm of [armL, armR]) {
    part(arm, geo.ball(0.055), s.shell, 0, 0, 0);
    part(arm, geo.rod(0.032, 0.032, BOT.arm), s.shell, 0, -BOT.arm / 2, 0);
    part(arm, geo.ball(0.05), joint, 0, -BOT.arm, 0);
  }
  // Monitor head: shell, dark face, glowing visor bar.
  part(neck, geo.rod(0.04, 0.04, 0.07), s.shell, 0, 0.03, 0);
  part(neck, geo.rbox(0.38, 0.28, 0.26, 0.04), s.shell, 0, 0.2, 0);
  part(neck, geo.rbox(0.31, 0.2, 0.02, 0.008), s.monitor, 0, 0.2, 0.125);
  part(neck, geo.box(0.18, 0.035, 0.012), s.visor, 0, 0.21, 0.137);
  // The tie: a knot and a tapered blade, in the feature colour.
  const knotY = BOT.torso - 0.05;
  part(waist, geo.box(0.05, 0.04, 0.03), tie, 0, knotY, 0.125);
  part(waist, tieBlade(geo), tie, 0, knotY - 0.12, 0.121, { rx: 0.08 });
  const paper = part(armR, geo.box(0.2, 0.015, 0.26), s.paper, -0.07, -BOT.arm - 0.03, 0.05, { rx: 2.6 });

  const pickables: Mesh[] = [];
  const pick: PickData = { sessionId };
  group.traverse((o) => {
    if ((o as Mesh).isMesh) {
      o.userData.pick = pick;
      pickables.push(o as Mesh);
    }
  });
  return { sessionId, group, rig: { legL, legR, waist, armL, armR, neck, paper }, body: robot.body, tie: robot.tie, pickables };
}

/** Puts the robot on its spot, facing its way, in the pose of its state. */
export function poseRobot(obj: RobotObject, robot: Pick<Robot, 'pose' | 'badge'>, spot: Spot): void {
  const spec = poseOf(robot);
  const r = obj.rig;
  obj.group.position.set(spot.x, rootHeight(robot.pose), spot.z);
  obj.group.rotation.y = spot.facing;
  r.armL.rotation.set(spec.armL[0], 0, spec.armL[1]);
  r.armR.rotation.set(spec.armR[0], 0, spec.armR[1]);
  r.legL.rotation.x = spec.legs;
  r.legR.rotation.x = spec.legs;
  r.neck.rotation.x = spec.neck;
  r.waist.rotation.x = spec.lean;
  r.paper.visible = spec.paper;
}

function tieBlade(geo: Geometries) {
  return geo.shared('tie blade', () => {
    const g = new CylinderGeometry(0.03, 0.05, 0.2, 4);
    g.rotateY(Math.PI / 4);
    g.scale(1, 1, 0.35);
    return g;
  });
}

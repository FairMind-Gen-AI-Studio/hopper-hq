import { describe, expect, it } from 'vitest';
import { Box3, Mesh } from 'three';
import type { Robot } from '../../../src/scene/types';
import { Materials } from '../../renderer/materials';
import { Geometries, type PickData } from '../../renderer/props';
import { BOT, HEAD_DOWN, HOVER_Y, KIND_SCALE, POSES, buildRobot, poseOf, poseRobot, rootHeight, type RobotObject } from '../../renderer/robot';
import { dayTheme } from '../../renderer/theme';
import { SEAT_Y, labelAnchor, robotSpot } from '../../renderer/world';
import { checkoutFloor, desksOf } from './fixtures';

function kit() {
  return { geo: new Geometries(), mats: new Materials(dayTheme()) };
}

/** Every desk of the fixture that has a robot, built and posed at its spot. */
function posed() {
  const { geo, mats } = kit();
  return desksOf(checkoutFloor())
    .filter((d) => d.robot)
    .map((desk) => {
      const obj = buildRobot(desk.sessionId, desk.robot!, geo, mats);
      poseRobot(obj, desk.robot!, robotSpot(desk)!);
      obj.group.updateMatrixWorld(true);
      return { desk, obj, mats };
    });
}

describe('robots', () => {
  it('wears the repo colour on its body and the feature colour on its tie', () => {
    const { geo, mats } = kit();
    const robot: Robot = { pose: 'typing', badge: 'typing', body: 5, tie: 3 };
    const obj = buildRobot('s1', robot, geo, mats);
    const used = new Set(obj.pickables.map((m) => m.material));
    expect(used.has(mats.body(5))).toBe(true);
    expect(used.has(mats.joint(5))).toBe(true);
    expect(obj.pickables.filter((m) => m.material === mats.tie(3))).toHaveLength(2);
    expect(used.has(mats.surface.visor)).toBe(true);
    const plain = buildRobot('s2', { ...robot, tie: null }, geo, mats);
    expect(plain.pickables.filter((m) => m.material === mats.tie(null))).toHaveLength(2);
    expect([obj.body, obj.tie, plain.tie]).toEqual([5, 3, null]);
  });

  it('lets only its larger parts cast shadows: legs, torso, arms, head and the paper', () => {
    const { geo, mats } = kit();
    const obj = buildRobot('s1', { pose: 'holding', badge: 'done', body: 2, tie: 3 }, geo, mats);
    const casters = obj.pickables.filter((m) => m.castShadow);
    expect(casters).toHaveLength(7);
    expect(casters.filter((m) => m.material === mats.body(2))).toHaveLength(1);
    expect(casters).toContain(obj.rig.paper);
    for (const m of casters) expect([mats.joint(2), mats.surface.visor, mats.surface.monitor, mats.tie(3)]).not.toContain(m.material);
  });

  it('can be picked by any of its parts', () => {
    const { geo, mats } = kit();
    const obj = buildRobot('s1', { pose: 'waving', badge: 'needs', body: 0, tie: null }, geo, mats);
    let count = 0;
    obj.group.traverse((o) => {
      if (o instanceof Mesh) count++;
    });
    expect(obj.pickables).toHaveLength(count);
    for (const m of obj.pickables) expect(m.userData.pick as PickData).toEqual({ sessionId: 's1' });
  });

  it('turns the limb pivots for each pose', () => {
    const { geo, mats } = kit();
    const obj = buildRobot('s1', { pose: 'typing', badge: 'typing', body: 0, tie: null }, geo, mats);
    const spot = { x: 3, z: 4, facing: Math.PI };
    for (const pose of Object.keys(POSES) as Array<keyof typeof POSES>) {
      poseRobot(obj, { pose, badge: null }, spot);
      const spec = POSES[pose];
      const r = obj.rig;
      expect([r.armL.rotation.x, r.armL.rotation.z], pose).toEqual([...spec.armL]);
      expect([r.armR.rotation.x, r.armR.rotation.z], pose).toEqual([...spec.armR]);
      expect([r.legL.rotation.x, r.legR.rotation.x], pose).toEqual([spec.legs, spec.legs]);
      expect(r.neck.rotation.x, pose).toBe(spec.neck);
      expect(r.waist.rotation.x, pose).toBe(spec.lean);
      expect(r.paper.visible, pose).toBe(spec.paper);
    }
    expect(POSES.waving.armR[0]).toBeLessThan(-2.5);
    expect(POSES.typing.legs).toBeLessThan(-1.4);
    expect(POSES.waving.legs).toBe(0);
    expect(POSES.resting.lean).toBeLessThan(0);
    expect(POSES.holding.paper).toBe(true);
  });

  it('hangs its head without a signal, and not in a meeting', () => {
    expect(poseOf({ pose: 'still', badge: 'clock' }).neck).toBe(HEAD_DOWN);
    expect(poseOf({ pose: 'still', badge: 'meeting' }).neck).toBe(0);
    expect(poseOf({ pose: 'typing', badge: 'clock' })).toBe(POSES.typing);
  });

  it('sits on the chair facing the monitor, or stands beside it facing the room', () => {
    for (const { desk, obj } of posed()) {
      const spot = robotSpot(desk)!;
      expect(obj.group.position.x).toBe(spot.x);
      expect(obj.group.position.z).toBe(spot.z);
      expect(obj.group.rotation.y).toBe(spot.facing);
      const standing = desk.robot!.pose === 'waving' || desk.robot!.pose === 'holding';
      expect(obj.group.position.y, desk.state).toBeCloseTo(standing ? 0 : SEAT_Y - BOT.hip, 10);
      expect(obj.group.rotation.y, desk.state).toBe(standing ? 0 : Math.PI);
    }
    expect(rootHeight('typing')).toBeCloseTo(0.14, 10);
    expect(rootHeight('holding')).toBe(0);
  });

  it('stays inside its desk cells, under its label', () => {
    for (const { desk, obj } of posed()) {
      const box = new Box3().setFromObject(obj.group);
      expect(box.min.x, desk.state).toBeGreaterThan(desk.rect.x);
      expect(box.max.x, desk.state).toBeLessThan(desk.rect.x + desk.rect.w);
      expect(box.min.z, desk.state).toBeGreaterThan(desk.rect.y);
      expect(box.max.z, desk.state).toBeLessThan(desk.rect.y + desk.rect.h);
      expect(box.min.y, desk.state).toBeGreaterThanOrEqual(-0.001);
      expect(labelAnchor(desk).y - box.max.y, desk.state).toBeGreaterThan(0.2);
    }
  });

  it('builds a workflow agent at 0.8, in a hard hat of the hard-hat colour, with its legs and its tie', () => {
    const { geo, mats } = kit();
    const robot: Robot = { pose: 'typing', badge: null, body: 5, tie: 3 };
    const session = buildRobot('s1', robot, geo, mats);
    const agent = buildRobot('a1', robot, geo, mats, 'workflow');
    expect([session.kind, session.group.scale.x, agent.kind, agent.group.scale.x]).toEqual(['session', 1, 'workflow', 0.8]);
    expect(KIND_SCALE).toEqual({ session: 1, intern: 0.55, workflow: 0.8 });
    const hat = agent.pickables.filter((m) => m.material === mats.surface.hardhat);
    expect(hat).toHaveLength(2);
    for (const m of hat) expect(m.parent).toBe(agent.rig.neck);
    expect(session.pickables.some((m) => m.material === mats.surface.hardhat || m.material === mats.surface.jet)).toBe(false);
    expect(agent.pickables.filter((m) => m.material === mats.tie(3))).toHaveLength(2);
    expect(agent.pickables.filter((m) => m.material === mats.body(5))).toHaveLength(1);
    expect(agent.rig.legL.children.length).toBeGreaterThan(0);
    // Standing side by side, the agent is shorter, but less so than its scale alone would make it: the hat tops it.
    const height = (o: RobotObject) => {
      o.group.updateMatrixWorld(true);
      const box = new Box3().setFromObject(o.group);
      return box.max.y - box.min.y;
    };
    poseRobot(session, { pose: 'holding', badge: null }, { x: 0, z: 0, facing: 0 });
    poseRobot(agent, { pose: 'holding', badge: null }, { x: 0, z: 0, facing: 0 });
    expect(height(agent)).toBeLessThan(height(session));
    expect(height(agent) / 0.8).toBeGreaterThan(height(session) + 0.1);
  });

  it('builds an intern at 0.55, with a jetpack on its back and no legs below the hip', () => {
    const { geo, mats } = kit();
    const intern = buildRobot('p1', { pose: 'still', badge: null, body: 2, tie: 4 }, geo, mats, 'intern');
    expect([intern.kind, intern.group.scale.x]).toEqual(['intern', 0.55]);
    expect([intern.rig.legL.children, intern.rig.legR.children]).toEqual([[], []]);
    const tanks = intern.pickables.filter((m) => m.material === mats.surface.jet);
    expect(tanks).toHaveLength(2);
    for (const m of tanks) {
      expect(m.parent).toBe(intern.rig.waist);
      expect(m.position.z).toBeLessThan(-BOT.torso / 3);
    }
    expect(tanks[0]!.position.x).toBe(-tanks[1]!.position.x);
    expect(intern.pickables.some((m) => m.material === mats.surface.hardhat)).toBe(false);
    expect(intern.pickables.filter((m) => m.material === mats.tie(4))).toHaveLength(2);
    // Nothing hangs down to its spot: it hovers.
    poseRobot(intern, { pose: 'still', badge: null }, { x: 0, z: 0, facing: 0 });
    intern.group.updateMatrixWorld(true);
    expect(new Box3().setFromObject(intern.group).min.y).toBeGreaterThan(HOVER_Y + 0.1);
  });

  it('sits a workflow agent on its chair at its own size, and hovers an intern whatever its pose', () => {
    const { geo, mats } = kit();
    const spot = { x: 3, z: 4, facing: Math.PI };
    const agent = buildRobot('a1', { pose: 'typing', badge: null, body: 0, tie: null }, geo, mats, 'workflow');
    poseRobot(agent, { pose: 'typing', badge: null }, spot);
    // Its hips, BOT.hip up its scaled legs, rest on the seat.
    expect(agent.group.position.y + BOT.hip * 0.8).toBeCloseTo(SEAT_Y, 10);
    expect([agent.group.position.x, agent.group.position.z, agent.group.rotation.y]).toEqual([3, 4, Math.PI]);
    const intern = buildRobot('p1', { pose: 'still', badge: null, body: 0, tie: null }, geo, mats, 'intern');
    for (const pose of ['still', 'typing', 'holding', 'waving', 'resting'] as const) {
      poseRobot(intern, { pose, badge: null }, spot);
      expect(intern.group.position.y, pose).toBe(HOVER_Y);
    }
    expect(HOVER_Y).toBeGreaterThan(1);
    expect(rootHeight('typing', 'workflow')).toBeCloseTo(SEAT_Y - BOT.hip * 0.8, 10);
    expect(rootHeight('holding', 'workflow')).toBe(0);
    expect(rootHeight('typing', 'intern')).toBe(HOVER_Y);
    expect(rootHeight('typing', 'session')).toBe(rootHeight('typing'));
  });

  it('lets the hard hat cast a shadow, but not its brim or the jetpack', () => {
    const { geo, mats } = kit();
    const robot: Robot = { pose: 'holding', badge: 'done', body: 2, tie: 3 };
    const agent = buildRobot('a1', robot, geo, mats, 'workflow');
    const casters = agent.pickables.filter((m) => m.castShadow);
    expect(casters).toHaveLength(8);
    expect(casters.filter((m) => m.material === mats.surface.hardhat)).toHaveLength(1);
    const intern = buildRobot('p1', robot, geo, mats, 'intern');
    // Torso, arms, head and the paper: an intern has no legs, and its jetpack and nozzles cast nothing.
    expect(intern.pickables.filter((m) => m.castShadow)).toHaveLength(5);
    for (const m of intern.pickables) if (m.parent === intern.rig.waist && m.position.z < -0.1) expect(m.castShadow).toBe(false);
  });

  it('shares its geometries with every other robot', () => {
    const { geo, mats } = kit();
    buildRobot('a', { pose: 'typing', badge: 'typing', body: 0, tie: 1 }, geo, mats);
    const size = geo.size;
    buildRobot('b', { pose: 'holding', badge: 'done', body: 3, tie: null }, geo, mats);
    expect(geo.size).toBe(size);
    buildRobot('c', { pose: 'typing', badge: null, body: 1, tie: 2 }, geo, mats, 'workflow');
    buildRobot('d', { pose: 'still', badge: null, body: 1, tie: 2 }, geo, mats, 'intern');
    const kinds = geo.size;
    buildRobot('e', { pose: 'typing', badge: null, body: 4, tie: null }, geo, mats, 'workflow');
    buildRobot('f', { pose: 'still', badge: null, body: 6, tie: 0 }, geo, mats, 'intern');
    expect(geo.size).toBe(kinds);
  });
});

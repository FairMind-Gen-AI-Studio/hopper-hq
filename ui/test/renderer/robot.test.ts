import { describe, expect, it } from 'vitest';
import { Box3, Matrix4, Mesh, Quaternion, Vector3, type Object3D } from 'three';
import type { Pose, Robot } from '../../../src/scene/types';
import { Materials } from '../../renderer/materials';
import { Geometries, type PickData } from '../../renderer/props';
import {
  BOT,
  FOOSBALL_HOVER_Y,
  HEAD_DOWN,
  HOVER_Y,
  KIND_SCALE,
  LAPTOP,
  LOOPS,
  POSES,
  PUFF,
  puffAt,
  STRIDE,
  animateRobot,
  buildRobot,
  loopOf,
  phaseOf,
  poseOf,
  poseRobot,
  rootHeight,
  setSmoking,
  strideRobot,
  type Loop,
  type RobotKind,
  type RobotObject,
} from '../../renderer/robot';
import { dayTheme } from '../../renderer/theme';
import { DESK_CHAIR, SEAT_Y, deskAnchor, labelAnchor, placeSpot, seatSpot, standSpot } from '../../renderer/world';
import { checkoutFloor, seatsOf } from './fixtures';

function kit() {
  return { geo: new Geometries(), mats: new Materials(dayTheme()) };
}

/** Every session of the fixture that has a robot, built and posed at its desk. */
function posed() {
  const { geo, mats } = kit();
  const floor = checkoutFloor();
  return seatsOf(floor)
    .filter(({ occupant }) => occupant.robot)
    .map(({ desk, occupant }) => {
      const obj = buildRobot(occupant.sessionId, occupant.robot!, geo, mats);
      poseRobot(obj, occupant.robot!, placeSpot(floor, desk, occupant)!);
      obj.group.updateMatrixWorld(true);
      return { floor, desk, occupant, obj, mats };
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
    for (const m of obj.pickables) expect(m.userData.pick as PickData).toEqual({ kind: 'desk', id: 's1' });
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
    // Every leisure pose stands, like waving and holding: the break area has no chair.
    expect([POSES.gintonic.legs, POSES.biliardino.legs, POSES.coffee.legs]).toEqual([0, 0, 0]);
  });

  it('holds a glass and a lime over a gin tonic, a cup over a coffee, and nothing over a biliardino, never casting their shadow', () => {
    const { geo, mats } = kit();
    const obj = buildRobot('s1', { pose: 'still', badge: null, body: 0, tie: null }, geo, mats);
    const spot = { x: 0, z: 0, facing: 0 };
    const cases: Array<[pose: Pose, glass: boolean, lime: boolean, cup: boolean]> = [
      ['gintonic', true, true, false],
      ['coffee', false, false, true],
      ['biliardino', false, false, false],
      ['still', false, false, false],
    ];
    for (const [pose, glass, lime, cup] of cases) {
      poseRobot(obj, { pose, badge: null }, spot);
      expect([obj.rig.glass.visible, obj.rig.lime.visible, obj.rig.cup.visible], pose).toEqual([glass, lime, cup]);
    }
    for (const m of [obj.rig.glass, obj.rig.lime, obj.rig.cup]) expect(m.castShadow).toBe(false);
    // On its way it holds nothing, whatever its pose.
    poseRobot(obj, { pose: 'gintonic', badge: null }, spot);
    strideRobot(obj, { x: 1, z: 1, facing: 0 }, 0);
    expect([obj.rig.glass.visible, obj.rig.lime.visible, obj.rig.cup.visible]).toEqual([false, false, false]);
  });

  it('strides on its way: on its feet at its point, facing its way, one leg forward and the other arm with it, bobbing at its size', () => {
    const { geo, mats } = kit();
    const obj = buildRobot('s1', { pose: 'holding', badge: 'done', body: 0, tie: null }, geo, mats);
    poseRobot(obj, { pose: 'holding', badge: 'done' }, { x: 0, z: 0, facing: 0 });
    const r = obj.rig;
    const limbs = () => [r.legL.rotation.x, r.legR.rotation.x, r.armL.rotation.x, r.armR.rotation.x];
    // A quarter of a swing in: the right leg forward (a negative x swings a limb forward), the left arm with it.
    const quarter = Math.PI / 2 / STRIDE.rate;
    strideRobot(obj, { x: 3, z: 4, facing: Math.PI / 2 }, quarter);
    expect([obj.group.position.x, obj.group.position.z, obj.group.rotation.y]).toEqual([3, 4, Math.PI / 2]);
    expect(obj.group.position.y).toBeCloseTo(0, 10);
    limbs().forEach((v, i) => expect(v).toBeCloseTo([0.6, -0.6, 0.05 - 0.48, 0.05 + 0.48][i]!, 10));
    expect([r.armL.rotation.z, r.armR.rotation.z, r.neck.rotation.x, r.waist.rotation.x, r.paper.visible]).toEqual([-0.1, 0.1, 0, 0, false]);
    // Half a swing later, the other way round.
    strideRobot(obj, { x: 3, z: 5, facing: Math.PI / 2 }, 3 * quarter);
    limbs().forEach((v, i) => expect(v).toBeCloseTo([-0.6, 0.6, 0.05 + 0.48, 0.05 - 0.48][i]!, 10));
    // Between, legs together, it is at the top of its bob: a workflow agent bobs less, and an intern flies.
    strideRobot(obj, { x: 3, z: 5, facing: 0 }, 0);
    expect([obj.group.position.y, Math.abs(r.legL.rotation.x), Math.abs(r.legR.rotation.x)]).toEqual([STRIDE.bob, 0, 0]);
    const agent = buildRobot('a1', { pose: 'typing', badge: null, body: 0, tie: null }, geo, mats, 'workflow');
    strideRobot(agent, { x: 0, z: 0, facing: 0 }, 0);
    expect(agent.group.position.y).toBeCloseTo(STRIDE.bob * KIND_SCALE.workflow, 10);
    const intern = buildRobot('p1', { pose: 'still', badge: null, body: 0, tie: null }, geo, mats, 'intern');
    strideRobot(intern, { x: 1, z: 2, facing: 0 }, quarter);
    expect([intern.group.position.x, intern.group.position.y, intern.group.position.z]).toEqual([1, HOVER_Y, 2]);
    // At its place again, it takes its pose.
    poseRobot(obj, { pose: 'holding', badge: 'done' }, { x: 3, z: 5, facing: 0 });
    expect([r.legL.rotation.x, r.paper.visible]).toEqual([POSES.holding.legs, true]);
  });

  it('hangs its head without a signal, and not in a meeting', () => {
    expect(poseOf({ pose: 'still', badge: 'clock' }).neck).toBe(HEAD_DOWN);
    expect(poseOf({ pose: 'still', badge: 'meeting' }).neck).toBe(0);
    expect(poseOf({ pose: 'typing', badge: 'clock' })).toBe(POSES.typing);
  });

  it('sits on the chair facing the monitor, or stands beside it facing away from the desk', () => {
    for (const { floor, desk, occupant, obj } of posed()) {
      const spot = placeSpot(floor, desk, occupant)!;
      expect(obj.group.position.x).toBe(spot.x);
      expect(obj.group.position.z).toBe(spot.z);
      expect(obj.group.rotation.y).toBe(spot.facing);
      const standing = occupant.robot!.pose === 'waving' || occupant.robot!.pose === 'holding';
      // Facing south (0): standing at a desk of a pod's south row, or seated at one of its north row.
      const south = standing === (desk.chair === 'south');
      expect(obj.group.position.y, occupant.state).toBeCloseTo(standing ? 0 : SEAT_Y - BOT.hip, 10);
      expect(obj.group.rotation.y, `${occupant.state} at ${desk.id}`).toBe(south ? 0 : Math.PI);
    }
    expect(rootHeight('typing')).toBeCloseTo(0.14, 10);
    expect(rootHeight('holding')).toBe(0);
  });

  it('stays inside its desk cells, under its label, on either side of a pod', () => {
    const sides = new Set<string>();
    for (const { floor, desk, occupant, obj } of posed()) {
      // A hidden laptop still has extent, and a desk's robot has none open.
      obj.rig.laptop.removeFromParent();
      const box = new Box3().setFromObject(obj.group);
      const name = `${occupant.state} at ${desk.id}`;
      sides.add(desk.chair);
      expect(box.min.x, name).toBeGreaterThan(desk.rect.x);
      expect(box.max.x, name).toBeLessThan(desk.rect.x + desk.rect.w);
      expect(box.min.z, name).toBeGreaterThan(desk.rect.y);
      expect(box.max.z, name).toBeLessThan(desk.rect.y + desk.rect.h);
      expect(box.min.y, name).toBeGreaterThanOrEqual(-0.001);
      expect(labelAnchor(floor, desk, occupant).y - box.max.y, name).toBeGreaterThan(0.2);
    }
    expect([...sides].sort()).toEqual(['north', 'south']);
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

  it('opens a laptop on the table before a robot seated at a room, the same height for every kind, and puts it away on its way', () => {
    const { geo, mats } = kit();
    const spot = { x: 3, z: 4, facing: 0 };
    const look = { pose: 'typing', badge: null } as const;
    const kinds: RobotKind[] = ['session', 'workflow', 'intern'];
    const bots = kinds.map((kind) => buildRobot(kind, { ...look, body: 0, tie: null }, geo, mats, kind));
    // Closed away until a robot sits at a table.
    expect(bots.map((b) => b.rig.laptop.visible)).toEqual([false, false, false]);
    for (const b of bots) poseRobot(b, look, spot);
    expect(bots.map((b) => b.rig.laptop.visible)).toEqual([false, false, false]);
    for (const b of bots) poseRobot(b, look, spot, true);
    expect(bots.map((b) => b.rig.laptop.visible)).toEqual([true, true, true]);
    // An intern flies and has no laptop to show; the others have it on the table, ahead of their seat.
    expect(bots[2]!.rig.laptop.children).toHaveLength(0);
    for (const b of bots.slice(0, 2)) {
      b.group.updateMatrixWorld(true);
      const base = new Vector3();
      b.rig.laptop.getWorldPosition(base);
      expect([b.kind, base.y.toFixed(3), base.x.toFixed(3), base.z.toFixed(3)]).toEqual([b.kind, LAPTOP.top.toFixed(3), '3.000', (4 + LAPTOP.ahead).toFixed(3)]);
      const size = new Box3().setFromObject(b.rig.laptop).getSize(new Vector3());
      expect(size.x).toBeCloseTo(LAPTOP.w, 6);
    }
    // A standing robot has no chair to sit at.
    poseRobot(bots[0]!, { pose: 'holding', badge: null }, spot, true);
    expect(bots[0]!.rig.laptop.visible).toBe(false);
    poseRobot(bots[0]!, look, spot, true);
    strideRobot(bots[0]!, { x: 1, z: 1, facing: 0 }, 0.1);
    expect(bots[0]!.rig.laptop.visible).toBe(false);
    // It picks what its robot picks.
    expect(bots[0]!.pickables.filter((m) => bots[0]!.rig.laptop.getObjectById(m.id))).not.toHaveLength(0);
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
    // At the foosball table, though, an intern floats low enough for its hands to meet the table's handles instead.
    poseRobot(intern, { pose: 'biliardino', badge: null }, spot);
    expect(intern.group.position.y).toBe(FOOSBALL_HOVER_Y);
    expect(rootHeight('biliardino', 'intern')).toBe(FOOSBALL_HOVER_Y);
    expect(FOOSBALL_HOVER_Y).toBeLessThan(HOVER_Y);
  });

  it('lets the hard hat cast a shadow, but not its brim, and an intern cast none', () => {
    const { geo, mats } = kit();
    const robot: Robot = { pose: 'holding', badge: 'done', body: 2, tie: 3 };
    const agent = buildRobot('a1', robot, geo, mats, 'workflow');
    const casters = agent.pickables.filter((m) => m.castShadow);
    expect(casters).toHaveLength(8);
    expect(casters.filter((m) => m.material === mats.surface.hardhat)).toHaveLength(1);
    // Small and high above the floor, an intern would leave only specks.
    const intern = buildRobot('p1', robot, geo, mats, 'intern');
    expect(intern.pickables.length).toBeGreaterThan(10);
    expect(intern.pickables.filter((m) => m.castShadow)).toEqual([]);
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

describe('the cigar', () => {
  const look = { pose: 'typing', badge: 'typing', body: 0, tie: null } as const;

  it('shows while its look says smoking, hidden otherwise (the default, with the field left out), on every kind', () => {
    const { geo, mats } = kit();
    for (const kind of ['session', 'workflow', 'intern'] as const) {
      expect(buildRobot('s-on', { ...look, smoking: true }, geo, mats, kind).rig.cigar.visible, kind).toBe(true);
      expect(buildRobot('s-off', { ...look, smoking: false }, geo, mats, kind).rig.cigar.visible, kind).toBe(false);
      expect(buildRobot('s-unset', look, geo, mats, kind).rig.cigar.visible, kind).toBe(false);
    }
  });

  it('lights in every pose, and while striding, since a smoke test can be running in any of them', () => {
    const { geo, mats } = kit();
    const obj = buildRobot('s1', { ...look, smoking: true }, geo, mats);
    for (const pose of Object.keys(POSES) as Array<keyof typeof POSES>) {
      poseRobot(obj, { pose, badge: null }, { x: 0, z: 0, facing: 0 });
      expect(obj.rig.cigar.visible, pose).toBe(true);
    }
    strideRobot(obj, { x: 1, z: 1, facing: 0 }, 0.3);
    expect(obj.rig.cigar.visible).toBe(true);
  });

  it('casts no shadow, from its body, its tip or its puff, on any kind', () => {
    const { geo, mats } = kit();
    for (const kind of ['session', 'workflow', 'intern'] as const) {
      const obj = buildRobot('s1', { ...look, smoking: true, body: 2, tie: 3 }, geo, mats, kind);
      const before = obj.pickables.filter((m) => m.castShadow).length;
      obj.rig.cigar.traverse((o) => {
        if ((o as Mesh).isMesh) expect((o as Mesh).castShadow, kind).toBe(false);
      });
      // Showing it never turns a part into a shadow caster: the same larger parts cast as before.
      expect(obj.pickables.filter((m) => m.castShadow).length, kind).toBe(before);
    }
  });

  it('toggles with setSmoking, on the same robot, without rebuilding it', () => {
    const { geo, mats } = kit();
    const obj = buildRobot('s1', { ...look, smoking: false }, geo, mats);
    const size = geo.size;
    expect(obj.rig.cigar.visible).toBe(false);
    const { group, rig } = obj;
    setSmoking(obj, true);
    expect(obj.rig.cigar.visible).toBe(true);
    setSmoking(obj, false);
    expect(obj.rig.cigar.visible).toBe(false);
    // Still the very same objects: no second buildRobot, no new geometry.
    expect(obj.group).toBe(group);
    expect(obj.rig).toBe(rig);
    expect(geo.size).toBe(size);
  });

  it('sends up a column of puffs, smoke signals, that rise, grow and vanish while it shows, and sits still otherwise', () => {
    const { geo, mats } = kit();
    const m = new Matrix4();
    const at = new Vector3();
    const q = new Quaternion();
    const size = new Vector3();
    const puffs = (obj: ReturnType<typeof buildRobot>) =>
      Array.from({ length: PUFF.puffs }, (_, i) => {
        obj.rig.puff.getMatrixAt(i, m);
        m.decompose(at, q, size);
        return { y: at.y, scale: size.x };
      });

    const lit = buildRobot('s1', { ...look, smoking: true }, geo, mats);
    poseRobot(lit, look, { x: 0, z: 0, facing: 0 });
    // One instanced mesh, one draw, however many puffs, and none of them casts a shadow.
    expect(lit.rig.puff.count).toBe(PUFF.puffs);
    expect(PUFF.puffs).toBeGreaterThanOrEqual(5);
    expect(lit.rig.puff.castShadow).toBe(false);
    let minY = Infinity;
    let maxY = -Infinity;
    let maxScale = -Infinity;
    for (let k = 0; k <= 200; k++) {
      animateRobot(lit, look, (k / 200) * (1 / PUFF.rate), 0);
      const now = puffs(lit);
      // Spread up the column, never in one clump: the puffs are a 1/PUFF.puffs of a cycle apart.
      expect(new Set(now.map((p) => p.y.toFixed(6))).size, `t${k}`).toBe(PUFF.puffs);
      for (const p of now) {
        minY = Math.min(minY, p.y);
        maxY = Math.max(maxY, p.y);
        maxScale = Math.max(maxScale, p.scale);
        expect(p.scale).toBeGreaterThanOrEqual(-1e-6);
      }
    }
    expect(minY).toBeGreaterThanOrEqual(PUFF.y - 1e-6);
    expect(maxY).toBeLessThanOrEqual(PUFF.y + PUFF.rise + 1e-6);
    // Smoke signals: the column rises far above the head, and its puffs swell well past the size they start at.
    expect(PUFF.rise).toBeGreaterThan(0.5);
    expect(maxY - minY).toBeGreaterThan(PUFF.rise * 0.9);
    expect(maxScale).toBeLessThanOrEqual(1 + PUFF.grow);
    expect(maxScale).toBeGreaterThan(1.5);

    const unlit = buildRobot('s2', look, geo, mats);
    poseRobot(unlit, look, { x: 0, z: 0, facing: 0 });
    const rest = puffs(unlit);
    for (let k = 0; k <= 10; k++) animateRobot(unlit, look, k * 0.3, 1.2);
    expect(puffs(unlit)).toEqual(rest);
  });

  it('grows a puff as it rises and scales it to nothing at either end of its cycle', () => {
    expect(puffAt(0).scale).toBeCloseTo(0, 9);
    expect(puffAt(1).scale).toBeCloseTo(0, 9);
    expect(puffAt(0.6).scale).toBeGreaterThan(puffAt(0.4).scale);
    expect(puffAt(1).y).toBeCloseTo(PUFF.rise, 9);
  });
});

describe('loops at rest', () => {
  type Look = Pick<Robot, 'pose' | 'badge'>;
  const SPOT = { x: 3, z: 4, facing: Math.PI / 2 };
  /** A robot of this kind in this look, in its pose at SPOT. */
  function rested(look: Look, kind: RobotKind = 'session'): RobotObject {
    const { geo, mats } = kit();
    const obj = buildRobot('s1', { ...look, body: 0, tie: null }, geo, mats, kind);
    poseRobot(obj, look, SPOT);
    return obj;
  }
  /** Every number that places a part of the robot, by part and axis, and whether each part shows. */
  function numbers(obj: RobotObject): Map<string, number> {
    const r = obj.rig;
    const names = new Map<Object3D, string>([
      [obj.group, 'root'],
      [r.legL, 'legL'],
      [r.legR, 'legR'],
      [r.waist, 'waist'],
      [r.armL, 'armL'],
      [r.armR, 'armR'],
      [r.neck, 'neck'],
      [r.paper, 'paper'],
    ]);
    const out = new Map<string, number>();
    let part = 0;
    obj.group.traverse((o) => {
      const name = names.get(o) ?? `part ${part++}`;
      for (const axis of ['x', 'y', 'z'] as const) {
        out.set(`${name} position.${axis}`, o.position[axis]);
        out.set(`${name} rotation.${axis}`, o.rotation[axis]);
        out.set(`${name} scale.${axis}`, o.scale[axis]);
      }
      out.set(`${name} visible`, o.visible ? 1 : 0);
    });
    return out;
  }
  /** Each look a robot rests in, its kind, and what its loop moves: by how much at most. */
  const looks = (): Array<[look: Look, kind: RobotKind, moves: Record<string, number>]> => [
    [{ pose: 'typing', badge: 'typing' }, 'session', { 'armL rotation.x': LOOPS.type.arm, 'armR rotation.x': LOOPS.type.arm }],
    [{ pose: 'typing', badge: null }, 'workflow', { 'armL rotation.x': LOOPS.type.arm, 'armR rotation.x': LOOPS.type.arm }],
    [{ pose: 'waving', badge: 'needs' }, 'session', { 'armR rotation.x': LOOPS.wave.arm }],
    [{ pose: 'holding', badge: 'done' }, 'session', { 'armL rotation.x': LOOPS.sway.arm, 'armR rotation.x': LOOPS.sway.arm }],
    [{ pose: 'still', badge: 'clock' }, 'session', { 'waist rotation.x': LOOPS.doze.lean, 'neck rotation.x': LOOPS.doze.neck }],
    [{ pose: 'resting', badge: null }, 'session', { 'waist rotation.x': LOOPS.breathe.lean, 'neck rotation.x': LOOPS.breathe.neck }],
    [{ pose: 'still', badge: null }, 'intern', { 'root position.y': LOOPS.hover.bob }],
    [{ pose: 'still', badge: 'meeting' }, 'session', {}],
    [{ pose: 'gintonic', badge: null }, 'intern', { 'root position.y': LOOPS.hover.bob }],
    [{ pose: 'coffee', badge: null }, 'workflow', { 'waist rotation.x': LOOPS.breathe.lean, 'neck rotation.x': LOOPS.breathe.neck }],
    [{ pose: 'biliardino', badge: null }, 'workflow', { 'armL rotation.x': LOOPS.foosball.arm, 'armR rotation.x': LOOPS.foosball.arm }],
    // An intern plays too, at the biliardino's own low height (FOOSBALL_HOVER_Y, rootHeight), not its desk's hover.
    [{ pose: 'biliardino', badge: null }, 'intern', { 'armL rotation.x': LOOPS.foosball.arm, 'armR rotation.x': LOOPS.foosball.arm }],
  ];

  it('starts each robot at a phase in [0, 2π) hashed from its id: the same for the same id, spread round the circle', () => {
    const ids = Array.from({ length: 256 }, (_, i) => JSON.stringify(['session', `s${i}`]));
    const phases = ids.map(phaseOf);
    expect(ids.map(phaseOf)).toEqual(phases);
    expect(new Set(phases).size).toBe(256);
    const eighths = new Array<number>(8).fill(0);
    for (const p of phases) {
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThan(2 * Math.PI);
      eighths[Math.floor(p / (Math.PI / 4))]!++;
    }
    // About a 32 in each eighth of the circle.
    for (const n of eighths) expect(n).toBeGreaterThanOrEqual(16);
    for (const n of eighths) expect(n).toBeLessThanOrEqual(48);
    // Ids that differ only in their last character, as a floor's do, start well apart.
    const near = ['sw-a1', 'sw-a2', 'sw-a3', 'sw-a4'].map(phaseOf);
    for (let i = 1; i < near.length; i++) expect(Math.abs(near[i]! - near[i - 1]!)).toBeGreaterThan(0.3);
  });

  it('types while working and at a meeting table, waves when it needs you, sways its paper when done, dozes without a signal, breathes when idle and bobs as an intern, with none in a meeting', () => {
    const want: Record<string, Loop | null> = { working: 'type', needs_you: 'wave', done: 'sway', no_signal: 'doze', idle: 'breathe', in_meeting: null };
    const seen = new Set<string>();
    for (const { occupant } of posed()) {
      expect(loopOf(occupant.robot!), occupant.state).toBe(want[occupant.state]);
      seen.add(occupant.state);
    }
    expect([...seen].sort()).toEqual(Object.keys(want).sort());
    // An intern hovers in every pose but one: at the foosball table it plays like any other kind.
    for (const [look, kind] of looks()) expect(loopOf(look, kind), `${look.pose} ${kind}`).toBe(kind === 'intern' && look.pose !== 'biliardino' ? 'hover' : loopOf(look));
    expect([loopOf({ pose: 'typing', badge: null }, 'workflow'), loopOf({ pose: 'waving', badge: 'needs' }, 'intern'), loopOf({ pose: 'biliardino', badge: null }, 'intern')]).toEqual(['type', 'hover', 'foosball']);
    expect(LOOPS).toEqual({
      type: { rate: 15, arm: 0.08 },
      wave: { rate: 7, arm: 0.3 },
      sway: { rate: 2, arm: 0.06 },
      breathe: { rate: 1.6, lean: 0.03, neck: 0.03 },
      doze: { rate: 0.9, lean: 0.02, neck: 0.06 },
      hover: { rate: 3, bob: 0.03 },
      foosball: { rate: 6, arm: 0.12 },
    });
    expect([loopOf({ pose: 'gintonic', badge: null }), loopOf({ pose: 'coffee', badge: null }), loopOf({ pose: 'biliardino', badge: null })]).toEqual(['breathe', 'breathe', 'foosball']);
  });

  it('moves only the pivots of its loop, never further from its pose than the loop goes, and all the way to it', () => {
    for (const [look, kind, moves] of looks()) {
      const name = `${look.pose} ${look.badge} ${kind}`;
      const obj = rested(look, kind);
      const rest = numbers(obj);
      const loop = loopOf(look, kind);
      const period = loop ? (2 * Math.PI) / LOOPS[loop].rate : 1;
      const reach = new Map<string, number>();
      for (let k = 0; k <= 400; k++) {
        animateRobot(obj, look, 5 + (k * period) / 400, 1.3);
        for (const [key, v] of numbers(obj)) {
          const d = Math.abs(v - rest.get(key)!);
          if (d > 0) reach.set(key, Math.max(reach.get(key) ?? 0, d));
        }
      }
      expect([...reach.keys()].sort(), name).toEqual(Object.keys(moves).sort());
      for (const [key, most] of Object.entries(moves)) {
        expect(reach.get(key)!, `${name} ${key}`).toBeLessThanOrEqual(most + 1e-12);
        expect(reach.get(key)!, `${name} ${key}`).toBeGreaterThan(0.99 * most);
      }
    }
  });

  it('is in its pose where its loop is at zero, and poseRobot puts it back in it from anywhere in its loop', () => {
    for (const [look, kind] of looks()) {
      const name = `${look.pose} ${look.badge} ${kind}`;
      const obj = rested(look, kind);
      const rest = numbers(obj);
      animateRobot(obj, look, 0, 0);
      expect(numbers(obj), name).toEqual(rest);
      animateRobot(obj, look, 0.37, 2);
      if (loopOf(look, kind)) expect(numbers(obj), name).not.toEqual(rest);
      else expect(numbers(obj), name).toEqual(rest);
      poseRobot(obj, look, SPOT);
      expect(numbers(obj), name).toEqual(rest);
    }
    // Posing allocates nothing: a look's pose is one object, a robot's without a signal too.
    expect(poseOf({ pose: 'still', badge: 'clock' })).toBe(poseOf({ pose: 'still', badge: 'clock' }));
  });

  /** A desk with its chair on this edge, and its chair's back as buildDesk sets it, behind the seat. */
  function deskWith(chair: 'north' | 'south') {
    const desk = { rect: { x: 2, y: 7, w: 2, h: 2 }, chair };
    const a = deskAnchor(desk);
    const back = new Box3().setFromCenterAndSize(new Vector3(a.x, 0.75, a.z + (chair === 'north' ? -1 : 1) * DESK_CHAIR.backZ), new Vector3(DESK_CHAIR.w, 0.5, DESK_CHAIR.back));
    return { desk, back };
  }
  /** The corners of the head's box, in the world: rbox 0.38 x 0.28 x 0.26 at 0.2 m up the neck. */
  const headCorners = (obj: RobotObject) =>
    [-1, 1].flatMap((x) => [-1, 1].flatMap((y) => [-1, 1].map((z) => new Vector3(0.19 * x, 0.2 + 0.14 * y, 0.13 * z).applyMatrix4(obj.rig.neck.matrixWorld))));

  it("waves its raised hand forward and back, clear of its head and of its chair's back over a whole period, whichever side its chair is on", () => {
    const look: Look = { pose: 'waving', badge: 'needs' };
    const obj = rested(look);
    /** How far a point in the neck's frame is outside the head's rounded box (radius 0.04): negative inside. */
    const fromHead = (p: Vector3) => {
      const q = new Vector3(Math.abs(p.x) - 0.15, Math.abs(p.y - 0.2) - 0.1, Math.abs(p.z) - 0.09);
      return new Vector3(Math.max(q.x, 0), Math.max(q.y, 0), Math.max(q.z, 0)).length() + Math.min(Math.max(q.x, q.y, q.z), 0) - 0.04;
    };
    const period = (2 * Math.PI) / LOOPS.wave.rate;
    for (const chair of ['north', 'south'] as const) {
      const { desk, back } = deskWith(chair);
      for (let k = 0; k < 96; k++) {
        poseRobot(obj, look, standSpot(desk));
        animateRobot(obj, look, (k * period) / 96, 0);
        obj.group.updateMatrixWorld(true);
        // The hand: a ball of 0.05 m at the end of the arm.
        const hand = new Vector3(0, -BOT.arm, 0).applyMatrix4(obj.rig.armR.matrixWorld);
        expect(fromHead(hand.clone().applyMatrix4(obj.rig.neck.matrixWorld.clone().invert())), `${chair} ${k}: off the head`).toBeGreaterThanOrEqual(0.05);
        expect(back.distanceToPoint(hand), `${chair} ${k}: off the chair's back`).toBeGreaterThanOrEqual(0.05);
      }
    }
  });

  it("breathes forward from its resting pose and back to it, its head reaching no further back toward its chair's back than at rest", () => {
    const look: Look = { pose: 'resting', badge: null };
    const obj = rested(look);
    const period = (2 * Math.PI) / LOOPS.breathe.rate;
    for (const chair of ['north', 'south'] as const) {
      const { desk, back } = deskWith(chair);
      // How far the head's box reaches toward the chair's back, past the back's near face.
      const reach = () => {
        obj.group.updateMatrixWorld(true);
        const z = headCorners(obj).map((p) => p.z);
        return chair === 'north' ? back.max.z - Math.min(...z) : Math.max(...z) - back.min.z;
      };
      poseRobot(obj, look, seatSpot(desk));
      const rest = reach();
      let least = Infinity;
      for (let k = 0; k < 96; k++) {
        poseRobot(obj, look, seatSpot(desk));
        animateRobot(obj, look, (k * period) / 96, 0.7);
        const d = reach();
        expect(d, `${chair} ${k}`).toBeLessThanOrEqual(rest + 1e-12);
        least = Math.min(least, d);
      }
      // It does breathe: forward, away from the back.
      expect(least).toBeLessThan(rest - 0.005);
    }
  });

  it('keeps two robots in the same loop out of step by their phases, the later one where the other was before', () => {
    const look: Look = { pose: 'typing', badge: 'typing' };
    const a = rested(look);
    const b = rested(look);
    animateRobot(a, look, 1, phaseOf('sw-a1'));
    animateRobot(b, look, 1, phaseOf('sw-a2'));
    expect(Math.abs(a.rig.armL.rotation.x - b.rig.armL.rotation.x)).toBeGreaterThan(0.01);
    animateRobot(a, look, 1 + (phaseOf('sw-a2') - phaseOf('sw-a1')) / LOOPS.type.rate, phaseOf('sw-a1'));
    expect(a.rig.armL.rotation.x).toBeCloseTo(b.rig.armL.rotation.x, 10);
    expect(a.rig.armR.rotation.x).toBeCloseTo(b.rig.armR.rotation.x, 10);
  });
});

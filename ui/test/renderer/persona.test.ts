import { describe, expect, it } from 'vitest';
import { Box3, type Mesh } from 'three';
import { PERSONAS, type Persona } from '../../../src/scene/persona';
import { Materials } from '../../renderer/materials';
import { Geometries } from '../../renderer/props';
import { buildRobot } from '../../renderer/robot';
import { PERSONA_BODY, PERSONA_MESHES, setPersonaVisible } from '../../renderer/persona';
import { dayTheme } from '../../renderer/theme';

function kit() {
  return { geo: new Geometries(), mats: new Materials(dayTheme()) };
}

/** Every persona accessory mesh of a robot built in this look: headgear then held, the same order PERSONA_MESHES counts. */
function accessoriesOf(persona: Persona): Mesh[] {
  const { geo, mats } = kit();
  const obj = buildRobot('s1', { pose: 'typing', badge: null, body: 0, tie: null, persona }, geo, mats);
  return [...obj.rig.persona.headgear, ...obj.rig.persona.held];
}

describe('persona accessories', () => {
  it('builds the mesh count PERSONA_MESHES pins for every persona, none of them over the design cap of 4', () => {
    for (const persona of PERSONAS) {
      expect(accessoriesOf(persona), persona).toHaveLength(PERSONA_MESHES[persona]);
      expect(PERSONA_MESHES[persona], persona).toBeLessThanOrEqual(4);
    }
  });

  it("builds 'none' with nothing: no headgear, no held prop, the plain look", () => {
    const meshes = accessoriesOf('none');
    expect(meshes).toHaveLength(0);
    expect(PERSONA_MESHES.none).toBe(0);
  });

  it('never lets a persona accessory cast a shadow, at a persona-sized draw it is never worth', () => {
    for (const persona of PERSONAS) {
      for (const mesh of accessoriesOf(persona)) expect(mesh.castShadow, persona).toBe(false);
    }
  });

  it("recolours a persona's torso to its outfit (OQ-3), but leaves 'boss' and 'none' in the repo colour", () => {
    const { geo, mats } = kit();
    for (const persona of PERSONAS) {
      const obj = buildRobot('s1', { pose: 'typing', badge: null, body: 5, tie: 3, persona }, geo, mats);
      const bodySurface = PERSONA_BODY[persona];
      const expected = bodySurface ? mats.surface[bodySurface] : mats.body(5);
      // The torso box is a direct child of waist (robot.ts buildRobot): the one mesh the outfit recolours.
      const torso = obj.rig.waist.children.find((c) => (c as Mesh).material === expected);
      expect(torso, persona).toBeDefined();
      // The tie stays in the feature colour, whatever the outfit: the desk's own cue (user-decisions.md OQ-3).
      expect(obj.pickables.filter((m) => m.material === mats.tie(3)), persona).toHaveLength(2);
    }
  });

  it('toggles headgear and the held prop independently with setPersonaVisible', () => {
    const { geo, mats } = kit();
    const obj = buildRobot('s1', { pose: 'typing', badge: null, body: 0, tie: null, persona: 'qa' }, geo, mats);
    const rig = obj.rig.persona;
    expect([rig.headgearGroup.visible, rig.heldGroup.visible]).toEqual([true, true]);
    setPersonaVisible(rig, { headgear: true, held: false });
    expect([rig.headgearGroup.visible, rig.heldGroup.visible]).toEqual([true, false]);
    setPersonaVisible(rig, { headgear: false, held: true });
    expect([rig.headgearGroup.visible, rig.heldGroup.visible]).toEqual([false, true]);
  });

  it('suppresses the workflow hard hat when its persona has headgear, but keeps it for a headgear-less persona', () => {
    const { geo, mats } = kit();
    const robot = { pose: 'typing' as const, badge: null, body: 2, tie: 3 };
    const withHeadgear = buildRobot('a1', { ...robot, persona: 'qa' }, geo, mats, 'workflow');
    expect(withHeadgear.rig.hardHat).toHaveLength(2);
    for (const m of withHeadgear.rig.hardHat) expect(m.visible).toBe(false);
    const plain = buildRobot('a2', { ...robot, persona: 'none' }, geo, mats, 'workflow');
    for (const m of plain.rig.hardHat) expect(m.visible).toBe(true);
    // 'boss' has no headgear either: a workflow agent never gets boss in practice, but the hat stays if it did.
    const boss = buildRobot('a3', { ...robot, persona: 'boss' }, geo, mats, 'workflow');
    for (const m of boss.rig.hardHat) expect(m.visible).toBe(true);
  });

  it('defaults to no persona (today\'s plain look) when the look leaves persona out', () => {
    const { geo, mats } = kit();
    const obj = buildRobot('s1', { pose: 'typing', badge: null, body: 0, tie: null }, geo, mats);
    expect(obj.persona).toBe('none');
    expect([...obj.rig.persona.headgear, ...obj.rig.persona.held]).toHaveLength(0);
  });

  it('never lets a persona\'s headgear/held-prop meshes overlap the lit cigar, for every persona, while smoking', () => {
    // The cigar's own group (robot.ts rig.cigar) also carries the rising smoke puff, whose instanced bounding box
    // reaches well above the head — real, expected, and irrelevant to a mouth-level mesh collision — so this
    // isolates the cigar's two solid meshes (its body and its lit tip, robot.ts CIGAR/CIGAR_TIP) by excluding the
    // child named 'smoke' (robot.ts `puff.name = 'smoke'`) rather than boxing the whole group. Each accessory mesh
    // is boxed and checked on its own, not as one box per group: a persona with two meshes that each individually
    // clear the cigar on a different axis (e.g. one clears it in x, the other in y) would otherwise read as a false
    // collision once their two boxes are merged into a single bounding box that spans both axes.
    const { geo, mats } = kit();
    for (const persona of PERSONAS) {
      const obj = buildRobot('s1', { pose: 'typing', badge: null, body: 0, tie: null, persona, smoking: true }, geo, mats);
      const cigarBox = new Box3();
      for (const child of obj.rig.cigar.children) {
        if (child.name !== 'smoke') cigarBox.expandByObject(child);
      }
      for (const [slot, group] of [
        ['headgear', obj.rig.persona.headgearGroup],
        ['held', obj.rig.persona.heldGroup],
      ] as const) {
        for (const mesh of group.children) {
          const meshBox = new Box3().setFromObject(mesh);
          expect(cigarBox.intersectsBox(meshBox), `${persona} ${slot}`).toBe(false);
        }
      }
    }
  });
});

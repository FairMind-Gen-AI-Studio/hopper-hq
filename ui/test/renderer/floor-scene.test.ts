import { describe, expect, it } from 'vitest';
import { Mesh, type BufferGeometry, type Material } from 'three';
import { FloorScene, layoutSignature } from '../../renderer/floor-scene';
import { dayTheme } from '../../renderer/theme';
import { HOME_AZIMUTH, deskAnchor, robotSpot, seatSpot, shadowExtent } from '../../renderer/world';
import { checkoutFloor, checkoutIslands, desksOf, makeFloor, type IslandSpec } from './fixtures';

/** The checkout floor after a change: sw-a1 needs you, sw-c3 left and sw-x9 sat down at the same island. */
function changedIslands(): IslandSpec[] {
  const islands = checkoutIslands();
  islands[0]!.desks = [
    { id: 'sw-a1', state: 'needs_you', agents: 1 },
    { id: 'sw-b2', state: 'done' },
    { id: 'sw-x9', state: 'working' },
  ];
  return islands;
}

function sceneOf(floor = checkoutFloor()) {
  const fs = new FloorScene(dayTheme());
  fs.apply(floor);
  return fs;
}

describe('the floor scene', () => {
  it('builds the shell, a desk per session and a robot per desk that is not dormant, under two lights', () => {
    const fs = sceneOf();
    expect(fs.shell).not.toBeNull();
    expect(fs.shell!.group.parent).toBe(fs.scene);
    expect([...fs.desks.keys()]).toEqual(desksOf(checkoutFloor()).map((d) => d.sessionId));
    for (const entry of fs.desks.values()) {
      expect(entry.obj.group.parent).toBe(fs.scene);
      expect(entry.robot !== null, entry.desk.state).toBe(entry.desk.state !== 'dormant');
    }
    expect(fs.hemi.parent).toBe(fs.scene);
    expect(fs.sun.parent).toBe(fs.scene);
    expect(fs.sun.castShadow).toBe(true);
  });

  it('keeps unchanged desks, updates a changed one in place, adds the new and drops the gone', () => {
    const fs = sceneOf();
    const before = new Map([...fs.desks].map(([id, e]) => [id, { group: e.obj.group, robot: e.robot }]));
    const gone = fs.desks.get('sw-c3')!;
    const rebuilt = fs.apply(makeFloor(changedIslands()));
    expect(rebuilt).toBe(false);
    expect(fs.desks.get('sw-b2')!.obj.group).toBe(before.get('sw-b2')!.group);
    expect(fs.desks.get('sw-b2')!.robot).toBe(before.get('sw-b2')!.robot);
    const changed = fs.desks.get('sw-a1')!;
    expect(changed.obj.group).toBe(before.get('sw-a1')!.group);
    expect(changed.robot).toBe(before.get('sw-a1')!.robot);
    expect(changed.obj.screen.material).toBe(fs.mats.screen('needs_you'));
    expect(changed.robot!.group.position.x).toBe(robotSpot(changed.desk)!.x);
    expect(changed.robot!.group.rotation.y).toBe(0);
    expect(fs.desks.has('sw-c3')).toBe(false);
    expect(gone.obj.group.parent).toBeNull();
    expect(gone.robot!.group.parent).toBeNull();
    const picks = new Set(fs.pickables());
    expect(gone.obj.pickables.some((m) => picks.has(m))).toBe(false);
    expect(fs.desks.get('sw-x9')!.obj.group.parent).toBe(fs.scene);
    expect(fs.desks.get('sw-x9')!.obj.group.position.x).toBe(deskAnchor(gone.desk.rect).x);
  });

  it('rebuilds the shell only when the layout changes, and frees the old one', () => {
    const fs = sceneOf();
    const shell = fs.shell!;
    expect(fs.apply(checkoutFloor())).toBe(false);
    expect(fs.shell).toBe(shell);
    const slab = shell.group.children.find((c) => c instanceof Mesh && c.material === fs.mats.surface.floor) as Mesh;
    let freed = false;
    slab.geometry.addEventListener('dispose', () => (freed = true));
    const grown = checkoutIslands();
    grown[2]!.desks.push({ id: 'ps-z1', state: 'working' });
    expect(fs.apply(makeFloor(grown))).toBe(true);
    expect(fs.shell).not.toBe(shell);
    expect(shell.group.parent).toBeNull();
    expect(freed).toBe(true);
  });

  it('signs the layout by footprint, core and island rectangles, keys and colours only', () => {
    const a = checkoutFloor();
    const b = makeFloor(changedIslands());
    expect(layoutSignature(b)).toBe(layoutSignature(a));
    const recoloured = checkoutIslands();
    recoloured[0]!.color = 6;
    expect(layoutSignature(makeFloor(recoloured))).not.toBe(layoutSignature(a));
  });

  it('rebuilds a robot for new colours, sends it home when the desk goes dormant, and back again', () => {
    const fs = sceneOf();
    const robot = fs.desks.get('sw-a1')!.robot!;
    const recoloured = checkoutIslands();
    recoloured[0]!.color = 6;
    fs.apply(makeFloor(recoloured));
    const next = fs.desks.get('sw-a1')!.robot!;
    expect(next).not.toBe(robot);
    expect(robot.group.parent).toBeNull();
    expect(next.body).toBe(6);
    const asleep = checkoutIslands();
    asleep[0]!.desks[0]!.state = 'dormant';
    fs.apply(makeFloor(asleep));
    expect(fs.desks.get('sw-a1')!.robot).toBeNull();
    expect(next.group.parent).toBeNull();
    fs.apply(checkoutFloor());
    expect(fs.desks.get('sw-a1')!.robot!.group.parent).toBe(fs.scene);
  });

  it('rings the selected desk under its robot, or its chair when empty, and hides the ring otherwise', () => {
    const fs = sceneOf();
    expect(fs.ring.visible).toBe(false);
    fs.setSelected('oa-c3');
    const desk = fs.desks.get('oa-c3')!.desk;
    expect(fs.ring.visible).toBe(true);
    expect([fs.ring.position.x, fs.ring.position.z]).toEqual([robotSpot(desk)!.x, robotSpot(desk)!.z]);
    fs.setSelected('ps-f7');
    const empty = fs.desks.get('ps-f7')!.desk;
    expect([fs.ring.position.x, fs.ring.position.z]).toEqual([seatSpot(empty.rect).x, seatSpot(empty.rect).z]);
    expect(fs.focusPoint('ps-f7')).toEqual({ x: seatSpot(empty.rect).x, z: seatSpot(empty.rect).z });
    fs.setSelected('nobody');
    expect(fs.ring.visible).toBe(false);
    expect(fs.focusPoint('nobody')).toBeNull();
    fs.setSelected(null);
    expect(fs.ring.visible).toBe(false);
  });

  it('keeps the selection across updates and drops the ring when the desk leaves', () => {
    const fs = sceneOf();
    fs.setSelected('sw-c3');
    fs.apply(checkoutFloor());
    expect(fs.ring.visible).toBe(true);
    fs.apply(makeFloor(changedIslands()));
    expect(fs.ring.visible).toBe(false);
  });

  it('cuts away the walls facing the camera, and keeps doing so after a rebuild', () => {
    const fs = sceneOf();
    const shown = () => Object.fromEntries(fs.shell!.walls.map((w) => [w.side, w.group.visible]));
    expect(shown()).toEqual({ north: true, east: false, south: false, west: true });
    expect(fs.setAzimuth(HOME_AZIMUTH + 0.2)).toBe(false);
    expect(fs.setAzimuth(HOME_AZIMUTH + Math.PI)).toBe(true);
    expect(shown()).toEqual({ north: false, east: true, south: true, west: false });
    const grown = checkoutIslands();
    grown[0]!.desks.push({ id: 'sw-z1', state: 'idle' });
    fs.apply(makeFloor(grown));
    expect(shown()).toEqual({ north: false, east: true, south: true, west: false });
  });

  it('points the sun at the middle of the floor and fits its shadow to the floor', () => {
    const fs = sceneOf();
    const floor = checkoutFloor();
    expect(fs.sun.target.position.toArray()).toEqual([floor.size.w / 2, 0, floor.size.h / 2]);
    expect(fs.sun.shadow.camera.right).toBe(shadowExtent(floor.size));
  });

  it('recolours lights and materials in place on a theme change', () => {
    const fs = sceneOf();
    const floorMat = fs.mats.surface.floor;
    const night = dayTheme();
    night.colors['hemi-sky'] = '#8ea2d8';
    night.colors.sun = '#9db4ff';
    night.colors['scene-floor'] = '#3a3f55';
    night.numbers['hemi-int'] = 0.6;
    night.numbers['sun-int'] = 0.55;
    fs.setTheme(night);
    expect('#' + fs.hemi.color.getHexString()).toBe('#8ea2d8');
    expect('#' + fs.sun.color.getHexString()).toBe('#9db4ff');
    expect([fs.hemi.intensity, fs.sun.intensity]).toEqual([0.6, 0.55]);
    expect(fs.mats.surface.floor).toBe(floorMat);
    expect('#' + floorMat.color.getHexString()).toBe('#3a3f55');
  });

  it('frees every geometry and material it made on dispose', () => {
    const fs = sceneOf();
    const geometries = new Set<BufferGeometry>();
    const materials = new Set<Material>();
    fs.scene.traverse((o) => {
      if (o instanceof Mesh) {
        geometries.add(o.geometry);
        materials.add(o.material as Material);
      }
    });
    const freed = new Set<unknown>();
    for (const x of [...geometries, ...materials]) x.addEventListener('dispose', () => freed.add(x));
    fs.dispose();
    expect(freed.size).toBe(geometries.size + materials.size);
    expect(fs.scene.children).toHaveLength(0);
    expect(fs.desks.size).toBe(0);
  });
});

import { describe, expect, it } from 'vitest';
import { BoxGeometry, Color, Group, Matrix4, Mesh, MeshBasicMaterial, MeshStandardMaterial, type Material } from 'three';
import { Furniture, frameAt } from '../../renderer/furniture';

describe('furniture', () => {
  const box = new BoxGeometry(1, 1, 1);
  const other = new BoxGeometry(2, 1, 1);
  const wood = new MeshStandardMaterial();
  const steel = new MeshStandardMaterial();

  it('draws every piece of one geometry in one material, casting a shadow or not, with one instanced mesh', () => {
    const f = new Furniture();
    const frame = frameAt(0, 0);
    const a = f.add(frame, box, wood, 0, 0, 0);
    const b = f.add(frame, box, wood, 1, 0, 0);
    const c = f.add(frame, box, steel, 2, 0, 0);
    const d = f.add(frame, other, wood, 3, 0, 0);
    const e = f.add(frame, box, wood, 4, 0, 0, { cast: false });
    expect([a.index, b.index, c.index, d.index, e.index]).toEqual([0, 1, 0, 0, 0]);
    expect([a.mesh, f.meshes]).toEqual([null, []]);
    const parent = new Group();
    f.build(parent);
    expect(f.meshes.map((m) => [m.geometry, m.material, m.count, m.castShadow, m.receiveShadow])).toEqual([
      [box, wood, 2, true, true],
      [box, steel, 1, true, true],
      [other, wood, 1, true, true],
      [box, wood, 1, false, true],
    ]);
    expect(f.meshes.every((m) => m.parent === parent)).toBe(true);
    expect([a.mesh, b.mesh, c.mesh, d.mesh, e.mesh]).toEqual([f.meshes[0], f.meshes[0], f.meshes[1], f.meshes[2], f.meshes[3]]);
  });

  it('stands each piece where a mesh at its place in its frame would stand, turned and scaled the same way', () => {
    const f = new Furniture();
    const piece = f.add(frameAt(3, 4, Math.PI), box, wood, 0.5, 0.74, -0.24, { rx: -Math.PI / 2, ry: 0.3, scale: [1.05, 0.55, 1.05] });
    f.build(new Group());
    const group = new Group();
    group.position.set(3, 0, 4);
    group.rotation.y = Math.PI;
    const mesh = new Mesh(box, wood);
    mesh.position.set(0.5, 0.74, -0.24);
    mesh.rotation.x = -Math.PI / 2;
    mesh.rotation.y = 0.3;
    mesh.scale.set(1.05, 0.55, 1.05);
    group.add(mesh);
    group.updateMatrixWorld(true);
    // The same numbers, kept as an instanced mesh keeps them: in 32-bit floats.
    expect(piece.mesh!.getMatrixAt(piece.index, new Matrix4()).elements).toEqual(mesh.matrixWorld.elements.map(Math.fround));
  });

  it('colours a piece over its material, before the mesh is built or after, and leaves the others white', () => {
    const f = new Furniture();
    const frame = frameAt(0, 0);
    const [a, b, c] = [0, 1, 2].map((x) => f.add(frame, box, wood, x, 0, 0));
    const plain = f.add(frame, other, wood, 0, 0, 0);
    a!.paint(new Color(0.5, 0.5, 0.5));
    f.build(new Group());
    const colorOf = (p: typeof a) => p!.mesh!.getColorAt(p!.index, new Color()).toArray();
    expect([colorOf(a), colorOf(b), colorOf(c)]).toEqual([[0.5, 0.5, 0.5], [1, 1, 1], [1, 1, 1]]);
    // A set nobody painted has no colours: its material's alone.
    expect(plain.mesh!.instanceColor).toBeNull();
    const version = a!.mesh!.instanceColor!.version;
    c!.paint(new Color(0.25, 0.5, 1));
    expect([colorOf(a), colorOf(b), colorOf(c)]).toEqual([[0.5, 0.5, 0.5], [1, 1, 1], [0.25, 0.5, 1]]);
    expect(a!.mesh!.instanceColor!.version).toBeGreaterThan(version);
  });

  it('lets each piece pick what it is given, read by instance from its mesh, and nothing until then', () => {
    const f = new Furniture();
    const frame = frameAt(0, 0);
    const a = f.add(frame, box, wood, 0, 0, 0);
    const b = f.add(frame, box, wood, 1, 0, 0);
    a.pick = { kind: 'desk', id: 's1' };
    f.build(new Group());
    b.pick = { kind: 'room', id: 'wf_0000aaaa-001' };
    expect(a.mesh!.userData.picks).toEqual([{ kind: 'desk', id: 's1' }, { kind: 'room', id: 'wf_0000aaaa-001' }]);
    a.pick = undefined;
    expect(a.mesh!.userData.picks).toEqual([undefined, { kind: 'room', id: 'wf_0000aaaa-001' }]);
    expect([a.pick, b.pick]).toEqual([undefined, { kind: 'room', id: 'wf_0000aaaa-001' }]);
  });

  it('frees every instanced mesh it built, and leaves the shared geometries and materials alone', () => {
    const f = new Furniture();
    const frame = frameAt(0, 0);
    const basic = new MeshBasicMaterial();
    f.add(frame, box, wood, 0, 0, 0);
    f.add(frame, other, basic, 0, 0, 0);
    f.build(new Group());
    const freed = new Set<unknown>();
    for (const m of f.meshes) m.addEventListener('dispose', () => freed.add(m));
    for (const g of [box, other]) g.addEventListener('dispose', () => freed.add(g));
    for (const m of [wood, basic] as Material[]) m.addEventListener('dispose', () => freed.add(m));
    f.dispose();
    expect([...freed]).toEqual([...f.meshes]);
  });
});

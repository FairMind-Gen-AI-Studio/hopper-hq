/**
 * The plan's fixed furniture, drawn by instanced meshes (design §7.2). Every piece of one geometry in one material that
 * casts a shadow, or does not, is an instance of one InstancedMesh: all of them cost one draw call, and one more in the
 * shadow map when they cast. Pieces are added while the shell is built, each in its frame (a desk's, a room's, the
 * floor's); build() then makes the meshes, and the pieces never move. A piece's colour, which multiplies its material's,
 * and what a click on it picks can change at any time.
 */
import { Color, Euler, InstancedMesh, Matrix4, Quaternion, Vector3, type BufferGeometry, type Material, type Object3D } from 'three';
import type { Target } from './index';

/** How a piece stands in its frame: turned about x, then about y, and scaled; and whether it casts a shadow (default true). */
export interface PieceOptions {
  rx?: number;
  ry?: number;
  scale?: readonly [number, number, number];
  cast?: boolean;
}

/** The pieces of one geometry in one material that cast a shadow, or do not: one instanced mesh draws them. */
interface PieceSet {
  readonly geometry: BufferGeometry;
  readonly material: Material;
  readonly cast: boolean;
  /** Where each piece stands on the floor, by piece. */
  readonly matrices: Matrix4[];
  /** What a click on each piece selects, by piece: the mesh's `userData.picks` once it is built. */
  readonly picks: Array<Target | undefined>;
  /** The colours pieces were given before the mesh was built, by piece. */
  readonly colors: Map<number, Color>;
  mesh: InstancedMesh | null;
}

/** One piece of furniture: an instance of the instanced mesh that draws its set. */
export class Piece {
  constructor(
    private readonly set: PieceSet,
    readonly index: number,
  ) {}

  /** The instanced mesh that draws it and the rest of its set; null until the furniture is built. */
  get mesh(): InstancedMesh | null {
    return this.set.mesh;
  }

  /** What a click on it selects; undefined: nothing, and a click goes through it to what lies behind. */
  get pick(): Target | undefined {
    return this.set.picks[this.index];
  }

  set pick(target: Target | undefined) {
    this.set.picks[this.index] = target;
  }

  /** Colours it: its material's colour times this one. White leaves the material's colour as it is. */
  paint(color: Color): void {
    const mesh = this.set.mesh;
    if (!mesh) {
      this.set.colors.set(this.index, color.clone());
      return;
    }
    mesh.setColorAt(this.index, color);
    mesh.instanceColor!.needsUpdate = true;
  }
}

/** The frame of a piece of furniture that stands at (x, 0, z) on the floor, turned by `ry` about the vertical. */
export function frameAt(x: number, z: number, ry = 0): Matrix4 {
  return new Matrix4().compose(new Vector3(x, 0, z), new Quaternion().setFromEuler(new Euler(0, ry, 0)), new Vector3(1, 1, 1));
}

export class Furniture {
  private readonly sets: PieceSet[] = [];
  private readonly built: InstancedMesh[] = [];

  /** Adds a piece: `geometry` in `material`, at (x, y, z) in `frame`. */
  add(frame: Matrix4, geometry: BufferGeometry, material: Material, x: number, y: number, z: number, opts: PieceOptions = {}): Piece {
    const cast = opts.cast !== false;
    let set = this.sets.find((s) => s.geometry === geometry && s.material === material && s.cast === cast);
    if (!set) {
      set = { geometry, material, cast, matrices: [], picks: [], colors: new Map(), mesh: null };
      this.sets.push(set);
    }
    const turn = new Quaternion().setFromEuler(new Euler(opts.rx ?? 0, opts.ry ?? 0, 0));
    const scale = opts.scale ? new Vector3(...opts.scale) : new Vector3(1, 1, 1);
    set.matrices.push(frame.clone().multiply(new Matrix4().compose(new Vector3(x, y, z), turn, scale)));
    set.picks.push(undefined);
    return new Piece(set, set.matrices.length - 1);
  }

  /** The instanced meshes, one per set of pieces, in the order their sets' first pieces came; none until built. */
  get meshes(): readonly InstancedMesh[] {
    return this.built;
  }

  /**
   * Makes the instanced meshes and adds them to `parent`, which stands where the floor does. Every one receives shadows,
   * and casts them when its pieces do. Call it once, when every piece is in.
   */
  build(parent: Object3D): void {
    for (const set of this.sets) {
      const mesh = new InstancedMesh(set.geometry, set.material, set.matrices.length);
      set.matrices.forEach((m, i) => mesh.setMatrixAt(i, m));
      for (const [i, color] of set.colors) mesh.setColorAt(i, color);
      set.colors.clear();
      mesh.castShadow = set.cast;
      mesh.receiveShadow = true;
      mesh.userData.picks = set.picks;
      set.mesh = mesh;
      parent.add(mesh);
      this.built.push(mesh);
    }
  }

  /** Frees what the instanced meshes hold on the GPU. Their geometries and materials are shared, and stay. */
  dispose(): void {
    for (const mesh of this.built) mesh.dispose();
  }
}

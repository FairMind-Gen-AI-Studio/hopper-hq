/**
 * The open floor as a three.js scene, kept in step with each FloorDetail the server sends. Desks and robots are
 * matched by sessionId and updated in place; the shell is rebuilt only when the layout changes. The scene owns its
 * geometries and materials and frees them all in dispose().
 */
import { DirectionalLight, HemisphereLight, Mesh, Scene, type Object3D } from 'three';
import type { Desk, FloorDetail } from '../../src/scene/types';
import { Materials } from './materials';
import { Geometries, buildDesk, buildShell, updateDesk, type DeskObject, type Shell } from './props';
import { buildRobot, poseRobot, type RobotObject } from './robot';
import type { ThemeTokens } from './theme';
import { HOME_AZIMUTH, floorCenter, robotSpot, seatSpot, shadowExtent, visibleWalls, type Point } from './world';

/** What the shell depends on: the footprint, the core, and each island's key, colour and rectangle. */
export function layoutSignature(floor: Pick<FloorDetail, 'size' | 'core' | 'islands'>): string {
  return JSON.stringify([floor.size, floor.core, floor.islands.map((i) => [i.key, i.color, i.rect])]);
}

export interface DeskEntry {
  desk: Desk;
  readonly obj: DeskObject;
  robot: RobotObject | null;
}

export class FloorScene {
  readonly scene = new Scene();
  readonly geo = new Geometries();
  readonly mats: Materials;
  readonly hemi = new HemisphereLight();
  readonly sun = new DirectionalLight();
  /** The selection ring on the floor under the selected desk's robot. */
  readonly ring: Mesh;
  private shellPart: Shell | null = null;
  private signature = '';
  private readonly entries = new Map<string, DeskEntry>();
  private selected: string | null = null;
  private azimuth = HOME_AZIMUTH;

  constructor(theme: ThemeTokens) {
    this.mats = new Materials(theme);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.02;
    this.scene.add(this.hemi, this.sun, this.sun.target);
    this.ring = new Mesh(this.geo.ring(0.42, 0.52), this.mats.ring);
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.visible = false;
    this.ring.name = 'selection';
    this.scene.add(this.ring);
    this.setTheme(theme);
  }

  get shell(): Shell | null {
    return this.shellPart;
  }

  get desks(): ReadonlyMap<string, DeskEntry> {
    return this.entries;
  }

  /** Brings the scene in step with the floor. Returns true when the shell was rebuilt. */
  apply(floor: FloorDetail): boolean {
    const signature = layoutSignature(floor);
    const rebuild = signature !== this.signature;
    if (rebuild) {
      this.shellPart?.dispose();
      this.shellPart = buildShell(floor, this.geo, this.mats);
      this.scene.add(this.shellPart.group);
      this.signature = signature;
      this.fitSun(floor.size);
      this.setAzimuth(this.azimuth);
    }
    const seen = new Set<string>();
    for (const island of floor.islands) {
      for (const desk of island.desks) {
        seen.add(desk.sessionId);
        const entry = this.entries.get(desk.sessionId);
        if (entry) this.update(entry, desk);
        else this.add(desk);
      }
    }
    for (const [id, entry] of this.entries) if (!seen.has(id)) this.remove(id, entry);
    this.placeRing();
    return rebuild;
  }

  setTheme(theme: ThemeTokens): void {
    this.mats.applyTheme(theme);
    this.hemi.color.set(theme.colors['hemi-sky']);
    this.hemi.groundColor.set(theme.colors['hemi-ground']);
    this.hemi.intensity = theme.numbers['hemi-int'];
    this.sun.color.set(theme.colors.sun);
    this.sun.intensity = theme.numbers['sun-int'];
  }

  /** Shows the ring under a desk; null, or a desk not on this floor, hides it. */
  setSelected(sessionId: string | null): void {
    this.selected = sessionId;
    this.placeRing();
  }

  /** Cuts away the walls that face a camera at this azimuth. */
  setAzimuth(azimuth: number): void {
    this.azimuth = azimuth;
    const shown = visibleWalls(azimuth);
    for (const wall of this.shellPart?.walls ?? []) wall.group.visible = shown[wall.side];
  }

  /** Where the camera looks when it pans to a desk: its robot, or the chair of an empty desk. */
  focusPoint(sessionId: string): Point | null {
    const entry = this.entries.get(sessionId);
    if (!entry) return null;
    const spot = robotSpot(entry.desk) ?? seatSpot(entry.desk.rect);
    return { x: spot.x, z: spot.z };
  }

  /** Everything a click can pick: desks and robots. */
  pickables(): Object3D[] {
    const out: Object3D[] = [];
    for (const e of this.entries.values()) out.push(...e.obj.pickables, ...(e.robot?.pickables ?? []));
    return out;
  }

  dispose(): void {
    this.shellPart?.dispose();
    this.shellPart = null;
    for (const [id, entry] of this.entries) this.remove(id, entry);
    this.sun.dispose();
    this.hemi.dispose();
    this.scene.clear();
    this.geo.dispose();
    this.mats.dispose();
  }

  private add(desk: Desk): void {
    const obj = buildDesk(desk, this.geo, this.mats);
    this.scene.add(obj.group);
    const entry: DeskEntry = { desk, obj, robot: null };
    this.entries.set(desk.sessionId, entry);
    this.syncRobot(entry);
  }

  private update(entry: DeskEntry, desk: Desk): void {
    entry.desk = desk;
    updateDesk(entry.obj, desk, this.mats);
    this.syncRobot(entry);
  }

  private remove(id: string, entry: DeskEntry): void {
    entry.obj.group.removeFromParent();
    entry.robot?.group.removeFromParent();
    this.entries.delete(id);
  }

  /** Builds, rebuilds (new colours), poses or removes the desk's robot. Geometries and materials are shared. */
  private syncRobot(entry: DeskEntry): void {
    const want = entry.desk.robot;
    let robot = entry.robot;
    if (robot && (!want || want.body !== robot.body || want.tie !== robot.tie)) {
      robot.group.removeFromParent();
      robot = null;
    }
    if (want && !robot) {
      robot = buildRobot(entry.desk.sessionId, want, this.geo, this.mats);
      this.scene.add(robot.group);
    }
    if (want && robot) poseRobot(robot, want, robotSpot(entry.desk)!);
    entry.robot = robot;
  }

  private placeRing(): void {
    const at = this.selected === null ? null : this.focusPoint(this.selected);
    this.ring.visible = at !== null;
    if (at) this.ring.position.set(at.x, 0.02, at.z);
  }

  private fitSun(size: { w: number; h: number }): void {
    const c = floorCenter(size);
    const e = shadowExtent(size);
    this.sun.position.set(c.x + 9, 20, c.z + 7);
    this.sun.target.position.set(c.x, 0, c.z);
    Object.assign(this.sun.shadow.camera, { left: -e, right: e, top: e, bottom: -e, near: 1, far: 24 + 3 * e });
    this.sun.shadow.camera.updateProjectionMatrix();
  }
}

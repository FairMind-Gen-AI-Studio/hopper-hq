/**
 * The open floor as a three.js scene, kept in step with each FloorDetail the server sends. Desks and robots are
 * matched by sessionId and updated in place, and meeting rooms by host and run; the shell is rebuilt only when the
 * layout changes. The scene owns its geometries and materials and frees them all in dispose().
 */
import { DirectionalLight, HemisphereLight, Mesh, Scene, type Object3D } from 'three';
import { SEATS_MAX } from '../../src/scene/layout';
import type { Desk, FloorDetail, MeetingRoom, Robot } from '../../src/scene/types';
import { Materials } from './materials';
import { Geometries, buildDesk, buildRoom, buildShell, updateDesk, updateRoom, type DeskObject, type RoomObject, type Shell } from './props';
import { buildRobot, poseRobot, type RobotObject } from './robot';
import type { ThemeTokens } from './theme';
import {
  HOME_AZIMUTH,
  floorCenter,
  headSpot,
  internSpots,
  robotSpot,
  roomKey,
  seatSpot,
  seatSpots,
  shadowExtent,
  visibleWalls,
  type Point,
  type Spot,
} from './world';

/** What the shell depends on: the footprint, the core, each island's key, colour and rectangle, and each room's rectangle. */
export function layoutSignature(floor: Pick<FloorDetail, 'size' | 'core' | 'islands' | 'rooms'>): string {
  return JSON.stringify([floor.size, floor.core, floor.islands.map((i) => [i.key, i.color, i.rect]), floor.rooms.map((r) => r.rect)]);
}

export interface DeskEntry {
  desk: Desk;
  readonly obj: DeskObject;
  robot: RobotObject | null;
  /** The robots of its running interns, by agent id, in the order of their places. */
  readonly interns: Map<string, RobotObject>;
}

export interface RoomEntry {
  room: MeetingRoom;
  obj: RoomObject;
  /** The robots of the agents at the table, by agent id, in seat order. */
  readonly agents: Map<string, RobotObject>;
  /** The host's robot at the head of the table. */
  host: RobotObject | null;
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
  /** By roomKey: two hosts may name the same run. */
  private readonly roomEntries = new Map<string, RoomEntry>();
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

  get rooms(): ReadonlyMap<string, RoomEntry> {
    return this.roomEntries;
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
    const rooms = new Set<string>();
    for (const room of floor.rooms) {
      const key = roomKey(room);
      rooms.add(key);
      const entry = this.roomEntries.get(key);
      if (entry) this.syncRoom(entry, room);
      else this.addRoom(key, room);
    }
    for (const [key, entry] of this.roomEntries) if (!rooms.has(key)) this.removeRoom(key, entry);
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

  /** Cuts away the walls that face a camera at this azimuth. Returns true when a wall came or went. */
  setAzimuth(azimuth: number): boolean {
    this.azimuth = azimuth;
    const shown = visibleWalls(azimuth);
    let changed = false;
    for (const wall of this.shellPart?.walls ?? []) {
      if (wall.group.visible === shown[wall.side]) continue;
      wall.group.visible = shown[wall.side];
      changed = true;
    }
    return changed;
  }

  /** Where the camera looks when it pans to a desk: its robot, or the chair of an empty desk. */
  focusPoint(sessionId: string): Point | null {
    const entry = this.entries.get(sessionId);
    if (!entry) return null;
    const spot = robotSpot(entry.desk) ?? seatSpot(entry.desk.rect);
    return { x: spot.x, z: spot.z };
  }

  /** Everything a click can pick: desks, their robots and their interns. */
  pickables(): Object3D[] {
    const out: Object3D[] = [];
    for (const e of this.entries.values()) {
      out.push(...e.obj.pickables, ...(e.robot?.pickables ?? []));
      for (const intern of e.interns.values()) out.push(...intern.pickables);
    }
    return out;
  }

  dispose(): void {
    this.shellPart?.dispose();
    this.shellPart = null;
    for (const [id, entry] of this.entries) this.remove(id, entry);
    for (const [key, entry] of this.roomEntries) this.removeRoom(key, entry);
    this.sun.dispose();
    this.hemi.dispose();
    this.scene.clear();
    this.geo.dispose();
    this.mats.dispose();
  }

  private add(desk: Desk): void {
    const obj = buildDesk(desk, this.geo, this.mats);
    this.scene.add(obj.group);
    const entry: DeskEntry = { desk, obj, robot: null, interns: new Map() };
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
    for (const intern of entry.interns.values()) intern.group.removeFromParent();
    this.entries.delete(id);
  }

  /**
   * Builds, rebuilds (new colours), poses or removes the desk's robot, and its interns. A robot whose session sits at
   * the head of a meeting room stays, hidden: its chair is empty. Geometries and materials are shared.
   */
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
    if (want && robot) {
      poseRobot(robot, want, robotSpot(entry.desk)!);
      robot.group.visible = !entry.desk.away;
    }
    entry.robot = robot;
    this.syncInterns(entry);
  }

  /**
   * Flies the desk's running interns in its arc, in the colours of its robot. A click on one picks the desk. A dormant
   * desk has no robot, and its session, gone, runs no interns.
   */
  private syncInterns(entry: DeskEntry): void {
    const { desk } = entry;
    const spots = internSpots(desk.rect);
    const flying = desk.robot ? desk.interns.filter((i) => i.running).slice(0, spots.length) : [];
    const look: Robot = { pose: 'still', badge: null, body: desk.robot?.body ?? 0, tie: desk.robot?.tie ?? null };
    this.syncCrew(entry.interns, flying.map((i, k) => [i.agentId, spots[k]!]), look, (id) => {
      const robot = buildRobot(desk.sessionId, look, this.geo, this.mats, 'intern');
      robot.group.name = `intern ${id}`;
      this.scene.add(robot.group);
      return robot;
    });
  }

  private addRoom(key: string, room: MeetingRoom): void {
    const obj = buildRoom(room, this.geo, this.mats);
    this.scene.add(obj.group);
    const entry: RoomEntry = { room, obj, agents: new Map(), host: null };
    this.roomEntries.set(key, entry);
    this.syncRoomRobots(entry);
  }

  /** Moves the room to its cells; a room of another size is built again, with its robots. */
  private syncRoom(entry: RoomEntry, room: MeetingRoom): void {
    entry.room = room;
    if (entry.obj.w !== room.rect.w || entry.obj.h !== room.rect.h) {
      entry.obj.group.removeFromParent();
      entry.obj = buildRoom(room, this.geo, this.mats);
      this.scene.add(entry.obj.group);
      entry.agents.clear();
      entry.host = null;
    } else updateRoom(entry.obj, room);
    this.syncRoomRobots(entry);
  }

  private removeRoom(key: string, entry: RoomEntry): void {
    entry.obj.group.removeFromParent();
    this.roomEntries.delete(key);
  }

  /**
   * Seats the first min(SEATS_MAX, running) agents in seat order, as workflow robots in the room's colours, and the
   * host at the head while it is in the meeting. Robots stand in the room's group, so they move with it; one that
   * keeps its seat or moves to another is the same robot, and new colours build them again.
   */
  private syncRoomRobots(entry: RoomEntry): void {
    const { room, obj } = entry;
    const local = { x: 0, y: 0, w: room.rect.w, h: room.rect.h };
    const seats = seatSpots(local);
    const seated = room.agents.slice(0, Math.min(SEATS_MAX, room.counts.running));
    const look: Robot = { pose: 'typing', badge: null, body: room.look.body, tie: room.look.tie };
    this.syncCrew(entry.agents, seated.map((a, i) => [a.agentId, seats[i]!]), look, (id) => {
      const robot = buildRobot(id, look, this.geo, this.mats, 'workflow');
      robot.group.name = `agent ${id}`;
      obj.group.add(robot.group);
      return robot;
    });
    const want = room.host;
    let host = entry.host;
    if (host && (!want || want.body !== host.body || want.tie !== host.tie)) {
      host.group.removeFromParent();
      host = null;
    }
    if (want && !host) {
      host = buildRobot(room.hostSessionId, want, this.geo, this.mats);
      host.group.name = `host ${room.runId}`;
      obj.group.add(host.group);
    }
    if (want && host) poseRobot(host, want, headSpot(local));
    entry.host = host;
  }

  /**
   * Brings a crew of robots in step with the places it is given, one robot per id, in `look`'s colours. A robot whose
   * id stays keeps its object and moves to its new place; new colours build it again with `make`; the rest leave.
   */
  private syncCrew(crew: Map<string, RobotObject>, places: Array<[id: string, spot: Spot]>, look: Robot, make: (id: string) => RobotObject): void {
    const before = new Map(crew);
    crew.clear();
    for (const [id, spot] of places) {
      let robot = before.get(id);
      before.delete(id);
      if (robot && (robot.body !== look.body || robot.tie !== look.tie)) {
        robot.group.removeFromParent();
        robot = undefined;
      }
      robot ??= make(id);
      poseRobot(robot, look, spot);
      crew.set(id, robot);
    }
    for (const robot of before.values()) robot.group.removeFromParent();
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

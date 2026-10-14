/**
 * The open floor as a three.js scene, kept in step with each FloorDetail the server sends. The shell holds the plan's
 * furniture (every desk, the lounge, every room) and is rebuilt only when the plan grows; who sits where, rug colours
 * and which rooms are open are updated in place. Each session on the floor has one robot, matched by sessionId, in floor
 * coordinates, that goes wherever its occupant is: to its desk, to the lounge or to the head of a room.
 *
 * Given the time of an update, robots walk (walkers.ts): one whose place changed goes there from where it is, a new one
 * comes out of the elevator, and one whose session goes walks to the elevator and leaves. frame() moves them on.
 * Without the time, every robot is put in its place at once. Room agents are matched by run and agent id. The scene owns
 * its geometries and materials and frees them all in dispose().
 */
import { DirectionalLight, Group, HemisphereLight, Mesh, Scene, type Object3D } from 'three';
import { SEATS_MAX } from '../../src/scene/layout';
import type { FloorDetail, GridRect, MeetingRoom, Occupant, PodDesk, Robot } from '../../src/scene/types';
import type { Target } from './index';
import { Materials } from './materials';
import { WALK_SPEED, tripEnd } from './motion';
import { Geometries, buildShell, updateDesk, updatePod, updateRoom, type PickData, type Shell } from './props';
import { buildRobot, poseRobot, strideRobot, type RobotKind, type RobotObject } from './robot';
import type { ThemeTokens } from './theme';
import { walkGrid } from './walk';
import { advance, moveAll, settled, walkerAt, type Walker, type Wanted, type Ways } from './walkers';
import {
  HOME_AZIMUTH,
  elevatorSpot,
  floorCenter,
  internSpots,
  isStanding,
  placeSpot,
  roomKey,
  seatSpot,
  seatSpots,
  shadowExtent,
  tableCenter,
  visibleWalls,
  type Point,
  type Spot,
} from './world';

/** What the shell depends on: the footprint, the core, each pod's id and rug, the lounge and every room slot. */
export function layoutSignature(floor: Pick<FloorDetail, 'size' | 'core' | 'pods' | 'lounge' | 'roomSlots'>): string {
  return JSON.stringify([floor.size, floor.core, floor.pods.map((p) => [p.id, p.rect]), floor.lounge.rect, floor.roomSlots]);
}

export interface SessionEntry {
  occupant: Occupant;
  /** Its desk; null while it waits for one. */
  desk: PodDesk | null;
  /** Its robot while it is on the floor: none when its occupant is gone, or while it walks out to leave. */
  robot: RobotObject | null;
  /** The robots of its running interns, by agent id, in the order of their places over its desk. */
  readonly interns: Map<string, RobotObject>;
}

export interface RoomEntry {
  room: MeetingRoom;
  /** The robots of the agents at the table, by agent id, in seat order. */
  readonly agents: Map<string, RobotObject>;
}

/** What one frame did: whether any robot is still under way. */
export interface FrameStep {
  moving: boolean;
}

/** A robot the floor wants: its walker's place, and what it is built as. */
interface Cast extends Wanted {
  kind: RobotKind;
  /** The id it is built with: the session it belongs to. */
  owner: string;
  look: Robot;
}

/** A robot on the floor, leaving ones too, and the pose it takes at its place. */
interface Mover {
  robot: RobotObject;
  look: Pick<Robot, 'pose' | 'badge'>;
}

/** A session's robot, by the key its walker goes by. */
const sessionKey = (sessionId: string) => JSON.stringify(['session', sessionId]);

export class FloorScene {
  readonly scene = new Scene();
  readonly geo = new Geometries();
  readonly mats: Materials;
  readonly hemi = new HemisphereLight();
  readonly sun = new DirectionalLight();
  /** The selection ring on the floor under the selected session's robot. */
  readonly ring: Mesh;
  /** The outline on the floor of the selected room, just inside its edges. */
  readonly roomRing = new Group();
  private shellPart: Shell | null = null;
  private signature = '';
  private floor: FloorDetail | null = null;
  /** The walk grid and the elevator of the plan. */
  private ways: Ways | null = null;
  /** Where each robot is going, by robot key: those the floor wants, then those leaving. */
  private walkers = new Map<string, Walker>();
  /** Each robot by the same key. */
  private readonly movers = new Map<string, Mover>();
  /** The floor's sessions by id: those at a desk and those waiting for one. */
  private readonly entries = new Map<string, SessionEntry>();
  /** By roomKey. */
  private readonly roomEntries = new Map<string, RoomEntry>();
  /** The rooms' keys in the floor's order: a run's first room is the first of these that is its. */
  private roomOrder: string[] = [];
  private selected: Target | null = null;
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
    for (let i = 0; i < 4; i++) {
      const strip = new Mesh(this.geo.plane(1, 1), this.mats.ring);
      strip.rotation.x = -Math.PI / 2;
      this.roomRing.add(strip);
    }
    this.roomRing.visible = false;
    this.roomRing.name = 'room-selection';
    this.scene.add(this.roomRing);
    this.setTheme(theme);
  }

  get shell(): Shell | null {
    return this.shellPart;
  }

  get sessions(): ReadonlyMap<string, SessionEntry> {
    return this.entries;
  }

  get rooms(): ReadonlyMap<string, RoomEntry> {
    return this.roomEntries;
  }

  /**
   * Brings the scene in step with the floor. With `now`, robots walk from there on to their new places; without it,
   * each is put in its place at once (first sight, reduced motion). Returns true when the shell was rebuilt.
   */
  apply(floor: FloorDetail, now?: number): boolean {
    this.floor = floor;
    const signature = layoutSignature(floor);
    const rebuild = signature !== this.signature;
    if (rebuild) {
      this.shellPart?.dispose();
      this.shellPart = buildShell(floor, this.geo, this.mats);
      this.scene.add(this.shellPart.group);
      this.signature = signature;
      this.fitSun(floor.size);
      this.setAzimuth(this.azimuth);
      this.ways = { grid: walkGrid(floor), elevator: elevatorSpot(floor.core) };
    }
    const shell = this.shellPart!;
    const seen = new Set<string>();
    const wanted: Cast[] = [];
    for (const pod of floor.pods) {
      const look = shell.pods.get(pod.id);
      if (look) updatePod(look, pod.color, this.mats);
      for (const desk of pod.desks) {
        const obj = shell.desks.get(desk.id);
        if (obj) updateDesk(obj, desk.occupant, this.mats);
        if (desk.occupant && !seen.has(desk.occupant.sessionId)) {
          seen.add(desk.occupant.sessionId);
          this.track(desk.occupant, desk, wanted);
        }
      }
    }
    for (const occupant of floor.unseated) {
      if (seen.has(occupant.sessionId)) continue;
      seen.add(occupant.sessionId);
      this.track(occupant, null, wanted);
    }
    for (const [id, entry] of this.entries) if (!seen.has(id)) this.remove(id, entry);
    this.walkers = moveAll(this.walkers, wanted, this.ways!, now ?? 0, { snap: now === undefined, regrid: rebuild }).walkers;
    this.cast(wanted, now ?? 0);
    for (const entry of this.entries.values()) {
      entry.robot = this.walkers.get(sessionKey(entry.occupant.sessionId))?.leaving === false ? this.movers.get(sessionKey(entry.occupant.sessionId))!.robot : null;
      this.syncInterns(entry);
    }

    const rooms = new Set<string>();
    this.roomOrder = floor.rooms.map(roomKey);
    const open = new Map<number, MeetingRoom>();
    for (const room of floor.rooms) {
      const key = roomKey(room);
      rooms.add(key);
      if (!open.has(room.slot)) open.set(room.slot, room);
      let entry = this.roomEntries.get(key);
      if (!entry) {
        entry = { room, agents: new Map() };
        this.roomEntries.set(key, entry);
      }
      entry.room = room;
      this.syncAgents(entry);
    }
    for (const [key, entry] of this.roomEntries) if (!rooms.has(key)) this.removeRoom(key, entry);
    const heads = new Set([...this.entries.values()].flatMap((e) => (e.robot && e.occupant.at.kind === 'room' ? [e.occupant.at.slot] : [])));
    for (const obj of shell.rooms) updateRoom(obj, open.get(obj.slot) ?? null, heads.has(obj.slot), this.mats);
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

  /** Shows the ring under a session's robot, or the outline of a room; null, or what is not on this floor, hides them. */
  setSelected(target: Target | null): void {
    this.selected = target;
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

  /**
   * Moves every robot on to `now`: along its trip, or at its place once it is there; one that has walked out of the
   * elevator goes. Every robot takes its part of the frame, at rest too.
   */
  frame(now: number): FrameStep {
    let moving = false;
    for (const [key, w] of this.walkers) {
      const mover = this.movers.get(key)!;
      const next = advance(w, now);
      if (next === null) {
        this.walkers.delete(key);
        this.drop(key, mover);
        continue;
      }
      if (next !== w) this.walkers.set(key, next);
      this.place(mover, next, now);
      if (next.trip) moving = true;
    }
    this.placeRing();
    return { moving };
  }

  /** Puts every robot at its place at once: those under way are there, and those leaving are gone. Returns whether any robot moved. */
  settle(): boolean {
    let moved = false;
    for (const [key, w] of this.walkers) {
      if (!w.trip) continue;
      moved = true;
      const mover = this.movers.get(key)!;
      const next = settled(w);
      if (next === null) {
        this.walkers.delete(key);
        this.drop(key, mover);
        continue;
      }
      this.walkers.set(key, next);
      this.place(mover, next, 0);
    }
    this.placeRing();
    return moved;
  }

  /**
   * Where the camera looks when it pans to a session or a room: the place the session's robot is at or going to, or the
   * chair of its desk when its robot has gone; the table of the run's first room. Null when it is not on this floor, or
   * waits for a desk.
   */
  focusPoint(target: Target): Point | null {
    if (target.kind === 'room') {
      const room = this.roomOf(target.id);
      return room ? tableCenter(room.room.rect) : null;
    }
    const entry = this.entries.get(target.id);
    if (!entry) return null;
    const spot = entry.robot ? this.walkers.get(sessionKey(target.id))!.to : entry.desk ? seatSpot(entry.desk) : null;
    return spot ? { x: spot.x, z: spot.z } : null;
  }

  /** Everything a click can pick: the desks somebody sits at, the robots and interns, and the open rooms with their agents. */
  pickables(): Object3D[] {
    const out: Object3D[] = [];
    for (const e of this.entries.values()) {
      if (e.desk) out.push(...(this.shellPart?.desks.get(e.desk.id)?.pickables ?? []));
      out.push(...(e.robot?.pickables ?? []));
      for (const intern of e.interns.values()) out.push(...intern.pickables);
    }
    const open = new Set(this.floor?.rooms.map((r) => r.slot) ?? []);
    for (const obj of this.shellPart?.rooms ?? []) if (open.has(obj.slot)) out.push(...obj.pickables);
    for (const r of this.roomEntries.values()) for (const agent of r.agents.values()) out.push(...agent.pickables);
    return out;
  }

  dispose(): void {
    this.shellPart?.dispose();
    this.shellPart = null;
    for (const [id, entry] of this.entries) this.remove(id, entry);
    for (const [key, entry] of this.roomEntries) this.removeRoom(key, entry);
    for (const [key, mover] of this.movers) this.drop(key, mover);
    this.walkers.clear();
    this.sun.dispose();
    this.hemi.dispose();
    this.scene.clear();
    this.geo.dispose();
    this.mats.dispose();
  }

  /**
   * Keeps the session's entry, and asks for its robot at its occupant's place, resting in the lounge. A session that is
   * gone, or waits for a desk, has none.
   */
  private track(occupant: Occupant, desk: PodDesk | null, wanted: Cast[]): void {
    let entry = this.entries.get(occupant.sessionId);
    if (!entry) {
      entry = { occupant, desk, robot: null, interns: new Map() };
      this.entries.set(occupant.sessionId, entry);
    }
    entry.occupant = occupant;
    entry.desk = desk;
    const spot = this.floor ? placeSpot(this.floor, desk, occupant) : null;
    const robot = occupant.robot;
    if (!spot || !robot) return;
    const at = occupant.at;
    const place =
      at.kind === 'lounge' ? `lounge ${at.seat}` : at.kind === 'room' ? `room ${at.slot}` : `desk ${desk!.id} ${isStanding(robot.pose) ? 'stand' : 'seat'}`;
    const look = at.kind === 'lounge' ? { ...robot, pose: 'resting' as const } : robot;
    const near = at.kind === 'desk' ? `desk ${desk!.id}` : undefined;
    wanted.push({ id: sessionKey(occupant.sessionId), gait: 'walk', place, near, to: spot, kind: 'session', owner: occupant.sessionId, look });
  }

  /**
   * Builds the robot of each cast that has none, or new colours, and gives it its pose; lets go of every robot no walker
   * keeps; then places each robot as it is at `now`. Geometries and materials are shared.
   */
  private cast(wanted: Cast[], now: number): void {
    for (const c of wanted) {
      let mover = this.movers.get(c.id);
      if (mover && (mover.robot.body !== c.look.body || mover.robot.tie !== c.look.tie)) {
        this.drop(c.id, mover);
        mover = undefined;
      }
      if (!mover) {
        const robot = buildRobot(c.owner, c.look, this.geo, this.mats, c.kind);
        this.scene.add(robot.group);
        mover = { robot, look: c.look };
        this.movers.set(c.id, mover);
      }
      mover.look = { pose: c.look.pose, badge: c.look.badge };
    }
    for (const [key, mover] of this.movers) if (!this.walkers.has(key)) this.drop(key, mover);
    for (const [key, mover] of this.movers) this.place(mover, this.walkers.get(key)!, now);
  }

  /**
   * Puts a robot where its walker is at `now`: striding along its trip, its legs keeping pace with its speed, inside the
   * elevator out of sight until it sets off, or in its pose at its place. One that waits to set off from where it stands
   * stays as it is.
   */
  private place(mover: Mover, w: Walker, now: number): void {
    const at = walkerAt(w, now);
    mover.robot.group.visible = at.shown;
    if (w.trip && (at.walking || !at.shown)) strideRobot(mover.robot, at, ((Math.max(0, now - w.trip.start) / 1000) * w.trip.speed) / WALK_SPEED);
    else if (!w.trip || now >= tripEnd(w.trip)) poseRobot(mover.robot, mover.look, w.to);
  }

  private drop(key: string, mover: Mover): void {
    mover.robot.group.removeFromParent();
    this.movers.delete(key);
  }

  /** Forgets a session no longer on the floor: its interns go with it, and its robot walks out (cast). */
  private remove(id: string, entry: SessionEntry): void {
    for (const intern of entry.interns.values()) intern.group.removeFromParent();
    this.entries.delete(id);
  }

  /**
   * Flies the session's running interns over its desk, in the colours of its robot. A click on one picks the session. A
   * session with no robot (dormant), or no desk, flies none.
   */
  private syncInterns(entry: SessionEntry): void {
    const { occupant, desk } = entry;
    const spots = desk ? internSpots(desk) : [];
    const flying = occupant.robot ? occupant.interns.filter((i) => i.running).slice(0, spots.length) : [];
    const look: Robot = { pose: 'still', badge: null, body: occupant.robot?.body ?? 0, tie: occupant.robot?.tie ?? null };
    this.syncCrew(entry.interns, flying.map((i, k) => [i.agentId, spots[k]!]), look, (id) => {
      const robot = buildRobot(occupant.sessionId, look, this.geo, this.mats, 'intern');
      robot.group.name = `intern ${id}`;
      this.scene.add(robot.group);
      return robot;
    });
  }

  private removeRoom(key: string, entry: RoomEntry): void {
    for (const agent of entry.agents.values()) agent.group.removeFromParent();
    this.roomEntries.delete(key);
  }

  /**
   * Seats the first min(SEATS_MAX, running) agents of the room in seat order, as workflow robots in the room's colours,
   * in floor coordinates. One that keeps its seat or moves to another is the same robot; new colours build it again.
   */
  private syncAgents(entry: RoomEntry): void {
    const { room } = entry;
    const seats = seatSpots(room.rect);
    const seated = room.agents.slice(0, Math.min(SEATS_MAX, room.counts.running));
    const look: Robot = { pose: 'typing', badge: null, body: room.look.body, tie: room.look.tie };
    this.syncCrew(entry.agents, seated.map((a, i) => [a.agentId, seats[i]!]), look, (id) => {
      const robot = pickRoom(buildRobot(id, look, this.geo, this.mats, 'workflow'), room.runId);
      robot.group.name = `agent ${id}`;
      this.scene.add(robot.group);
      return robot;
    });
  }

  /**
   * Brings a crew of robots in step with the places it is given, one robot per id, in `look`'s colours. A robot whose
   * id stays keeps its object and moves to its new place; new colours build it again with `make`; the rest leave. An id
   * given twice gets the first place only: each robot is one the crew keeps track of.
   */
  private syncCrew(crew: Map<string, RobotObject>, places: Array<[id: string, spot: Spot]>, look: Robot, make: (id: string) => RobotObject): void {
    const before = new Map(crew);
    crew.clear();
    for (const [id, spot] of places) {
      if (crew.has(id)) continue;
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

  /** The first room of a run, in the floor's order, as the labels mark it. */
  private roomOf(runId: string): RoomEntry | undefined {
    for (const key of this.roomOrder) {
      const entry = this.roomEntries.get(key);
      if (entry?.room.runId === runId) return entry;
    }
    return undefined;
  }

  /** Where a session's robot is now, or the chair of its desk when its robot has gone; null when it is not on this floor, or waits for a desk. */
  private robotPoint(sessionId: string): Point | null {
    const entry = this.entries.get(sessionId);
    if (!entry) return null;
    if (entry.robot) return { x: entry.robot.group.position.x, z: entry.robot.group.position.z };
    if (!entry.desk) return null;
    const chair = seatSpot(entry.desk);
    return { x: chair.x, z: chair.z };
  }

  private placeRing(): void {
    const selected = this.selected;
    const at = selected?.kind === 'desk' ? this.robotPoint(selected.id) : null;
    this.ring.visible = at !== null;
    if (at) this.ring.position.set(at.x, 0.02, at.z);
    const room = selected?.kind === 'room' ? this.roomOf(selected.id) : undefined;
    this.roomRing.visible = room !== undefined;
    if (room) this.outline(room.room.rect);
  }

  /** Lays the room outline's four strips just inside the room's edges. */
  private outline(rect: GridRect): void {
    const inset = 0.15;
    const width = 0.1;
    const strips: Array<[x: number, z: number, sx: number, sz: number]> = [
      [rect.w / 2, inset, rect.w - 2 * inset, width],
      [rect.w / 2, rect.h - inset, rect.w - 2 * inset, width],
      [inset, rect.h / 2, width, rect.h - 2 * inset],
      [rect.w - inset, rect.h / 2, width, rect.h - 2 * inset],
    ];
    strips.forEach(([x, z, sx, sz], i) => {
      const strip = this.roomRing.children[i]!;
      strip.position.set(x, 0, z);
      strip.scale.set(sx, sz, 1);
    });
    this.roomRing.position.set(rect.x, 0.012, rect.y);
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

/** A room's agents pick the room. */
function pickRoom(robot: RobotObject, runId: string): RobotObject {
  const pick: PickData = { kind: 'room', id: runId };
  for (const m of robot.pickables) m.userData.pick = pick;
  return robot;
}

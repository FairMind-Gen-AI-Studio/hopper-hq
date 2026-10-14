/**
 * The open floor as a three.js scene, kept in step with each FloorDetail the server sends. The shell holds the plan's
 * furniture (every desk, the lounge, every room) and is rebuilt only when the plan grows; who sits where, rug colours
 * and which rooms are open are updated in place. Each session on the floor has one robot, matched by sessionId, in floor
 * coordinates, that goes wherever its occupant is: to its desk, to the lounge or to the head of a room.
 *
 * Room agents, matched by room and agent id, sit at its table, and interns, matched by session and agent id, hover over
 * their session's desk: each keeps the seat or spot it took first (seats.ts), so that nobody moves when another leaves.
 *
 * Given the time of an update, robots walk (walkers.ts): one whose place changed goes there from where it is, a new one
 * comes out of the elevator, and one no longer on the floor walks to the elevator and leaves; interns fly. The elevator
 * doors open for each of them. frame() moves them on. Without the time, every robot is put in its place at once.
 *
 * A robot on its way casts no shadow and has a soft disc under it instead (design §6.3): the shadow map then changes only
 * as robots set off, with each floor update, and as they come to rest, which frame() reports. A room whose run ends is
 * dim at once, but keeps its door open until no robot is left in it or in its doorway. While loops are on, a
 * robot at its place runs its loop (robot.ts animateRobot) in every frame, from a phase of its own; the loops never
 * change the shadow map. The scene owns its geometries and materials and frees them all in dispose().
 *
 * A dormant session's desk has a nameplate with its name instead of a tag (design §7.3). Nameplates hide while the floor
 * is seen from far (setCompact), and each goes, with its texture, when its desk frees or its session wakes.
 */
import { DirectionalLight, Group, HemisphereLight, Mesh, Scene, type Object3D } from 'three';
import { INTERNS_MAX, SEATS_MAX } from '../../src/scene/layout';
import type { FloorDetail, GridRect, MeetingRoom, Occupant, PodDesk, Robot } from '../../src/scene/types';
import type { Target } from './index';
import { Materials } from './materials';
import { DOOR_HOLD_MS, DOOR_MS, WALK_SPEED, doorOpen, tripEnd } from './motion';
import { Geometries, buildNameplate, buildShell, setDoors, updateDesk, updatePod, updateRoom, type Nameplate, type PickData, type Shell } from './props';
import { KIND_SCALE, animateRobot, buildRobot, loopOf, phaseOf, poseRobot, strideRobot, type RobotKind, type RobotObject } from './robot';
import { keepSeats } from './seats';
import type { ThemeTokens } from './theme';
import { walkGrid } from './walk';
import { advance, doorsMoving, doorsNext, moveAll, settled, walkerAt, type Walker, type Wanted, type Ways } from './walkers';
import {
  HOME_AZIMUTH,
  LABEL_Y,
  elevatorSpot,
  floorCenter,
  internSpots,
  isStanding,
  labelAnchor,
  placeSpot,
  roomKey,
  seatSpot,
  seatSpots,
  shadowExtent,
  tableCenter,
  visibleWalls,
  type Point,
  type Point3,
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
  /** The robots of its running interns over its desk, by agent id. */
  readonly interns: Map<string, RobotObject>;
}

export interface RoomEntry {
  room: MeetingRoom;
  /** The robots of the agents at the table, by agent id. */
  readonly agents: Map<string, RobotObject>;
}

/** What one frame did. */
export interface FrameStep {
  /** A robot is still under way, or the elevator doors open or close. */
  moving: boolean;
  /** When something starts to move again while nothing moves now: the doors, held open, start to close. Null: never. */
  wake: number | null;
  /** A robot came to rest and casts its shadow again: the shadow map must be drawn. */
  shadows: boolean;
  /**
   * Where the tag of each session's robot hangs, by session id: over the robot on its way, at its place once there; null
   * while the robot waits unseen inside the elevator.
   */
  tags: Map<string, Point3 | null>;
  /** Loops are on and a robot at its place runs one: the next frame moves it on. */
  ambient: boolean;
}

/** The disc under a robot on its way: its radius at a session robot's size, and its height over the floor. */
export const CONTACT_R = 0.3;
export const CONTACT_Y = 0.015;

/** A robot the floor wants: its walker's place, and what it is built as. */
interface Cast extends Wanted {
  kind: RobotKind;
  /** The id it is built with: its session's, or a room agent's own. */
  owner: string;
  look: Robot;
  /** Its object's name. */
  name: string;
  /** The run whose room a click on it picks; null: it picks its session. */
  run: string | null;
  /** Hands it to what keeps it: its session's entry, or its room's. */
  join(robot: RobotObject): void;
}

/** A robot on the floor, leaving ones too, and the pose it takes at its place. */
interface Mover {
  robot: RobotObject;
  look: Pick<Robot, 'pose' | 'badge'>;
  /** The session whose tag hangs over it: its own robot's. */
  tag: string | null;
  /** On its way: the meshes that cast its shadow at rest, and the disc under it. */
  walking: { casters: Mesh[]; disc: Mesh } | null;
  /** Where its loop starts (phaseOf its key). */
  phase: number;
}

/** The keys walkers go by: a session's robot, a room's agent, a session's intern. */
const sessionKey = (sessionId: string) => JSON.stringify(['session', sessionId]);
const agentKey = (room: string, agentId: string) => JSON.stringify(['agent', room, agentId]);
const internKey = (sessionId: string, agentId: string) => JSON.stringify(['intern', sessionId, agentId]);

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
  /** Robots at their places run their loops: off under reduced motion and with motion: false. */
  loops = false;
  private shellPart: Shell | null = null;
  private signature = '';
  private floor: FloorDetail | null = null;
  /** The walk grid and the elevator of the plan. */
  private ways: Ways | null = null;
  /** Where each robot is going, by robot key: those the floor wants, then those leaving. */
  private walkers = new Map<string, Walker>();
  /** Each robot by the same key. */
  private readonly movers = new Map<string, Mover>();
  /**
   * When robots pass the elevator doors, until the doors have shut after them: those that did, and those the walkers are
   * to, given anew with each update, so that no robot that no longer comes or goes keeps the doors open.
   */
  private passes: number[] = [];
  /** The time of the last update or frame. */
  private clock = 0;
  /** The tag anchor of each session's robot at its place, by session id, as of the last update. */
  private readonly anchors = new Map<string, Point3>();
  /** Each room's seats by agent id, by room key; each session's intern spots by agent id, by session id. */
  private readonly roomSeats = new Map<string, Map<string, number>>();
  private readonly internSeats = new Map<string, Map<string, number>>();
  /** The floor's sessions by id: those at a desk and those waiting for one. */
  private readonly entries = new Map<string, SessionEntry>();
  /** By roomKey. */
  private readonly roomEntries = new Map<string, RoomEntry>();
  /** The rooms' keys in the floor's order: a run's first room is the first of these that is its. */
  private roomOrder: string[] = [];
  /** The slots of the rooms that runs hold. */
  private openSlots = new Set<number>();
  /** The nameplates on dormant sessions' desks, by desk id. */
  private readonly plates = new Map<string, Nameplate>();
  /** Seen from far: the nameplates hide. */
  private compact = false;
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

  /** A robot is under way, or the elevator doors open or close, as of the last update or frame. */
  get moving(): boolean {
    return [...this.walkers.values()].some((w) => w.trip !== null) || doorsMoving(this.passes, this.clock);
  }

  /**
   * Brings the scene in step with the floor. With `now`, robots walk from there on to their new places; without it,
   * each is put in its place at once (first sight, reduced motion). Returns true when the shell was rebuilt.
   */
  apply(floor: FloorDetail, now?: number): boolean {
    this.floor = floor;
    this.anchors.clear();
    if (now !== undefined) this.clock = now;
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
    const desks = new Set<string>();
    for (const pod of floor.pods) {
      const look = shell.pods.get(pod.id);
      if (look) updatePod(look, pod.color, this.mats);
      for (const desk of pod.desks) {
        const obj = shell.desks.get(desk.id);
        if (obj) updateDesk(obj, desk.occupant, this.mats);
        desks.add(desk.id);
        this.updatePlate(desk);
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
    for (const id of this.entries.keys()) if (!seen.has(id)) this.remove(id);
    for (const id of this.plates.keys()) if (!desks.has(id)) this.dropPlate(id);

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
      this.seatAgents(entry, wanted);
    }
    for (const key of this.roomEntries.keys()) if (!rooms.has(key)) this.removeRoom(key);

    const snap = now === undefined;
    const moves = moveAll(this.walkers, wanted, this.ways!, now ?? 0, { snap, regrid: rebuild });
    this.walkers = moves.walkers;
    this.passes = now === undefined ? [] : [...this.passes.filter((pass) => pass <= now), ...moves.passes];
    this.cast(wanted, now ?? 0);
    for (const c of wanted) c.join(this.movers.get(c.id)!.robot);
    setDoors(shell.doors, floor.core, doorOpen(this.passes, now ?? 0));
    const heads = new Set([...this.entries.values()].flatMap((e) => (e.robot && e.occupant.at.kind === 'room' ? [e.occupant.at.slot] : [])));
    for (const obj of shell.rooms) updateRoom(obj, open.get(obj.slot) ?? null, heads.has(obj.slot), this.mats);
    this.openSlots = new Set(open.keys());
    this.shutDoors();
    this.placeRing();
    return rebuild;
  }

  setTheme(theme: ThemeTokens): void {
    this.mats.applyTheme(theme);
    // Screens glow in their state's colour from the theme, given to each desk's screen piece.
    for (const desk of this.floor?.pods.flatMap((p) => p.desks) ?? []) {
      const obj = this.shellPart?.desks.get(desk.id);
      if (obj) updateDesk(obj, desk.occupant, this.mats);
    }
    this.hemi.color.set(theme.colors['hemi-sky']);
    this.hemi.groundColor.set(theme.colors['hemi-ground']);
    this.hemi.intensity = theme.numbers['hemi-int'];
    this.sun.color.set(theme.colors.sun);
    this.sun.intensity = theme.numbers['sun-int'];
  }

  /** Seen from far (labels.ts COMPACT_PX), the nameplates hide; closer in, they show. */
  setCompact(compact: boolean): void {
    this.compact = compact;
    for (const plate of this.plates.values()) plate.mesh.visible = !compact;
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
   * elevator goes. Every robot takes its part of the frame, at rest too. The doors, the rooms' doors when a robot moved,
   * and the selection ring follow.
   */
  frame(now: number): FrameStep {
    this.clock = now;
    let moving = false;
    let moved = false;
    let shadows = false;
    let ambient = false;
    const tags = new Map<string, Point3 | null>();
    for (const [key, w] of this.walkers) {
      const mover = this.movers.get(key)!;
      if (w.trip) moved = true;
      const next = advance(w, now);
      if (next === null) {
        this.walkers.delete(key);
        this.drop(key, mover);
        continue;
      }
      if (next !== w) this.walkers.set(key, next);
      if (this.place(mover, next, now)) shadows = true;
      if (next.trip) moving = true;
      else if (this.loops && loopOf(mover.look, mover.robot.kind) !== null) ambient = true;
      if (mover.tag !== null && !next.leaving) tags.set(mover.tag, mover.robot.group.visible ? this.tagAt(mover.tag, next, now) : null);
    }
    this.passes = this.passes.filter((pass) => now < pass + DOOR_HOLD_MS + DOOR_MS);
    if (this.shellPart && this.floor) setDoors(this.shellPart.doors, this.floor.core, doorOpen(this.passes, now));
    if (moved) this.shutDoors();
    this.placeRing();
    const still = !moving && !doorsMoving(this.passes, now);
    return { moving: !still, wake: still ? doorsNext(this.passes, now) : null, shadows, tags, ambient };
  }

  /** Puts every robot at its place at once: those under way are there, those leaving are gone, the doors are shut. Returns whether anything moved. */
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
    if (this.passes.length > 0) {
      moved = true;
      this.passes = [];
      if (this.shellPart && this.floor) setDoors(this.shellPart.doors, this.floor.core, 0);
    }
    this.shutDoors();
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

  /**
   * Everything a click can pick: the furniture, whose pieces pick the desks somebody sits at and the open rooms they
   * stand in; the robots and interns; and the open rooms with their agents.
   */
  pickables(): Object3D[] {
    const out: Object3D[] = [...(this.shellPart?.furniture.meshes ?? [])];
    for (const e of this.entries.values()) {
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
    for (const id of [...this.plates.keys()]) this.dropPlate(id);
    for (const id of this.entries.keys()) this.remove(id);
    for (const key of this.roomEntries.keys()) this.removeRoom(key);
    for (const [key, mover] of this.movers) this.drop(key, mover);
    this.walkers.clear();
    this.sun.dispose();
    this.hemi.dispose();
    this.scene.clear();
    this.geo.dispose();
    this.mats.dispose();
  }

  /**
   * Keeps the session's entry, and asks for its robot at its occupant's place, resting in the lounge, and for its running
   * interns over its desk, each on the spot it took first, in its robot's colours. A session that is gone, or waits for a
   * desk, has neither.
   */
  private track(occupant: Occupant, desk: PodDesk | null, wanted: Cast[]): void {
    const id = occupant.sessionId;
    let entry = this.entries.get(id);
    if (!entry) {
      entry = { occupant, desk, robot: null, interns: new Map() };
      this.entries.set(id, entry);
    }
    entry.occupant = occupant;
    entry.desk = desk;
    entry.robot = null;
    entry.interns.clear();
    const it = entry;
    const spot = this.floor ? placeSpot(this.floor, desk, occupant) : null;
    const robot = occupant.robot;
    if (!spot || !robot || !desk) {
      this.internSeats.delete(id);
      return;
    }
    const at = occupant.at;
    const place = at.kind === 'lounge' ? `lounge ${at.seat}` : at.kind === 'room' ? `room ${at.slot}` : `desk ${desk.id} ${isStanding(robot.pose) ? 'stand' : 'seat'}`;
    const look = at.kind === 'lounge' ? { ...robot, pose: 'resting' as const } : robot;
    const near = at.kind === 'desk' ? `desk ${desk.id}` : undefined;
    wanted.push({ id: sessionKey(id), gait: 'walk', place, near, to: spot, kind: 'session', owner: id, look, name: `robot ${id}`, run: null, join: (r) => (it.robot = r) });
    const spots = internSpots(desk);
    const seats = keepSeats(this.internSeats.get(id) ?? new Map(), occupant.interns.filter((i) => i.running).map((i) => i.agentId), Math.min(INTERNS_MAX, spots.length));
    this.internSeats.set(id, seats);
    const crew: Robot = { pose: 'still', badge: null, body: robot.body, tie: robot.tie };
    for (const [agentId, seat] of seats) {
      wanted.push({
        id: internKey(id, agentId),
        gait: 'fly',
        place: `desk ${desk.id} intern ${seat}`,
        to: spots[seat]!,
        kind: 'intern',
        owner: id,
        look: crew,
        name: `intern ${agentId}`,
        run: null,
        join: (r) => it.interns.set(agentId, r),
      });
    }
  }

  /**
   * Asks for the running agents of a room at its table, as workflow robots in the room's colours that pick the room:
   * each keeps the seat it took first, a new one takes the lowest free seat, and those beyond the seats are not drawn.
   */
  private seatAgents(entry: RoomEntry, wanted: Cast[]): void {
    const { room } = entry;
    const key = roomKey(room);
    entry.agents.clear();
    const seats = keepSeats(this.roomSeats.get(key) ?? new Map(), room.agents.slice(0, room.counts.running).map((a) => a.agentId), SEATS_MAX);
    this.roomSeats.set(key, seats);
    const spots = seatSpots(room.rect);
    const look: Robot = { pose: 'typing', badge: null, body: room.look.body, tie: room.look.tie };
    for (const [agentId, seat] of seats) {
      wanted.push({
        id: agentKey(key, agentId),
        gait: 'walk',
        place: `seat ${seat}`,
        to: spots[seat]!,
        kind: 'workflow',
        owner: agentId,
        look,
        name: `agent ${agentId}`,
        run: room.runId,
        join: (r) => entry.agents.set(agentId, r),
      });
    }
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
        robot.group.name = c.name;
        if (c.run !== null) pickRoom(robot, c.run);
        this.scene.add(robot.group);
        mover = { robot, look: c.look, tag: c.kind === 'session' ? c.owner : null, walking: null, phase: phaseOf(c.id) };
        this.movers.set(c.id, mover);
      }
      mover.look = { pose: c.look.pose, badge: c.look.badge };
    }
    for (const [key, mover] of this.movers) if (!this.walkers.has(key)) this.drop(key, mover);
    for (const [key, mover] of this.movers) this.place(mover, this.walkers.get(key)!, now);
  }

  /**
   * Puts a robot where its walker is at `now`: striding along its trip, its legs keeping pace with its speed, inside the
   * elevator out of sight until it sets off, or in its pose at its place, running its loop there while loops are on. One
   * that waits to set off from where it stands stays as it is. Under way, it casts no shadow and the disc under it follows
   * it. Returns true when it has come to rest and casts its shadow again.
   */
  private place(mover: Mover, w: Walker, now: number): boolean {
    const robot = mover.robot;
    if (w.trip && now < tripEnd(w.trip)) {
      const at = walkerAt(w, now);
      robot.group.visible = at.shown;
      if (at.walking || !at.shown) strideRobot(robot, at, ((Math.max(0, now - w.trip.start) / 1000) * w.trip.speed) / WALK_SPEED);
      mover.walking ??= this.lift(robot);
      mover.walking.disc.visible = at.shown;
      mover.walking.disc.position.set(at.x, CONTACT_Y, at.z);
      return false;
    }
    robot.group.visible = true;
    poseRobot(robot, mover.look, w.to);
    if (this.loops) animateRobot(robot, mover.look, now / 1000, mover.phase);
    return this.land(mover);
  }

  /** A robot sets off: it stops casting its shadow, and a disc lies on the floor under it instead. */
  private lift(robot: RobotObject): { casters: Mesh[]; disc: Mesh } {
    const casters = robot.pickables.filter((m) => m.castShadow);
    for (const m of casters) m.castShadow = false;
    const disc = new Mesh(this.geo.circle(CONTACT_R), this.mats.contact);
    disc.name = 'contact';
    disc.rotation.x = -Math.PI / 2;
    disc.scale.setScalar(KIND_SCALE[robot.kind]);
    this.scene.add(disc);
    return { casters, disc };
  }

  /** A robot comes to rest: it casts its shadow again, and its disc goes. Returns true when it casts any. */
  private land(mover: Mover): boolean {
    const walking = mover.walking;
    if (!walking) return false;
    mover.walking = null;
    for (const m of walking.casters) m.castShadow = true;
    walking.disc.removeFromParent();
    return walking.casters.length > 0;
  }

  /**
   * Where a session's tag hangs: over its robot, standing, on its way; where the floor puts it once at its place, worked
   * out once per floor update, so that frames of robots at rest make no new anchors.
   */
  private tagAt(sessionId: string, w: Walker, now: number): Point3 {
    if (!w.trip) {
      let anchor = this.anchors.get(sessionId);
      if (!anchor) {
        const entry = this.entries.get(sessionId)!;
        anchor = labelAnchor(this.floor!, entry.desk!, entry.occupant);
        this.anchors.set(sessionId, anchor);
      }
      return anchor;
    }
    const at = walkerAt(w, now);
    return { x: at.x, y: LABEL_Y.standing, z: at.z };
  }

  /**
   * Shuts the door of each room that no run holds once no robot it can be seen stands in the room, or within CONTACT_R
   * of it, in its doorway: the robots of a run that ends walk out through the open door. The door casts no shadow, so
   * shutting it needs no new shadow map.
   */
  private shutDoors(): void {
    if (!this.shellPart || !this.floor) return;
    for (const obj of this.shellPart.rooms) {
      if (this.openSlots.has(obj.slot)) continue;
      const rect = this.floor.roomSlots[obj.slot]!;
      let inside = false;
      for (const { robot } of this.movers.values()) {
        const { x, z } = robot.group.position;
        if (robot.group.visible && x > rect.x - CONTACT_R && x < rect.x + rect.w + CONTACT_R && z > rect.y - CONTACT_R && z < rect.y + rect.h + CONTACT_R) {
          inside = true;
          break;
        }
      }
      obj.door.visible = !inside;
    }
  }

  private drop(key: string, mover: Mover): void {
    mover.walking?.disc.removeFromParent();
    mover.robot.group.removeFromParent();
    this.movers.delete(key);
  }

  /**
   * Gives the desk of a dormant session a nameplate with its name, drawn once; takes it off a desk that is free or
   * whose session woke, and draws it anew for another dormant session or a new name.
   */
  private updatePlate(desk: PodDesk): void {
    const occupant = desk.occupant?.state === 'dormant' ? desk.occupant : null;
    const had = this.plates.get(desk.id);
    if (had && occupant && had.sessionId === occupant.sessionId && had.name === occupant.name) return;
    if (had) this.dropPlate(desk.id);
    if (!occupant) return;
    const plate = buildNameplate(desk, occupant, this.geo);
    plate.mesh.visible = !this.compact;
    this.scene.add(plate.mesh);
    this.plates.set(desk.id, plate);
  }

  private dropPlate(deskId: string): void {
    this.plates.get(deskId)?.dispose();
    this.plates.delete(deskId);
  }

  /** Forgets a session no longer on the floor. Its robot and its interns walk and fly out (cast). */
  private remove(id: string): void {
    this.entries.delete(id);
    this.internSeats.delete(id);
  }

  /** Forgets a room no longer on the floor. Its agents walk out (cast). */
  private removeRoom(key: string): void {
    this.roomEntries.delete(key);
    this.roomSeats.delete(key);
  }

  /** The first room of a run, in the floor's order, as the labels mark it. */
  private roomOf(runId: string): RoomEntry | undefined {
    for (const key of this.roomOrder) {
      const entry = this.roomEntries.get(key);
      if (entry?.room.runId === runId) return entry;
    }
    return undefined;
  }

  /**
   * Where a session's robot is now, or the chair of its desk when its robot has gone; null when it is not on this floor,
   * waits for a desk, or its robot waits unseen inside the elevator.
   */
  private robotPoint(sessionId: string): Point | null {
    const entry = this.entries.get(sessionId);
    if (!entry) return null;
    if (entry.robot) return entry.robot.group.visible ? { x: entry.robot.group.position.x, z: entry.robot.group.position.z } : null;
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

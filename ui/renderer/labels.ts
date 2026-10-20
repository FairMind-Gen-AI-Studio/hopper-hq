/**
 * The floor's HTML labels, laid over the canvas: one tag per session at a desk (state dot, name, "needs you", running
 * agents, remote), hanging over its robot wherever it is; one placard per pod that has one (repo, branch); and per
 * meeting room a tag (dot, counts) over its door, a board (its topic alone, big) over its whiteboard, and a full-detail
 * card (topic, phase or sub-agents, counts) that shows only while the room is hovered or selected. Built with
 * createElement and textContent only: names, repos, branches, topics, phases and sub-agent descriptions come from
 * transcripts and stay text. A label hangs from a point of the scene, projected each frame. One tag at a time is in the
 * tab order, the desks' first and the rooms' after them; the arrow keys, Home and End move between the tags on the view.
 *
 * Free desks and dormant sessions' desks have no tag. Seen from far (compact), every tag shows its state dot, desk tags keep their agent badge, and the
 * placards hide; closer, every tag and placard shows whole. At every zoom, where two overlap on the canvas the one that
 * ranks lower hides (design §7.3); from far, a named tag that another covers shows its dot alone where the dot is
 * clear. A tag hidden so is like one off the view: out of the tab order, and passed by the arrow keys. A tag that has
 * the focus or the pointer always shows, on top, and takes no part: it hides no one. Tags are measured as they rest,
 * never as a hover or the focus grows them. The floor panel lists every session and room, whatever the view shows.
 *
 * A room's full-detail card hangs above it (world.ts's cardAnchor), leaning away from a neighbour sharing its row to
 * cover as little of it as it can, clamped inside the viewport; it shows while its door tag is hovered or focused
 * (hoverRoom routes the 3D floor's and the whiteboard's own hover there too, through view.ts's canvas picking) or its
 * room is selected, and hides again otherwise. Its door tag carries an `aria-describedby` to the card's own id, so its
 * content is reachable from the keyboard and a screen reader once the tag has the focus, even before the pointer ever
 * finds the room.
 */
import { agentBadge } from '../lib/agent-badge';
import { Vector3, type Camera } from 'three';
import { STATE_LABEL } from '../../src/scene/text';
import type { FloorDetail, MeetingAgent, MeetingRoom, OnCallView, Occupant, PhaseState, Pod, PodDesk, ShownState } from '../../src/scene/types';
import type { Target } from './index';
import { BOARD_NORMAL, boardCorners, cardAnchor, facesCamera, labelAnchor, placardAnchor, roomKey, roomTagAnchor, sameTarget, type Point3, type Quad3 } from './world';
import './labels.css';

export interface ScreenPoint {
  /** CSS pixels from the canvas's left and top edges, rounded. */
  x: number;
  y: number;
  visible: boolean;
}

/** How far past the view's edge (in normalised device coordinates) an anchor may sit and keep its label. */
export const CULL = 1.1;

/** Projects a world point to the canvas; points behind the camera, past the far plane or off the view are not visible. */
export function projectToScreen(p: Point3, camera: Camera, width: number, height: number, v = new Vector3()): ScreenPoint {
  v.set(p.x, p.y, p.z).project(camera);
  const visible = v.z >= -1 && v.z <= 1 && Math.abs(v.x) <= CULL && Math.abs(v.y) <= CULL;
  return { x: Math.round(((v.x + 1) / 2) * width), y: Math.round(((1 - v.y) / 2) * height), visible };
}

/** A CSS 2D affine transform, as `matrix(a, b, c, d, e, f)` reads it: x' = a*x + c*y + e, y' = b*x + d*y + f. */
export interface Matrix2D {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

/** The size, in CSS pixels, of the board overlay's own fixed box before the matrix maps it onto the whiteboard's
 * projected quad ("whiteboard pixels"): its own layout never changes, only how the matrix scales and skews it. */
export const BOARD_PX = { w: 340, h: 120 } as const;

/**
 * The CSS affine transform that maps a `w`×`h` box, its own top-left at (0, 0), onto the parallelogram these three
 * projected corners (top-left, top-right, bottom-left) describe. An orthographic camera projects a 3D rectangle to
 * a parallelogram exactly, so three corners fix the map; the fourth (bottom-right) always falls at `tr + bl - tl`
 * and is taken too, only to let a caller assert that identity (the facing test below does; boardMatrix itself does
 * not need it).
 */
export function boardMatrix(corners: Pick<ScreenCorners, 'tl' | 'tr' | 'bl'>, w: number, h: number): Matrix2D {
  const { tl, tr, bl } = corners;
  return { a: (tr.x - tl.x) / w, b: (tr.y - tl.y) / w, c: (bl.x - tl.x) / h, d: (bl.y - tl.y) / h, e: tl.x, f: tl.y };
}

/** `boardMatrix`'s result as the CSS `transform` value. */
export function matrixToCss(m: Matrix2D): string {
  return `matrix(${m.a}, ${m.b}, ${m.c}, ${m.d}, ${m.e}, ${m.f})`;
}

/** A board's four world corners, projected to the canvas. */
export interface ScreenCorners {
  tl: ScreenPoint;
  tr: ScreenPoint;
  bl: ScreenPoint;
  br: ScreenPoint;
}

/**
 * Below this many CSS pixels to the metre, the floor is seen from far (compact): desks side by side are 2 m apart, and
 * a tag with a short name is about 70 px wide. A tag shows only its dot, and its name as well when it is selected, its
 * desk needs you or is done; a room's tag keeps its counts too (labels.css); the placards and the boards go.
 */
export const COMPACT_PX = 40;

/** A tag drawn as its dot alone, from far, in CSS pixels: a room's 7 px dot in 3 px of padding and a 1 px border (labels.css). */
export const DOT_PX = 15;
/** A compact desk tag: identity badge, gap, state dot, padding and border. */
export const AGENT_TAG = { w: 44, h: 32 } as const;

/** How labels rank where they overlap: the lower shows (design §7.3). */
export const RANK = { selected: 0, needs_you: 1, done: 2, room: 3, working: 4, other: 5, placard: 6 } as const;

/** What a label shows, for its rank: a desk's tag in its occupant's state, a room's tag, or a pod's placard. */
export type TagKind = { kind: 'desk'; state: ShownState } | { kind: 'room' } | { kind: 'placard' };

/** A label's rank: the selected tag's first; then a desk's tag by its state, with room tags after done; placards last. */
export function tagRank(tag: TagKind, selected: boolean): number {
  if (selected) return RANK.selected;
  if (tag.kind !== 'desk') return RANK[tag.kind];
  return tag.state === 'needs_you' || tag.state === 'done' || tag.state === 'working' ? RANK[tag.state] : RANK.other;
}

/** A label's box on the canvas, in CSS pixels, and its rank. */
export interface LabelBox {
  x: number;
  y: number;
  w: number;
  h: number;
  rank: number;
}

/**
 * Which labels show where their boxes overlap, by index. Taken by rank, then in the order given, each label shows unless
 * its box overlaps the box of one that shows already: a label that hides hides nothing. Boxes that only touch do not
 * overlap, and an empty box overlaps none. Pure; it compares each label with those that show, which stays cheap for the
 * few dozen labels of a floor.
 */
export function declutter(boxes: readonly LabelBox[]): boolean[] {
  const order = boxes.map((_, i) => i).sort((a, b) => boxes[a]!.rank - boxes[b]!.rank || a - b);
  const shown = boxes.map(() => false);
  const kept: LabelBox[] = [];
  for (const i of order) {
    const box = boxes[i]!;
    if (kept.some((k) => overlap(k, box))) continue;
    shown[i] = true;
    kept.push(box);
  }
  return shown;
}

function overlap(a: LabelBox, b: LabelBox): boolean {
  if (a.w <= 0 || a.h <= 0 || b.w <= 0 || b.h <= 0) return false;
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

export interface LabelEvents {
  /** `clicks` is the click's place in a series: 2 for the second click of a double-click, 0 from the keyboard. */
  select(target: Target, clicks: number): void;
  activate(target: Target): void;
  /** The focused tag left the view and no other tag is on it: the focus goes back to the canvas. */
  lostFocus(): void;
}

interface Label {
  el: HTMLElement;
  anchor: Point3;
  /** What the element shows, to skip rewriting it when nothing changed. */
  shows: string;
  /** Where its element was last put, in CSS pixels: where its anchor was last on the view. */
  x: number;
  y: number;
  /** Shown on the page: on the view, and kept. */
  visible: boolean;
  /** Where its anchor was on the canvas when last placed; null until then. */
  at: ScreenPoint | null;
  /** Kept by the zoom and, where labels overlap, by its rank. Boards are always kept. */
  kept: boolean;
  /** Its anchor is out of sight, as a robot inside the elevator is: it is placed as one off the view. */
  away: boolean;
}

/** A desk's or a room's tag: a button for a target. */
interface Tag extends Label {
  readonly target: Target;
  kind: TagKind;
  /** It has the focus, or the pointer is on it: it shows, and takes no part in which labels are kept. */
  focused: boolean;
  hovered: boolean;
}

/** A room's board, mapped onto its whiteboard's own projected quad (not hung from a single anchor like a tag): its
 * topic alone, big, never its phase, crew or counts (the full-detail Card carries those, on hover or selection). */
interface Board extends Label {
  readonly target: Target;
  /** The whiteboard's four world corners (world.ts), fixed once its room is placed. */
  corners: Quad3;
  /** The `transform` last written, to skip rewriting it when nothing moved. */
  matrix: string;
}

/** A room's full-detail card: the board's own content before the hybrid (topic, phase or crew, counts), hung from a
 * point above the room (world.ts's cardAnchor) and shown only on hover or selection, never mapped onto a mesh. */
interface Card extends Label {
  readonly target: Target;
  /** The key its door tag and board share (roomKey(room)): read each frame for that tag's own hovered/focused state. */
  key: string;
}

/** How many of a crew's sub-agents the card lines before counting the rest ('+N more'). */
const CREW_LINES_MAX = 4;

/** The topic's own font size on the board, in "whiteboard pixels" (BOARD_PX, matrix-scaled so it grows and shrinks
 * with the board itself): starts as big as the board can take (TOPIC_FONT.max) and shrinks while a run's topic would
 * still overflow its own two-line box, down to TOPIC_FONT.min — a topic that still doesn't fit there keeps the CSS's
 * own two-line clamp and ellipsis (labels.css) instead of shrinking further. */
export const TOPIC_FONT = { max: 34, min: 16, step: 2 } as const;

/** A unique DOM id for a room's card, so its door tag's `aria-describedby` can name it; never a value read back from
 * the scene (the floor itself has no ids to clash with or leak), just a counter, one per card ever created. */
let cardSeq = 0;

/**
 * Shrinks `el`'s own font size from TOPIC_FONT.max while its layout says the text overflows its two-line box
 * (CSS's `-webkit-line-clamp` keeps `clientHeight` at exactly two lines' worth at the current size, while
 * `scrollHeight` reports what the text would need unclamped), stopping at TOPIC_FONT.min. Reads the page, so it is
 * called once a board's own content changes, never every frame; happy-dom (tests) lays nothing out, so this is a
 * no-op there unless a test mocks `scrollHeight`/`clientHeight`, as the rest of this file's own layout-dependent
 * tests already do for `offsetWidth`/`offsetHeight`.
 */
function fitTopicFont(el: HTMLElement): void {
  let size: number = TOPIC_FONT.max;
  el.style.fontSize = `${size}px`;
  while (size > TOPIC_FONT.min && el.scrollHeight > el.clientHeight) {
    size -= TOPIC_FONT.step;
    el.style.fontSize = `${size}px`;
  }
}

export class LabelLayer {
  /** Desk tags by 'desk <session id>', and room tags by 'room <room key>'. */
  private readonly tags = new Map<string, Tag>();
  /** Pod placards by pod id. */
  private readonly signs = new Map<string, Label>();
  /** Room boards by room key. */
  private readonly boards = new Map<string, Board>();
  /** Rooms' full-detail cards by room key, shown on hover or selection. */
  private readonly cards = new Map<string, Card>();
  /** The camera and viewport `position()` last placed labels with, so a hover or a focus change alone (setSelected,
   * hoverRoom, a tag's own pointer/focus listeners) can reposition the cards at once rather than wait for the next
   * frame; null before the first `position()`, when a card has nothing to project onto yet. */
  private lastFrame: { camera: Camera; width: number; height: number } | null = null;
  private selected: Target | null = null;
  /** The tags in floor order, the desks' first and the rooms' after them, and the one in the tab order. */
  private order: string[] = [];
  /** The placards' pods in floor order. */
  private signOrder: string[] = [];
  private stop: string | null = null;
  private compact = false;
  /** Which labels are kept must be worked out again at the next placing: labels, ranks or the zoom changed. */
  private stale = true;
  private readonly v = new Vector3();

  constructor(
    private readonly root: HTMLElement,
    private readonly events: LabelEvents,
  ) {
    root.classList.add('fv-labels');
  }

  /** Adds, updates and removes labels to match the floor. */
  sync(floor: FloorDetail): void {
    const tags = new Set<string>();
    const signs = new Set<string>();
    const boards = new Set<string>();
    const cards = new Set<string>();
    for (const pod of floor.pods) {
      if (pod.placard) {
        signs.add(pod.id);
        this.syncSign(pod, pod.placard);
      }
      for (const desk of pod.desks) if (desk.occupant && desk.occupant.state !== 'dormant') tags.add(this.syncTag(floor, desk, desk.occupant));
    }
    for (const room of floor.rooms) {
      // The card first: its id exists by the time syncRoomTag names it in the tag's own aria-describedby.
      cards.add(this.syncCard(room, floor.rooms));
      boards.add(this.syncBoard(room));
      tags.add(this.syncRoomTag(room));
    }
    for (const [key, label] of this.tags) if (!tags.has(key)) this.drop(this.tags, key, label);
    for (const [key, label] of this.signs) if (!signs.has(key)) this.drop(this.signs, key, label);
    for (const [key, label] of this.boards) if (!boards.has(key)) this.drop(this.boards, key, label);
    for (const [key, label] of this.cards) if (!cards.has(key)) this.drop(this.cards, key, label);
    this.order = [...tags];
    this.signOrder = [...signs];
    this.stale = true;
    this.markSelected();
    this.rove(this.stop);
  }

  /** Marks the selected desk's tag, or the tag of the selected run's first room; null clears. Its card shows too
   * (positionCard), through the same check a hover or a focus leaves to. */
  setSelected(target: Target | null): void {
    const changed = !sameTarget(target, this.selected);
    this.selected = target;
    this.stale = true;
    this.markSelected();
    // The tab stop follows a new selection; the same one marked again, as on each floor update, leaves it be.
    if (changed) this.rove(this.selectedKey());
    if (changed) this.recheck();
  }

  /**
   * Marks a room's door tag hovered, and so its full-detail card shown, as the pointer finds it over the room's own
   * floor or whiteboard (view.ts's canvas picking) or leaves it (null): the same `hovered` flag a tag's own
   * pointerenter/pointerleave already set from directly over the door tag itself, so the card shows the same way
   * wherever over the room the pointer lands. A run with two rooms (two hosts of the same run) hovers together, the
   * same ambiguity pickTarget's own click-select already has.
   */
  hoverRoom(runId: string | null): void {
    let changed = false;
    for (const tag of this.tags.values()) {
      if (tag.target.kind !== 'room') continue;
      const hovered = runId !== null && tag.target.id === runId;
      if (tag.hovered === hovered) continue;
      tag.hovered = hovered;
      changed = true;
    }
    if (changed) this.recheck();
  }

  /** How many CSS pixels a metre takes on screen. Below COMPACT_PX, the floor is seen from far. */
  setScale(pxPerMetre: number): void {
    const compact = pxPerMetre < COMPACT_PX;
    if (compact === this.compact) return;
    this.compact = compact;
    this.stale = true;
    this.root.classList.toggle('fv-compact', compact);
  }

  /** With motion off (ViewOptions.motion), nothing on the labels moves: the dot of a desk that needs you keeps still. */
  setMotion(on: boolean): void {
    this.root.classList.toggle('fv-still', !on);
  }

  /**
   * Moves every label to its anchor's place on the canvas, hiding those off the view. When a label moved, came or went,
   * or ranks or the zoom changed, it works out again which tags and placards are kept where they overlap. Each board
   * maps onto its own whiteboard's projected quad instead (positionBoard): it never takes part in keep(). Each room's
   * card (positionCard) hangs from its own point above the room, shown only on hover, focus or selection: it never
   * takes part in keep() either, and hides no one.
   */
  position(camera: Camera, width: number, height: number): void {
    const labels = [...this.signs.values(), ...this.tags.values()];
    let moved = this.stale;
    for (const label of labels) {
      const p = projectToScreen(label.anchor, camera, width, height, this.v);
      if (label.away) p.visible = false;
      const was = label.at;
      if (!was || p.visible !== was.visible || (p.visible && (p.x !== was.x || p.y !== was.y))) moved = true;
      label.at = p;
    }
    if (moved) this.keep();
    for (const label of labels) {
      const p = label.at!;
      this.show(label);
      // A hidden label on the view moves too, so that it shows in its place once it is kept again.
      if (p.visible && (p.x !== label.x || p.y !== label.y)) {
        label.el.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%, -100%)`;
        label.x = p.x;
        label.y = p.y;
      }
    }
    for (const board of this.boards.values()) this.positionBoard(board, camera, width, height);
    this.lastFrame = { camera, width, height };
    this.positionCards(camera, width, height);
    this.keepStopOnView();
  }

  /**
   * Maps a board's fixed box onto its whiteboard's own projected quad (world.ts's boardCorners), by the affine
   * transform three of its four projected corners fix (boardMatrix): the camera is orthographic, so a flat 3D
   * rectangle always projects to a parallelogram, however the floor is turned or zoomed. Hidden, rather than mapped
   * small or mirrored, when the board's own face points away from the camera (world.ts's facesCamera) or none of
   * its corners are on the view; the far/compact view hides it by CSS instead (labels.css's .fv-compact), whatever
   * it faces.
   */
  private positionBoard(board: Board, camera: Camera, width: number, height: number): void {
    const project = (p: Point3) => projectToScreen(p, camera, width, height, this.v);
    const tl = project(board.corners.tl);
    const tr = project(board.corners.tr);
    const bl = project(board.corners.bl);
    const br = project(board.corners.br);
    camera.getWorldDirection(this.v);
    const toCamera = { x: -this.v.x, y: -this.v.y, z: -this.v.z };
    const visible = facesCamera(BOARD_NORMAL, toCamera) && (tl.visible || tr.visible || bl.visible || br.visible);
    board.at = { x: Math.round((tl.x + tr.x + bl.x + br.x) / 4), y: Math.round((tl.y + tr.y + bl.y + br.y) / 4), visible };
    this.show(board);
    if (!visible) return;
    const matrix = matrixToCss(boardMatrix({ tl, tr, bl }, BOARD_PX.w, BOARD_PX.h));
    if (matrix !== board.matrix) {
      board.el.style.transform = matrix;
      board.matrix = matrix;
    }
  }

  /** Repositions every room's card from the last frame placed (position()), if there has been one: a hover or a
   * focus change alone calls this, so a card shows, hides or moves without waiting for the next draw. */
  private repositionCards(): void {
    if (this.lastFrame) this.positionCards(this.lastFrame.camera, this.lastFrame.width, this.lastFrame.height);
  }

  private positionCards(camera: Camera, width: number, height: number): void {
    for (const card of this.cards.values()) this.positionCard(card, camera, width, height);
  }

  /**
   * Shows a room's full-detail card above it (world.ts's cardAnchor), clamped inside the viewport by its own real
   * size (resting()'s own trick, read from the page as it rests), while its door tag is hovered or focused or the
   * room itself is selected; hides it otherwise, or once its anchor leaves the view. Never takes part in keep(): a
   * card hides no one, and nothing ever hides it but its own want.
   */
  private positionCard(card: Card, camera: Camera, width: number, height: number): void {
    const tag = this.tags.get(`room ${card.key}`);
    const want = (tag !== undefined && (tag.hovered || tag.focused)) || sameTarget(this.selected, card.target);
    if (!want) {
      this.showCard(card, false);
      return;
    }
    const p = projectToScreen(card.anchor, camera, width, height, this.v);
    if (!p.visible) {
      this.showCard(card, false);
      return;
    }
    const w = card.el.offsetWidth;
    const h = card.el.offsetHeight;
    const x = Math.min(width - w / 2, Math.max(w / 2, p.x));
    const y = Math.min(height, Math.max(h, p.y));
    card.el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -100%)`;
    this.showCard(card, true);
  }

  /** Shows or hides a card, and marks it `aria-hidden` the opposite way: hidden content stays out of a screen
   * reader's way until the room it describes is hovered, focused or selected. */
  private showCard(card: Card, visible: boolean): void {
    if (visible === card.visible) return;
    card.el.style.visibility = visible ? '' : 'hidden';
    if (visible) card.el.removeAttribute('aria-hidden');
    else card.el.setAttribute('aria-hidden', 'true');
    card.visible = visible;
  }

  /**
   * Hangs a session's tag from another point: over its robot while it walks. The next position() moves it there. Null:
   * its robot is out of sight, inside the elevator, and its tag shows nowhere, selected or not, until it hangs from a
   * point again.
   */
  moveTag(sessionId: string, anchor: Point3 | null): void {
    const tag = this.tags.get(deskKey(sessionId));
    if (!tag) return;
    if (anchor) tag.anchor = anchor;
    tag.away = anchor === null;
  }

  tag(sessionId: string): HTMLElement | undefined {
    return this.tags.get(deskKey(sessionId))?.el;
  }

  /** The tag of the run's first room. */
  roomTag(runId: string): HTMLElement | undefined {
    return [...this.tags.values()].find((t) => sameTarget(t.target, { kind: 'room', id: runId }))?.el;
  }

  /** The board of the run's first room. */
  board(runId: string): HTMLElement | undefined {
    return [...this.boards.values()].find((b) => b.target.id === runId)?.el;
  }

  /** The full-detail card of the run's first room. */
  card(runId: string): HTMLElement | undefined {
    return [...this.cards.values()].find((c) => c.target.id === runId)?.el;
  }

  /** The placard of a pod, by its id. */
  sign(podId: string): HTMLElement | undefined {
    return this.signs.get(podId)?.el;
  }

  dispose(): void {
    for (const [key, label] of this.tags) this.drop(this.tags, key, label);
    for (const [key, label] of this.signs) this.drop(this.signs, key, label);
    for (const [key, label] of this.boards) this.drop(this.boards, key, label);
    for (const [key, label] of this.cards) this.drop(this.cards, key, label);
    this.root.classList.remove('fv-labels', 'fv-compact', 'fv-still');
  }

  /** The tag of a desk or a room: made once, as a button that selects and activates its target. It ranks as `kind`. */
  private button(key: string, target: Target, kind: TagKind): Tag {
    const had = this.tags.get(key);
    if (had) {
      had.kind = kind;
      return had;
    }
    const el = document.createElement('button');
    el.type = 'button';
    el.tabIndex = -1;
    if (target.kind === 'desk') el.dataset.session = target.id;
    else el.dataset.run = target.id;
    const tag: Tag = { ...this.add(el), target, kind, focused: false, hovered: false };
    el.addEventListener('click', (e) => this.events.select(target, e.detail));
    el.addEventListener('dblclick', () => this.events.activate(target));
    el.addEventListener('focus', () => {
      tag.focused = true;
      this.rove(key);
      this.recheck();
    });
    el.addEventListener('blur', () => {
      tag.focused = false;
      this.recheck();
    });
    el.addEventListener('pointerenter', () => {
      tag.hovered = true;
      this.recheck();
    });
    el.addEventListener('pointerleave', () => {
      tag.hovered = false;
      this.recheck();
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && sameTarget(this.selected, target)) {
        e.preventDefault();
        this.events.activate(target);
      } else if (MOVES.includes(e.key)) {
        e.preventDefault();
        this.focusFrom(key, e.key);
      }
    });
    this.tags.set(key, tag);
    return tag;
  }

  /** The tag of the session at a desk, over its robot. Returns the tag's key. */
  private syncTag(floor: FloorDetail, desk: PodDesk, occupant: Occupant): string {
    const key = deskKey(occupant.sessionId);
    const tag = this.button(key, { kind: 'desk', id: occupant.sessionId }, { kind: 'desk', state: occupant.state });
    tag.anchor = labelAnchor(floor, desk, occupant);
    const shows = JSON.stringify([occupant.agentKind, occupant.name, occupant.state, occupant.robot?.badge ?? null, occupant.agentsRunning, occupant.location, occupant.call, occupant.activity?.label ?? null]);
    if (shows === tag.shows) return key;
    tag.shows = shows;
    const el = tag.el;
    el.className = ['fv-tag', 'fv-desk', `fv-st-${occupant.state}`, occupant.robot?.badge ? `fv-badge-${occupant.robot.badge}` : ''].filter(Boolean).join(' ');
    mark(el, sameTarget(this.selected, tag.target));
    const parts = [agentBadge(occupant.agentKind), span('fv-dot', ''), span('fv-name', occupant.name)];
    if (occupant.state === 'needs_you') parts.push(span('fv-note', 'needs you'));
    if (occupant.agentsRunning > 0) parts.push(span('fv-agents', `+${occupant.agentsRunning}`));
    if (occupant.location === 'cloud') parts.push(span('fv-remote', 'remote'));
    if (occupant.call) parts.push(callChip(occupant.call, occupant.activity?.label ?? null));
    el.replaceChildren(...parts);
    el.title = tagTitle(occupant);
    return key;
  }

  /** The room's tag over its door: its dot and its counts, the name and the phase being the board's and the card's
   * now. Carries an `aria-describedby` to its room's card (syncCard, called first), so the card's full content is
   * reachable from the keyboard and a screen reader once the tag has the focus. Returns its key. */
  private syncRoomTag(room: MeetingRoom): string {
    const key = `room ${roomKey(room)}`;
    const tag = this.button(key, { kind: 'room', id: room.runId }, { kind: 'room' });
    tag.anchor = roomTagAnchor(room.rect);
    const card = this.cards.get(roomKey(room));
    if (card) tag.el.setAttribute('aria-describedby', card.el.id);
    const shows = JSON.stringify([room.name, currentPhase(room), room.counts, room.summary]);
    if (shows === tag.shows) return key;
    tag.shows = shows;
    const el = tag.el;
    el.className = 'fv-tag fv-room';
    mark(el, sameTarget(this.selected, tag.target));
    el.replaceChildren(span('fv-dot', ''), span('fv-counts', countsText(room)));
    el.title = roomTitle(room);
    return key;
  }

  /**
   * The room's board, printed on its whiteboard (positionBoard): its topic alone, as big as it fits (fitTopicFont),
   * never its phase, crew or counts — those move to the full-detail card (syncCard), shown only on hover or
   * selection, so the board stays legible at the floor's own working zoom. The run's summary never shows here
   * either way (privacy): only in the door tag's tooltip. Returns its key.
   */
  private syncBoard(room: MeetingRoom): string {
    const key = roomKey(room);
    let board = this.boards.get(key);
    if (!board) {
      const el = document.createElement('div');
      el.className = 'fv-board';
      el.dataset.run = room.runId;
      const topic = document.createElement('p');
      topic.className = 'fv-topic';
      el.append(topic);
      board = { ...this.add(el), target: { kind: 'room', id: room.runId }, corners: boardCorners(room.rect), matrix: '' };
      this.boards.set(key, board);
    }
    board.corners = boardCorners(room.rect);
    const shows = JSON.stringify([room.topic]);
    if (shows === board.shows) return key;
    board.shows = shows;
    const topic = board.el.firstElementChild as HTMLParagraphElement;
    topic.textContent = room.topic;
    topic.title = room.topic;
    fitTopicFont(topic);
    return key;
  }

  /**
   * The room's full-detail card, hung above it (world.ts's cardAnchor) and shown only on hover or selection
   * (positionCard): its topic as the heading, up to two lines; below it, in a body that clips rather than push the
   * counts out, a workflow run's current phase with its ordinal among its phases ('Build 2/4'), or a crew's running
   * sub-agents first by task description, CREW_LINES_MAX at most, counting the rest; then the counts, always on. The
   * run's summary never shows here either (privacy): only in the door tag's tooltip. Returns its key.
   */
  private syncCard(room: MeetingRoom, rooms: readonly MeetingRoom[]): string {
    const key = roomKey(room);
    let card = this.cards.get(key);
    if (!card) {
      const el = document.createElement('div');
      el.className = 'fv-card';
      el.dataset.run = room.runId;
      el.id = `fv-card-${cardSeq++}`;
      // Hidden from a screen reader from the start, the same way its own style starts hidden (add()): showCard
      // only writes the attribute where it changes, so the first frame, already wanting it hidden, would not.
      el.setAttribute('aria-hidden', 'true');
      card = { ...this.add(el), target: { kind: 'room', id: room.runId }, key };
      this.cards.set(key, card);
    }
    card.anchor = cardAnchor(
      room.rect,
      rooms.map((r) => r.rect),
    );
    const shows = JSON.stringify([room.topic, room.kind, room.phases, room.agents.map((a) => [a.agentId, a.label, a.type, a.running]), room.counts]);
    if (shows === card.shows) return key;
    card.shows = shows;
    const topic = document.createElement('p');
    topic.className = 'fv-topic';
    topic.textContent = room.topic;
    topic.title = room.topic;
    const body = document.createElement('div');
    body.className = 'fv-body';
    if (room.kind === 'workflow') {
      const ordinal = phaseOrdinal(room.phases);
      if (ordinal !== null) body.append(line('fv-phase', ordinal));
    } else if (room.agents.length > 0) {
      const shown = room.agents.slice(0, CREW_LINES_MAX);
      const list = document.createElement('ol');
      list.className = 'fv-crew';
      for (const a of shown) {
        const text = agentLine(a);
        const item = document.createElement('li');
        item.textContent = text;
        item.title = text;
        list.append(item);
      }
      body.append(list);
      const more = room.agents.length - shown.length;
      if (more > 0) body.append(line('fv-more', `+${more} more`));
    }
    const counts = line('fv-counts', countsText(room));
    card.el.replaceChildren(topic, ...(body.hasChildNodes() ? [body] : []), counts);
    return key;
  }

  /** A pod's placard: its repository, and its branch while its occupants share a checkout. */
  private syncSign(pod: Pod, placard: NonNullable<Pod['placard']>): void {
    let label = this.signs.get(pod.id);
    if (!label) {
      label = this.add(document.createElement('div'));
      this.signs.set(pod.id, label);
    }
    label.anchor = placardAnchor(pod.rect);
    const where = placard.path === null ? null : (placard.branch ?? 'no branch') + (placard.worktree ? ' · worktree' : '');
    const shows = JSON.stringify([placard.repo, where]);
    if (shows === label.shows) return;
    label.shows = shows;
    label.el.className = 'fv-sign';
    const parts: Node[] = [document.createTextNode(placard.repo)];
    if (where !== null) {
      const small = document.createElement('small');
      small.textContent = where;
      parts.push(small);
    }
    label.el.replaceChildren(...parts);
  }

  /**
   * Works out which tags and placards are kept, among those on the view, but no placard at compact zoom: all but those
   * that overlap one that ranks higher, or one as high earlier in floor order (desk tags, room tags, then placards). A tag
   * with the focus or the pointer is kept, and left out. The others' sizes are read from the page as they rest at this
   * zoom: from far a tag is a dot, or a dot and a name, and one drawn as its dot alone is drawn named again to be read.
   * From far, the named tags (selected, needs you, done, rooms) are worked out first; then the dots, among the labels
   * kept: those of the named tags not kept, as compact boxes over their anchors, and the other tags. The result follows
   * from the anchors and the resting sizes alone, so placing the same labels again keeps the same ones.
   */
  private keep(): void {
    this.stale = false;
    const selected = this.selectedKey();
    for (const tag of this.tags.values()) tag.el.classList.remove('fv-dot-only');
    const seen: Array<{ label: Label; named: boolean; box: LabelBox }> = [];
    for (const key of this.order) {
      const tag = this.tags.get(key)!;
      tag.kept = tag.focused || tag.hovered;
      if (tag.kept || !tag.at!.visible) continue;
      const rank = tagRank(tag.kind, key === selected);
      seen.push({ label: tag, named: rank <= RANK.room, box: resting(tag, rank) });
    }
    for (const id of this.signOrder) {
      const sign = this.signs.get(id)!;
      sign.kept = false;
      if (sign.at!.visible && !this.compact) seen.push({ label: sign, named: true, box: resting(sign, RANK.placard) });
    }
    if (!this.compact) {
      declutter(seen.map((s) => s.box)).forEach((kept, i) => (seen[i]!.label.kept = kept));
      return;
    }
    const named = seen.filter((s) => s.named);
    declutter(named.map((s) => s.box)).forEach((kept, i) => (named[i]!.label.kept = kept));
    const shown = named.filter((s) => s.label.kept).map((s): LabelBox => ({ ...s.box, rank: -1 }));
    const dots = seen.filter((s) => !s.label.kept).map((s) => (s.named ? { ...s, box: dotBox(s.label.at!, s.box.rank, s.label.el.classList.contains('fv-desk')) } : s));
    const kept = declutter([...shown, ...dots.map((s) => s.box)]);
    dots.forEach((s, i) => {
      s.label.kept = kept[shown.length + i]!;
      if (s.named && s.label.kept) s.label.el.classList.add('fv-dot-only');
    });
  }

  /** Shows a label while it is on the view and kept, and hides it otherwise. */
  private show(label: Label): void {
    const visible = label.at!.visible && label.kept;
    if (visible === label.visible) return;
    label.el.style.visibility = visible ? '' : 'hidden';
    label.visible = visible;
  }

  /**
   * Works out again which labels are kept, where they are placed now, as a tag gains or loses the focus or the pointer.
   * Before every label is placed, it leaves it to the next position().
   */
  private recheck(): void {
    const labels = [...this.signs.values(), ...this.boards.values(), ...this.tags.values()];
    if (labels.some((label) => label.at === null)) {
      this.stale = true;
      return;
    }
    this.keep();
    for (const label of labels) this.show(label);
    this.keepStopOnView();
    this.repositionCards();
  }

  /** Marks the tag of the selected key only: one room of a run is outlined, and one tag says so. */
  private markSelected(): void {
    const key = this.selectedKey();
    for (const [k, tag] of this.tags) mark(tag.el, k === key);
  }

  /** The key of the selected desk's tag, or of the tag of the selected run's first room. */
  private selectedKey(): string | null {
    return this.order.find((key) => sameTarget(this.tags.get(key)!.target, this.selected)) ?? null;
  }

  /**
   * Puts one tag in the tab order: `want`'s if it has one, else the one there now, else the selected desk's or room's,
   * else the first.
   */
  private rove(want: string | null): void {
    const next = [want, this.stop, this.selectedKey(), this.order[0] ?? null].find((key) => key !== null && this.tags.has(key)) ?? null;
    const old = this.stop === null ? undefined : this.tags.get(this.stop);
    if (old) old.el.tabIndex = -1;
    this.stop = next;
    const now = next === null ? undefined : this.tags.get(next);
    if (now) now.el.tabIndex = 0;
  }

  /**
   * Moves the tab stop off a tag that left the view, to the tag on the view nearest to it in floor order (the earlier
   * on a tie). A focused tag that leaves hands its focus over before the browser drops it to the page.
   */
  private keepStopOnView(): void {
    const stop = this.stop === null ? undefined : this.tags.get(this.stop);
    if (!stop || stop.visible) return;
    const had = document.activeElement === stop.el;
    const at = this.order.indexOf(this.stop!);
    let next: string | undefined;
    for (let d = 1; d < this.order.length && next === undefined; d++) {
      next = [this.order[at - d], this.order[at + d]].find((key) => key !== undefined && this.tags.get(key)?.visible);
    }
    if (next === undefined) {
      if (had) this.events.lostFocus();
      return;
    }
    this.rove(next);
    if (had) this.focusTag(next);
  }

  /** Focuses the tag a key leads to from this one, among the tags on the view, in floor order. */
  private focusFrom(key: string, move: string): void {
    const shown = this.order.filter((k) => this.tags.get(k)?.visible);
    const at = shown.indexOf(key);
    const to = move === 'Home' ? 0 : move === 'End' ? shown.length - 1 : at + (move === 'ArrowRight' || move === 'ArrowDown' ? 1 : -1);
    const next = shown[Math.max(0, Math.min(shown.length - 1, to))];
    if (next !== undefined) this.focusTag(next);
  }

  /**
   * Gives a tag the focus, keeping it shown from the moment the tag losing the focus is worked out again, which could
   * otherwise hide it: a hidden element takes no focus.
   */
  private focusTag(key: string): void {
    const tag = this.tags.get(key)!;
    tag.focused = true;
    tag.el.focus();
    if (document.activeElement === tag.el) return;
    tag.focused = false;
    this.recheck();
  }

  /** A label for `el`, hidden until it is placed. */
  private add(el: HTMLElement): Label {
    el.style.visibility = 'hidden';
    this.root.append(el);
    return { el, anchor: { x: 0, y: 0, z: 0 }, shows: '', x: NaN, y: NaN, visible: false, at: null, kept: true, away: false };
  }

  private drop<L extends Label>(map: Map<string, L>, key: string, label: L): void {
    label.el.remove();
    map.delete(key);
  }
}

/** A label's box as it rests on the page, hanging from its point: its element's size as the page draws it now. */
function resting(label: Label, rank: number): LabelBox {
  const w = label.el.offsetWidth;
  const h = label.el.offsetHeight;
  return { x: label.at!.x - w / 2, y: label.at!.y - h, w, h, rank };
}

/** A tag's box as its dot alone, hanging from its point. */
function dotBox(at: ScreenPoint, rank: number, desk: boolean): LabelBox {
  const { w, h } = desk ? AGENT_TAG : { w: DOT_PX, h: DOT_PX };
  return { x: at.x - w / 2, y: at.y - h, w, h, rank };
}

/** The keys that move the focus between tags. */
const MOVES = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'];

function deskKey(sessionId: string): string {
  return `desk ${sessionId}`;
}

function span(className: string, text: string): HTMLSpanElement {
  const el = document.createElement('span');
  el.className = className;
  el.textContent = text;
  return el;
}

function mark(el: HTMLElement, selected: boolean): void {
  el.classList.toggle('fv-sel', selected);
  if (selected) el.setAttribute('aria-current', 'true');
  else el.removeAttribute('aria-current');
}

/**
 * The on-call chip's text (hq-mcp-switchboard proposal.md §2 "a transient chip … `notion: search`"):
 * `DeskActivity.label` already reads `"<server>: <tool>"` for an MCP call (tool-label.ts's `toolLabel`, the one
 * trace of the call's identity that survives into the scene) — the chip is the call's authoritative identity, so
 * it reuses that string rather than re-deriving one from `OnCallView` (which carries only a palette slot, a
 * family and the booleans the 3D headset needs, not a server or tool name). `label` can, rarely, lag the call by
 * a frame or two into its minimum-hold tail (`OnCallView`'s own doc comment): a session between two tools shows
 * its last one a beat longer, which is the lesser of the two readings to get wrong here. The dropped-call mark
 * (`✗`) is the DOM echo of the floor's own red flash (proposal.md §2 "Error / dropped call"). `×N` ("parallel MCP
 * calls" follow-up, `OnCallView.count`) says how many of this entity's own calls are concurrently live past the
 * one this chip already names — the robot has one headset, showing its most-recent call alone, so this is the
 * chip's own trace of a parallelism the headset's single colour cannot.
 */
export function callText(call: Pick<OnCallView, 'error' | 'count'>, label: string | null): string {
  const count = call.count && call.count > 1 ? ` ×${call.count}` : '';
  return (label ?? 'on a call') + count + (call.error ? ' ✗' : '');
}

/** The on-call chip's colour class: a line slot (labels.css maps it to the matching `--line-N` token) or
 * Fairmind's own fixed teal — the chip's "colour swatch" (proposal.md §2), the glance next to the name's truth. */
function callClass(call: Pick<OnCallView, 'slot' | 'fairmind'>): string {
  return call.fairmind ? 'fv-call-fairmind' : `fv-call-line-${call.slot}`;
}

/** The on-call chip itself, on the tag's existing projected anchor: joins the aria/roving model for free, as one
 * more child of the tag button `syncTag` already builds (DeskPanel shows the same activity line for the
 * non-visual path, DeskPanel.svelte). */
function callChip(call: OnCallView, label: string | null): HTMLSpanElement {
  const className = ['fv-call', callClass(call), call.error ? 'fv-call-error' : ''].filter(Boolean).join(' ');
  return span(className, callText(call, label));
}

/** A plain line of the board, below its topic (a phase, a sub-agent count, or the running and done counts). */
function line(className: string, text: string): HTMLParagraphElement {
  const el = document.createElement('p');
  el.className = className;
  el.textContent = text;
  return el;
}

/** A sub-agent's line on a crew's board: its task description, else its type, else 'Agent'. */
function agentLine(agent: Pick<MeetingAgent, 'label' | 'type'>): string {
  return agent.label ?? agent.type ?? 'Agent';
}

/** The current phase with its ordinal among the run's phases ('Build 2/4'); null while none is current. */
function phaseOrdinal(phases: MeetingRoom['phases']): string | null {
  const i = phases.findIndex((p) => p.state === 'current');
  return i === -1 ? null : `${phases[i]!.title} ${i + 1}/${phases.length}`;
}

/** The tag's tooltip: name, state, running agents, remote, and the call it is on, if any. */
export function tagTitle(o: Pick<Occupant, 'name' | 'state' | 'agentsRunning' | 'location' | 'call' | 'activity'>): string {
  const bits = [o.name, STATE_LABEL[o.state]];
  if (o.agentsRunning > 0) bits.push(`${o.agentsRunning} ${o.agentsRunning === 1 ? 'agent' : 'agents'} running`);
  if (o.location === 'cloud') bits.push('remote');
  if (o.call) bits.push(callText(o.call, o.activity?.label ?? null));
  return bits.join(' · ');
}

function currentPhase(room: MeetingRoom): string | null {
  return room.phases.find((p) => p.state === 'current')?.title ?? null;
}

function countsText(room: MeetingRoom): string {
  return `${room.counts.running} running · ${room.counts.finished} done`;
}

/** The room tag's tooltip: its name (its run id without one), current phase, counts and summary. */
export function roomTitle(room: MeetingRoom): string {
  const bits = [room.name ?? room.runId];
  const phase = currentPhase(room);
  if (phase !== null) bits.push(phase);
  bits.push(countsText(room));
  if (room.summary !== null) bits.push(room.summary);
  return bits.join(' · ');
}

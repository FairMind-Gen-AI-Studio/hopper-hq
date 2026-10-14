/**
 * The floor's HTML labels, laid over the canvas: one tag per session at a desk (state dot, name, "needs you", running
 * agents, remote), hanging over its robot wherever it is; one placard per pod that has one (repo, branch); and per
 * meeting room a tag (name, current phase, counts) over its door and a board (phases, counts) over its whiteboard. Built
 * with createElement and textContent only: names, repos, branches, run names and phases come from transcripts and stay
 * text. A label hangs from a point of the scene, projected each frame. One tag at a time is in the tab order, the desks'
 * first and the rooms' after them; the arrow keys, Home and End move between the tags on the view.
 *
 * Free desks and dormant sessions' desks have no tag. Seen from far (compact), every tag shows at least its dot and the
 * placards hide; closer, every tag and placard shows whole. At every zoom, where two overlap on the canvas the one that
 * ranks lower hides (design §7.3). A tag hidden so is like one off the view: out of the tab order, and passed by the
 * arrow keys. The floor panel lists every session and room, whatever the view shows.
 */
import { Vector3, type Camera } from 'three';
import { STATE_LABEL } from '../../src/scene/text';
import type { FloorDetail, MeetingRoom, Occupant, PhaseState, Pod, PodDesk, ShownState } from '../../src/scene/types';
import type { Target } from './index';
import { boardAnchor, labelAnchor, placardAnchor, roomKey, roomTagAnchor, sameTarget, type Point3 } from './world';
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

/**
 * Below this many CSS pixels to the metre, the floor is seen from far (compact): desks side by side are 2 m apart, and
 * a tag with a short name is about 70 px wide. A tag shows only its dot, and its name as well when it is selected, its
 * desk needs you or is done, or it names a room (labels.css); the placards and the boards go.
 */
export const COMPACT_PX = 40;

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
}

/** A room's board, over its whiteboard. */
interface Board extends Label {
  readonly target: Target;
}

/** The mark a board draws for each state of a phase, and the word a screen reader reads instead. */
const PHASE: Record<PhaseState, { mark: string; word: string }> = {
  done: { mark: '\u2713', word: 'done' },
  current: { mark: '\u25CF', word: 'current' },
  upcoming: { mark: '\u25CB', word: 'upcoming' },
};

export class LabelLayer {
  /** Desk tags by 'desk <session id>', and room tags by 'room <room key>'. */
  private readonly tags = new Map<string, Tag>();
  /** Pod placards by pod id. */
  private readonly signs = new Map<string, Label>();
  /** Room boards by room key. */
  private readonly boards = new Map<string, Board>();
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
    for (const pod of floor.pods) {
      if (pod.placard) {
        signs.add(pod.id);
        this.syncSign(pod, pod.placard);
      }
      for (const desk of pod.desks) if (desk.occupant && desk.occupant.state !== 'dormant') tags.add(this.syncTag(floor, desk, desk.occupant));
    }
    for (const room of floor.rooms) {
      boards.add(this.syncBoard(room));
      tags.add(this.syncRoomTag(room));
    }
    for (const [key, label] of this.tags) if (!tags.has(key)) this.drop(this.tags, key, label);
    for (const [key, label] of this.signs) if (!signs.has(key)) this.drop(this.signs, key, label);
    for (const [key, label] of this.boards) if (!boards.has(key)) this.drop(this.boards, key, label);
    this.order = [...tags];
    this.signOrder = [...signs];
    this.stale = true;
    this.markSelected();
    this.rove(this.stop);
  }

  /** Marks the selected desk's tag, or the tag of the selected run's first room; null clears. */
  setSelected(target: Target | null): void {
    const changed = !sameTarget(target, this.selected);
    this.selected = target;
    this.stale = true;
    this.markSelected();
    // The tab stop follows a new selection; the same one marked again, as on each floor update, leaves it be.
    if (changed) this.rove(this.selectedKey());
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
   * or ranks or the zoom changed, it works out again which tags and placards are kept where they overlap.
   */
  position(camera: Camera, width: number, height: number): void {
    const labels = [...this.signs.values(), ...this.boards.values(), ...this.tags.values()];
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
      const visible = p.visible && label.kept;
      if (visible !== label.visible) {
        label.el.style.visibility = visible ? '' : 'hidden';
        label.visible = visible;
      }
      // A hidden label on the view moves too, so that it shows in its place once it is kept again.
      if (p.visible && (p.x !== label.x || p.y !== label.y)) {
        label.el.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%, -100%)`;
        label.x = p.x;
        label.y = p.y;
      }
    }
    this.keepStopOnView();
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

  /** The placard of a pod, by its id. */
  sign(podId: string): HTMLElement | undefined {
    return this.signs.get(podId)?.el;
  }

  dispose(): void {
    for (const [key, label] of this.tags) this.drop(this.tags, key, label);
    for (const [key, label] of this.signs) this.drop(this.signs, key, label);
    for (const [key, label] of this.boards) this.drop(this.boards, key, label);
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
    el.addEventListener('click', (e) => this.events.select(target, e.detail));
    el.addEventListener('dblclick', () => this.events.activate(target));
    el.addEventListener('focus', () => this.rove(key));
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && sameTarget(this.selected, target)) {
        e.preventDefault();
        this.events.activate(target);
      } else if (MOVES.includes(e.key)) {
        e.preventDefault();
        this.focusFrom(key, e.key);
      }
    });
    const tag: Tag = { ...this.add(el), target, kind };
    this.tags.set(key, tag);
    return tag;
  }

  /** The tag of the session at a desk, over its robot. Returns the tag's key. */
  private syncTag(floor: FloorDetail, desk: PodDesk, occupant: Occupant): string {
    const key = deskKey(occupant.sessionId);
    const tag = this.button(key, { kind: 'desk', id: occupant.sessionId }, { kind: 'desk', state: occupant.state });
    tag.anchor = labelAnchor(floor, desk, occupant);
    const shows = JSON.stringify([occupant.name, occupant.state, occupant.robot?.badge ?? null, occupant.agentsRunning, occupant.location]);
    if (shows === tag.shows) return key;
    tag.shows = shows;
    const el = tag.el;
    el.className = ['fv-tag', `fv-st-${occupant.state}`, occupant.robot?.badge ? `fv-badge-${occupant.robot.badge}` : ''].filter(Boolean).join(' ');
    mark(el, sameTarget(this.selected, tag.target));
    const parts = [span('fv-dot', ''), span('fv-name', occupant.name)];
    if (occupant.state === 'needs_you') parts.push(span('fv-note', 'needs you'));
    if (occupant.agentsRunning > 0) parts.push(span('fv-agents', `+${occupant.agentsRunning}`));
    if (occupant.location === 'cloud') parts.push(span('fv-remote', 'remote'));
    el.replaceChildren(...parts);
    el.title = tagTitle(occupant);
    return key;
  }

  /** The room's tag over its door: its name (its run id without one), its current phase and its counts. Returns its key. */
  private syncRoomTag(room: MeetingRoom): string {
    const key = `room ${roomKey(room)}`;
    const tag = this.button(key, { kind: 'room', id: room.runId }, { kind: 'room' });
    tag.anchor = roomTagAnchor(room.rect);
    const phase = currentPhase(room);
    const shows = JSON.stringify([room.name, phase, room.counts, room.summary]);
    if (shows === tag.shows) return key;
    tag.shows = shows;
    const el = tag.el;
    el.className = 'fv-tag fv-room';
    mark(el, sameTarget(this.selected, tag.target));
    const parts = [span('fv-dot', ''), span('fv-name', room.name ?? room.runId)];
    if (phase !== null) parts.push(span('fv-phase', phase));
    parts.push(span('fv-counts', countsText(room)));
    el.replaceChildren(...parts);
    el.title = roomTitle(room);
    return key;
  }

  /**
   * The room's board over its whiteboard: each phase with its mark, and the mark's word for screen readers, then the
   * counts. Returns its key.
   */
  private syncBoard(room: MeetingRoom): string {
    const key = roomKey(room);
    let board = this.boards.get(key);
    if (!board) {
      const el = document.createElement('div');
      el.className = 'fv-board';
      el.dataset.run = room.runId;
      board = { ...this.add(el), target: { kind: 'room', id: room.runId } };
      this.boards.set(key, board);
    }
    board.anchor = boardAnchor(room.rect);
    const shows = JSON.stringify([room.phases, room.counts]);
    if (shows === board.shows) return key;
    board.shows = shows;
    const parts: HTMLElement[] = [];
    if (room.phases.length > 0) {
      const list = document.createElement('ol');
      for (const phase of room.phases) {
        const item = document.createElement('li');
        item.className = `fv-ph-${phase.state}`;
        const sign = span('fv-mark', PHASE[phase.state].mark);
        sign.setAttribute('aria-hidden', 'true');
        item.append(sign, document.createTextNode(phase.title), span('fv-sr', ` (${PHASE[phase.state].word})`));
        list.append(item);
      }
      parts.push(list);
    }
    const counts = document.createElement('p');
    counts.textContent = countsText(room);
    parts.push(counts);
    board.el.replaceChildren(...parts);
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
   * that overlap one that ranks higher, or one as high earlier in floor order (desk tags, room tags, then placards). Sizes
   * are read from the page, as the zoom draws them: a compact tag is a dot, or a dot and a name.
   */
  private keep(): void {
    this.stale = false;
    const selected = this.selectedKey();
    const ranked: Array<[Label, number]> = [
      ...this.order.map((key): [Label, number] => {
        const tag = this.tags.get(key)!;
        return [tag, tagRank(tag.kind, key === selected)];
      }),
      ...this.signOrder.map((id): [Label, number] => [this.signs.get(id)!, RANK.placard]),
    ];
    const seen = ranked.filter(([label, rank]) => {
      label.kept = false;
      return label.at!.visible && !(this.compact && rank === RANK.placard);
    });
    const kept = declutter(
      seen.map(([label, rank]) => {
        const w = label.el.offsetWidth;
        const h = label.el.offsetHeight;
        return { x: label.at!.x - w / 2, y: label.at!.y - h, w, h, rank };
      }),
    );
    seen.forEach(([label], i) => (label.kept = kept[i]!));
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
    if (had) this.tags.get(next)!.el.focus();
  }

  /** Focuses the tag a key leads to from this one, among the tags on the view, in floor order. */
  private focusFrom(key: string, move: string): void {
    const shown = this.order.filter((k) => this.tags.get(k)?.visible);
    const at = shown.indexOf(key);
    const to = move === 'Home' ? 0 : move === 'End' ? shown.length - 1 : at + (move === 'ArrowRight' || move === 'ArrowDown' ? 1 : -1);
    const next = shown[Math.max(0, Math.min(shown.length - 1, to))];
    if (next !== undefined) this.tags.get(next)!.el.focus();
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

/** The tag's tooltip: name, state, running agents, remote. */
export function tagTitle(o: Pick<Occupant, 'name' | 'state' | 'agentsRunning' | 'location'>): string {
  const bits = [o.name, STATE_LABEL[o.state]];
  if (o.agentsRunning > 0) bits.push(`${o.agentsRunning} ${o.agentsRunning === 1 ? 'agent' : 'agents'} running`);
  if (o.location === 'cloud') bits.push('remote');
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

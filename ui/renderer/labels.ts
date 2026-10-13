/**
 * The floor's HTML labels, laid over the canvas: one tag per desk (state dot, name, "needs you", running agents,
 * remote), one placard per island (repo, branch), and per meeting room a tag (name, current phase, counts) over its
 * door and a board (phases, counts) over its whiteboard. Built with createElement and textContent only: names, repos,
 * branches, run names and phases come from transcripts and stay text. A label hangs from a point of the scene,
 * projected each frame. One tag at a time is in the tab order, the desks' first and the rooms' after them; the arrow
 * keys, Home and End move between the tags on the view.
 */
import { Vector3, type Camera } from 'three';
import { STATE_LABEL } from '../../src/scene/text';
import type { Desk, FloorDetail, Island, MeetingRoom, PhaseState } from '../../src/scene/types';
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
 * Below this many CSS pixels to the metre, tags show only their dot (labels.css): desks side by side are 2 m apart,
 * and a tag with a short name is about 70 px wide. Room tags keep their name, and the boards go.
 */
export const COMPACT_PX = 40;

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
  x: number;
  y: number;
  visible: boolean;
}

/** A desk's or a room's tag, or a room's board: a label for a target. */
interface Tag extends Label {
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
  private readonly signs = new Map<string, Label>();
  /** Room boards by room key. */
  private readonly boards = new Map<string, Tag>();
  private selected: Target | null = null;
  /** The tags in floor order, the desks' first and the rooms' after them, and the one in the tab order. */
  private order: string[] = [];
  private stop: string | null = null;
  private compact = false;
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
    for (const island of floor.islands) {
      signs.add(island.key);
      this.syncSign(island);
      for (const desk of island.desks) tags.add(this.syncTag(desk));
    }
    for (const room of floor.rooms) {
      boards.add(this.syncBoard(room));
      tags.add(this.syncRoomTag(room));
    }
    for (const [key, label] of this.tags) if (!tags.has(key)) this.drop(this.tags, key, label);
    for (const [key, label] of this.signs) if (!signs.has(key)) this.drop(this.signs, key, label);
    for (const [key, label] of this.boards) if (!boards.has(key)) this.drop(this.boards, key, label);
    this.order = [...tags];
    this.rove(this.stop);
  }

  /** Marks the selected desk's tag, or the tags of the selected run's rooms; null clears. */
  setSelected(target: Target | null): void {
    const changed = !sameTarget(target, this.selected);
    this.selected = target;
    for (const tag of this.tags.values()) mark(tag.el, sameTarget(tag.target, target));
    // The tab stop follows a new selection; the same one marked again, as on each floor update, leaves it be.
    if (changed) this.rove(this.selectedKey());
  }

  /** How many CSS pixels a metre takes on screen. Below COMPACT_PX, tags show only their dot. */
  setScale(pxPerMetre: number): void {
    const compact = pxPerMetre < COMPACT_PX;
    if (compact === this.compact) return;
    this.compact = compact;
    this.root.classList.toggle('fv-compact', compact);
  }

  /** Moves every label to its anchor's place on the canvas, hiding those off the view. */
  position(camera: Camera, width: number, height: number): void {
    for (const label of [...this.signs.values(), ...this.boards.values(), ...this.tags.values()]) {
      const p = projectToScreen(label.anchor, camera, width, height, this.v);
      if (p.visible !== label.visible) {
        label.el.style.visibility = p.visible ? '' : 'hidden';
        label.visible = p.visible;
      }
      if (p.visible && (p.x !== label.x || p.y !== label.y)) {
        label.el.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%, -100%)`;
        label.x = p.x;
        label.y = p.y;
      }
    }
    this.keepStopOnView();
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

  sign(islandKey: string): HTMLElement | undefined {
    return this.signs.get(islandKey)?.el;
  }

  dispose(): void {
    for (const [key, label] of this.tags) this.drop(this.tags, key, label);
    for (const [key, label] of this.signs) this.drop(this.signs, key, label);
    for (const [key, label] of this.boards) this.drop(this.boards, key, label);
    this.root.classList.remove('fv-labels', 'fv-compact');
  }

  /** The tag of a desk or a room: made once, as a button that selects and activates its target. */
  private button(key: string, target: Target): Tag {
    const had = this.tags.get(key);
    if (had) return had;
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
    const tag: Tag = { ...this.add(el), target };
    this.tags.set(key, tag);
    return tag;
  }

  /** Returns the tag's key. */
  private syncTag(desk: Desk): string {
    const key = deskKey(desk.sessionId);
    const tag = this.button(key, { kind: 'desk', id: desk.sessionId });
    tag.anchor = labelAnchor(desk);
    const shows = JSON.stringify([desk.name, desk.state, desk.robot?.badge ?? null, desk.agentsRunning, desk.location]);
    if (shows === tag.shows) return key;
    tag.shows = shows;
    const el = tag.el;
    el.className = ['fv-tag', `fv-st-${desk.state}`, desk.robot?.badge ? `fv-badge-${desk.robot.badge}` : ''].filter(Boolean).join(' ');
    mark(el, sameTarget(this.selected, tag.target));
    const parts = [span('fv-dot', ''), span('fv-name', desk.name)];
    if (desk.state === 'needs_you') parts.push(span('fv-note', 'needs you'));
    if (desk.agentsRunning > 0) parts.push(span('fv-agents', `+${desk.agentsRunning}`));
    if (desk.location === 'cloud') parts.push(span('fv-remote', 'remote'));
    el.replaceChildren(...parts);
    el.title = tagTitle(desk);
    return key;
  }

  /** The room's tag over its door: its name (its run id without one), its current phase and its counts. Returns its key. */
  private syncRoomTag(room: MeetingRoom): string {
    const key = `room ${roomKey(room)}`;
    const tag = this.button(key, { kind: 'room', id: room.runId });
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

  private syncSign(island: Island): void {
    let label = this.signs.get(island.key);
    if (!label) {
      label = this.add(document.createElement('div'));
      this.signs.set(island.key, label);
    }
    label.anchor = placardAnchor(island.rect);
    const where = (island.branch ?? 'no branch') + (island.worktree ? ' · worktree' : '');
    const shows = JSON.stringify([island.repo, where]);
    if (shows === label.shows) return;
    label.shows = shows;
    label.el.className = 'fv-sign';
    const small = document.createElement('small');
    small.textContent = where;
    label.el.replaceChildren(document.createTextNode(island.repo), small);
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
    return { el, anchor: { x: 0, y: 0, z: 0 }, shows: '', x: NaN, y: NaN, visible: false };
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
export function tagTitle(desk: Desk): string {
  const bits = [desk.name, STATE_LABEL[desk.state]];
  if (desk.agentsRunning > 0) bits.push(`${desk.agentsRunning} ${desk.agentsRunning === 1 ? 'agent' : 'agents'} running`);
  if (desk.location === 'cloud') bits.push('remote');
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

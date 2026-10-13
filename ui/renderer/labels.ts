/**
 * The floor's HTML labels, laid over the canvas: one tag per desk (state dot, name, "needs you", running agents,
 * remote) and one placard per island (repo, branch). Built with createElement and textContent only: names, repos
 * and branches come from transcripts and stay text. A label hangs from a point of the scene, projected each frame.
 * One tag at a time is in the tab order; the arrow keys, Home and End move between the tags on the view.
 */
import { Vector3, type Camera } from 'three';
import { STATE_LABEL } from '../../src/scene/text';
import type { Desk, FloorDetail, Island } from '../../src/scene/types';
import { labelAnchor, placardAnchor, type Point3 } from './world';
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
 * and a tag with a short name is about 70 px wide.
 */
export const COMPACT_PX = 40;

export interface LabelEvents {
  /** `clicks` is the click's place in a series: 2 for the second click of a double-click, 0 from the keyboard. */
  select(sessionId: string, clicks: number): void;
  activate(sessionId: string): void;
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

export class LabelLayer {
  private readonly tags = new Map<string, Label>();
  private readonly signs = new Map<string, Label>();
  private selected: string | null = null;
  /** The desks in floor order, and the one whose tag is in the tab order. */
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
    for (const island of floor.islands) {
      signs.add(island.key);
      this.syncSign(island);
      for (const desk of island.desks) {
        tags.add(desk.sessionId);
        this.syncTag(desk);
      }
    }
    for (const [id, label] of this.tags) if (!tags.has(id)) this.drop(this.tags, id, label);
    for (const [key, label] of this.signs) if (!signs.has(key)) this.drop(this.signs, key, label);
    this.order = [...tags];
    this.rove(this.stop);
  }

  /** Marks the selected desk's tag; null clears. */
  setSelected(sessionId: string | null): void {
    const old = this.selected === null ? undefined : this.tags.get(this.selected);
    if (old) mark(old.el, false);
    const changed = sessionId !== this.selected;
    this.selected = sessionId;
    const now = sessionId === null ? undefined : this.tags.get(sessionId);
    if (now) mark(now.el, true);
    // The tab stop follows a new selection; the same one marked again, as on each floor update, leaves it be.
    if (changed) this.rove(sessionId);
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
    for (const label of [...this.signs.values(), ...this.tags.values()]) {
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
    return this.tags.get(sessionId)?.el;
  }

  sign(islandKey: string): HTMLElement | undefined {
    return this.signs.get(islandKey)?.el;
  }

  dispose(): void {
    for (const [id, label] of this.tags) this.drop(this.tags, id, label);
    for (const [key, label] of this.signs) this.drop(this.signs, key, label);
    this.root.classList.remove('fv-labels', 'fv-compact');
  }

  private syncTag(desk: Desk): void {
    const id = desk.sessionId;
    let label = this.tags.get(id);
    if (!label) {
      const el = document.createElement('button');
      el.type = 'button';
      el.tabIndex = -1;
      el.dataset.session = id;
      el.addEventListener('click', (e) => this.events.select(id, e.detail));
      el.addEventListener('dblclick', () => this.events.activate(id));
      el.addEventListener('focus', () => this.rove(id));
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && this.selected === id) {
          e.preventDefault();
          this.events.activate(id);
        } else if (MOVES.includes(e.key)) {
          e.preventDefault();
          this.focusFrom(id, e.key);
        }
      });
      label = this.add(this.tags, id, el);
    }
    label.anchor = labelAnchor(desk);
    const shows = JSON.stringify([desk.name, desk.state, desk.robot?.badge ?? null, desk.agentsRunning, desk.location]);
    if (shows === label.shows) return;
    label.shows = shows;
    const el = label.el;
    el.className = ['fv-tag', `fv-st-${desk.state}`, desk.robot?.badge ? `fv-badge-${desk.robot.badge}` : ''].filter(Boolean).join(' ');
    mark(el, this.selected === id);
    const parts = [span('fv-dot', ''), span('fv-name', desk.name)];
    if (desk.state === 'needs_you') parts.push(span('fv-note', 'needs you'));
    if (desk.agentsRunning > 0) parts.push(span('fv-agents', `+${desk.agentsRunning}`));
    if (desk.location === 'cloud') parts.push(span('fv-remote', 'remote'));
    el.replaceChildren(...parts);
    el.title = tagTitle(desk);
  }

  private syncSign(island: Island): void {
    let label = this.signs.get(island.key);
    if (!label) label = this.add(this.signs, island.key, document.createElement('div'));
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

  /**
   * Puts one tag in the tab order: `want`'s if it has one, else the one there now, else the selected desk's, else
   * the first.
   */
  private rove(want: string | null): void {
    const next = [want, this.stop, this.selected, this.order[0] ?? null].find((id) => id !== null && this.tags.has(id)) ?? null;
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
      next = [this.order[at - d], this.order[at + d]].find((id) => id !== undefined && this.tags.get(id)?.visible);
    }
    if (next === undefined) {
      if (had) this.events.lostFocus();
      return;
    }
    this.rove(next);
    if (had) this.tags.get(next)!.el.focus();
  }

  /** Focuses the tag a key leads to from this one, among the tags on the view, in floor order. */
  private focusFrom(id: string, key: string): void {
    const shown = this.order.filter((d) => this.tags.get(d)?.visible);
    const at = shown.indexOf(id);
    const to = key === 'Home' ? 0 : key === 'End' ? shown.length - 1 : at + (key === 'ArrowRight' || key === 'ArrowDown' ? 1 : -1);
    const next = shown[Math.max(0, Math.min(shown.length - 1, to))];
    if (next !== undefined) this.tags.get(next)!.el.focus();
  }

  private add(map: Map<string, Label>, key: string, el: HTMLElement): Label {
    el.style.visibility = 'hidden';
    this.root.append(el);
    const label: Label = { el, anchor: { x: 0, y: 0, z: 0 }, shows: '', x: NaN, y: NaN, visible: false };
    map.set(key, label);
    return label;
  }

  private drop(map: Map<string, Label>, key: string, label: Label): void {
    label.el.remove();
    map.delete(key);
  }
}

/** The keys that move the focus between tags. */
const MOVES = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'];

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

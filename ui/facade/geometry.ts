/**
 * The building's façade as isometric SVG geometry: plain data, no DOM. Facade.svelte draws it.
 * Cells: x runs along the front (one window per desk), y is the depth, z is height in pixels.
 * Floors stack bottom-up on a lobby: floor number 1 sits on the lobby, and the scene lists floors top to bottom. Every
 * floor is as wide as the building; past the windows of its plan, it is plain wall, so that a floor shows its size.
 * Same projection and proportions as prototypes/building-mockup.html.
 */
import { LINE_SLOTS } from '../../src/scene/palette';
import type { ActiveLine, FloorSummary, ShownState } from '../../src/scene/types';

export const TW = 64;
export const TH = 32;
/** Depth of the building, in cells. */
export const DEPTH = 3;
export const FLOOR_H = 40;
export const LOBBY_H = 50;
/** The building is as wide as its busiest floor, never narrower than this. */
export const MIN_WIDTH = 6;
/** Room kept right of the label column for a floor's name and metadata. */
export const LABEL_W = 330;
/** The longest floor name that room holds, in characters: a longer one ends in '…', and shows whole on hover. */
export const NAME_MAX = 28;
export const PAD = 24;
/** The smallest scale the façade is drawn at: below it, floor names and counts get too small to read. */
export const MIN_SCALE = 0.8;

export type Point = [number, number];

/** Grid (x, y) at height z -> SVG pixels. */
export function project(x: number, y: number, z = 0): Point {
  return [((x - y) * TW) / 2, ((x + y) * TH) / 2 - z];
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/** An SVG `points` attribute, at a tenth of a pixel. */
export function points(ps: Point[]): string {
  return ps.map(([x, y]) => `${r1(x)},${r1(y)}`).join(' ');
}

/** A box's three visible faces: top, front-left (constant y = y1) and front-right (constant x = x1). */
export interface Box {
  top: string;
  left: string;
  right: string;
}

export function box(x0: number, y0: number, x1: number, y1: number, z0: number, z1: number): Box {
  return {
    top: points([project(x0, y0, z1), project(x1, y0, z1), project(x1, y1, z1), project(x0, y1, z1)]),
    left: points([project(x0, y1, z1), project(x1, y1, z1), project(x1, y1, z0), project(x0, y1, z0)]),
    right: points([project(x1, y0, z1), project(x1, y1, z1), project(x1, y1, z0), project(x1, y0, z0)]),
  };
}

/** A quad on the front-left face (constant y), from x0 to x1 and z0 to z1. */
function onFront(y: number, x0: number, x1: number, z0: number, z1: number): Point[] {
  return [project(x0, y, z1), project(x1, y, z1), project(x1, y, z0), project(x0, y, z0)];
}

/** A quad on the front-right face (constant x). */
function onSide(x: number, y0: number, y1: number, z0: number, z1: number): Point[] {
  return [project(x, y0, z1), project(x, y1, z1), project(x, y1, z0), project(x, y0, z0)];
}

export type Line = [number, number, number, number];

/** A floor's label to the right of the building: a leader line, the number in a circle, the name and its metadata. */
export interface Label {
  leader: Line;
  circle: Point;
  nameAt: Point;
  metaAt: Point;
}

export interface WindowShape {
  /** Null: a free desk, a dark window that leads nowhere. */
  sessionId: string | null;
  state: ShownState | null;
  points: string;
  /** Someone is at the desk and the screen is on. */
  lit: boolean;
}

export interface FacadeFloor {
  key: string;
  number: number;
  plate: Box;
  wall: Box;
  /** One per desk of the floor's plan, in desk index order, left to right. Past them, the floor is plain wall. */
  windows: WindowShape[];
  side: string;
  shutters: boolean;
  /** Slats across every window of the floor's plan when the shutters are down. */
  slats: Line[];
  /** The floor's silhouette, for hover, focus and selection. */
  outline: string;
  label: Label;
}

/**
 * One of the rooftop switchboard's antenna stubs (hq-mcp-switchboard proposal.md §2 "Many parallel calls" / §4
 * Façade), evenly spaced across the slab: `slot` is the same palette index a robot's headset bead is given
 * (src/scene/palette.ts LINE_SLOTS, materials.ts `line(slot)`/theme.ts `--line-N`); Facade.svelte looks it up by
 * `slot` against `BuildingScene.activeLines` to decide which stubs are lit and which carry a `+N` badge — this
 * module stays a pure function of the floors alone, so it needs no scene data to place the (static) stubs.
 */
export interface AntennaStub {
  slot: number;
  line: Line;
}

/**
 * The rooftop switchboard's own name plaque (Phase 4 — user feedback 2026-10-19, "ora sono antenne ma non si
 * capisce a cosa servono", "now they're antennas but it's not clear what they're for"): a short post standing at
 * the front-left of the roof, clear of every stub (`stubs` start at x≈1, below), the left AC unit (0.6–1.9) and
 * the mast (the building's own far right). Static, like the stubs/mast themselves — `Facade.svelte` alone decides
 * how brightly it reads, from `BuildingScene.activeLines` at render time.
 */
export interface RoofPlaque {
  post: Line;
  /** The post's own top: where Facade.svelte centres the plaque's text, growing upward from here. */
  labelAt: Point;
}

/** One drawing primitive of a known-server glyph (`GLYPHS`): plain data, no DOM — `Facade.svelte` renders each kind. */
export type GlyphPart =
  | { kind: 'path'; d: string }
  | { kind: 'line'; x1: number; y1: number; x2: number; y2: number }
  | { kind: 'circle'; cx: number; cy: number; r: number };

/**
 * The eight MCP servers the rooftop switchboard traces a one-glyph sign for (hq-mcp-switchboard proposal.md §5
 * Phase 2 / §7 Q4; user-decisions.md Q4 — "the eight observed this session"). Every other server falls back to
 * its line colour and the first letter of its name instead (Facade.svelte's `sign` snippet) — the same "bounded
 * palette, DOM chip stays authoritative" limit the line *colour* slots already accepted (proposal.md §6).
 */
export type GlyphKey = 'notion' | 'slack' | 'memory' | 'mongodb' | 'playwright' | 'google-sheets' | 'clickup' | 'chrome';

/** The local square (SVG user units, origin top-left) every `GLYPHS` entry is drawn in, before `Facade.svelte` scales and centres it over an antenna stub's tip. */
export const GLYPH_BOX = 16;

/**
 * Each glyph is a handful of plain strokes in a `GLYPH_BOX`-square box — traced, not photographed (proposal.md §5
 * "SVG paths, no images"): Notion an "N", Slack a hash, memory three linked nodes, MongoDB a leaf, Playwright a
 * masked shield, Google Sheets a grid, ClickUp a stacked chevron, Chrome a three-spoke pinwheel. Single-colour by
 * design (`currentColor` in `Facade.svelte`, recoloured per the stub's own line token) — no gradients, no fills
 * that would need a second theme-aware colour.
 */
export const GLYPHS: Readonly<Record<GlyphKey, readonly GlyphPart[]>> = {
  notion: [{ kind: 'path', d: 'M3,3 V13 M3,3 L13,13 M13,3 V13' }],
  slack: [{ kind: 'path', d: 'M5,2 V14 M11,2 V14 M2,6 H14 M2,10 H14' }],
  memory: [
    { kind: 'line', x1: 8, y1: 3.5, x2: 3.5, y2: 12.3 },
    { kind: 'line', x1: 8, y1: 3.5, x2: 12.5, y2: 12.3 },
    { kind: 'line', x1: 3.5, y1: 12.3, x2: 12.5, y2: 12.3 },
    // Node radius clearly past the edge lines' own stroke width, so each corner reads as a distinct linked node —
    // not just a sharper triangle vertex (easy to mistake for Playwright's own silhouette otherwise).
    { kind: 'circle', cx: 8, cy: 3, r: 2 },
    { kind: 'circle', cx: 3, cy: 13, r: 2 },
    { kind: 'circle', cx: 13, cy: 13, r: 2 },
  ],
  mongodb: [{ kind: 'path', d: 'M8,2 C12,4.5 12,10.5 8,14 C4,10.5 4,4.5 8,2 Z M8,4.5 V12' }],
  playwright: [
    { kind: 'path', d: 'M8,2 L13,4.3 V9 C13,12 10.5,13.7 8,14.3 C5.5,13.7 3,12 3,9 V4.3 Z' },
    { kind: 'circle', cx: 6, cy: 8, r: 0.9 },
    { kind: 'circle', cx: 10, cy: 8, r: 0.9 },
  ],
  'google-sheets': [{ kind: 'path', d: 'M2,2 H14 V14 H2 Z M8,2 V14 M2,8 H14' }],
  clickup: [{ kind: 'path', d: 'M3,10 L8,6 L13,10 M3,13.5 L8,9.5 L13,13.5' }],
  chrome: [
    { kind: 'path', d: 'M2,8 A6,6 0 1 1 14,8 A6,6 0 1 1 2,8' },
    { kind: 'line', x1: 8, y1: 8, x2: 8, y2: 14 },
    { kind: 'line', x1: 8, y1: 8, x2: 2.8, y2: 5 },
    { kind: 'line', x1: 8, y1: 8, x2: 13.2, y2: 5 },
    { kind: 'circle', cx: 8, cy: 8, r: 1.6 },
  ],
};

/** `server` stripped to bare lowercase letters/digits, so 'Google Sheets', 'GoogleSheets' and 'google-sheets' (the real tool-name spelling, `classifyMcp`'s `server` token, and this table's own key) all resolve to one glyph. */
function normalize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

const GLYPH_BY_NORMAL: ReadonlyMap<string, GlyphKey> = new Map((Object.keys(GLYPHS) as GlyphKey[]).map((k) => [normalize(k), k] as const));

/**
 * The known-server glyph an active line's `server` name (`ActiveLine.server`, `classifyMcp`'s canonical token)
 * picks, or null for every server outside the eight `GLYPHS` names — `Facade.svelte` signs those with the line's
 * own colour and the first letter of `server` instead. Matching is on the normalised name alone, the same
 * case/punctuation leniency `classifyMcp`'s own canonical-server resolver already established for the Fairmind
 * identity, so 'Google Sheets' and 'GoogleSheets' never silently split into two different signs.
 */
export function glyphKeyOf(server: string): GlyphKey | null {
  return GLYPH_BY_NORMAL.get(normalize(server)) ?? null;
}

/**
 * The rooftop mast's own per-family sign letter (hq-mcp-switchboard proposal.md §5 Phase 3; `ActiveLine.family`,
 * SCENE_VERSION 9): one letter per of `classifyMcp`'s five Fairmind families, `'FM'` — the house's own initials —
 * for a family:null Fairmind line (`bulk_update_status`, `process_journal`, every call outside the five prefixes),
 * the "sensible default form" the mast falls back to exactly as the floor's own headset bead does
 * (`fairmind-forms.ts` `fairmindFormOf`). Never used for a non-Fairmind line — those read a known-server glyph or
 * the server's own first letter instead (`glyphKeyOf` above); the mast is the Fairmind identity's own exclusive
 * sign, never shared with a regular antenna stub (Facade.svelte's own `lines`/`activeBySlot` filter).
 */
export const FAMILY_SIGN: Readonly<Record<string, string>> = { Studio: 'S', General: 'G', Brain: 'B', Insights: 'I', Code: 'C' };

/** The mast's own sign letter(s) for a Fairmind line's `family` — one of `FAMILY_SIGN`, or `'FM'` past it. */
export function familySignOf(family: string | null): string {
  return (family !== null && family in FAMILY_SIGN ? FAMILY_SIGN[family] : undefined) ?? 'FM';
}

/** A readable text tag next to one lit antenna (`layoutAntennaTags`), its own leader pointing back at the stub's
 * (or the mast's) tip. Plain data — `Facade.svelte` draws the leader and the text alone; the text itself is
 * `ui/lib/words.ts`'s own `antennaTag`, already applied before this module ever sees it (geometry.ts stays wording-
 * free, the same split `Label`/`floorLabel` already keep for a floor's own label). */
export interface AntennaTag {
  slot: number;
  fairmind: boolean;
  text: string;
  tipX: number;
  tipY: number;
  x: number;
  y: number;
  /** DOM-free layout estimate of the text's own half-width (`TAG_CHAR_PX`); not a real glyph measurement. */
  halfWidth: number;
}

/** The rooftop's own '+k' summary, past `TAG_MAX` lit lines (`layoutAntennaTags`) — never a silently dropped line, a
 * count past what fits. No leader: it summarises more than one line, not one antenna's own tip. */
export interface AntennaOverflow {
  x: number;
  y: number;
  halfWidth: number;
  text: string;
}

export interface AntennaTagLayout {
  tags: AntennaTag[];
  overflow: AntennaOverflow | null;
  /** The highest y any tag (or the overflow tag) reaches — every antenna's own hover/focus tooltip anchors above
   * this one shared height (`Facade.svelte`'s `callTip`), not its own tip: a tooltip positioned relative to its
   * own tip alone collided with a *neighbouring* antenna's own tag when the two sat close together (found
   * screenshotting the real demo: focusing the Playwright antenna on slot 5 showed its tooltip landing right on
   * top of slot 6's own "Slack" tag) — the same shared-baseline fix `layoutAntennaTags`'s own lane stacking
   * already needed for the identical reason.
   */
  topY: number;
}

/** Chars → px, for laying rooftop tags out without ever measuring a real glyph (geometry.ts stays DOM-free) — the
 * same character-budget spirit `NAME_MAX` already accepts for a floor's own name. Matches `Facade.svelte`'s own
 * `.tag-name` font closely enough that the deterministic layout below never under-estimates a real collision. */
const TAG_CHAR_PX = 6.6;
/** Horizontal clearance kept between two tags' own estimated boxes, same lane or not. */
const TAG_GAP_PX = 10;
/** Px a tag is lifted above its own tip before any further per-lane stacking — clear of a lit stub's own busiest-
 * line `+N` badge (Facade.svelte's `.stub-badge`, fixed at tip - 16), so the two never overlap on the one line both
 * can appear on at once. */
const TAG_LIFT_PX = 32;
/** Px a stacked tag is lifted per lane past the first, into its own row above the last. */
export const TAG_LANE_PX = 16;
/** Lit lines shown their own tag before the rest collapse into one '+k' summary (requirement: "show the top N and
 * +k"): the Fairmind line first (the brand, always shown while lit), then the busiest, so a building with every
 * line lit still reads at a glance instead of thinning every tag down to fit all of them. */
export const TAG_MAX = 4;
/** Clearance a tag's own right edge keeps from the floor label column's own left edge (`FacadeModel.labelX`). */
const TAG_LABEL_MARGIN = 16;
/** Chars → px for the hover/focus tooltip's own font (`Facade.svelte`'s `.call-tip`, `--font-mono`) — the same
 * DOM-free character-budget approach `TAG_CHAR_PX` already takes for a tag's own display font. */
const TIP_CHAR_PX = 5.8;
/** Clearance the tooltip's own left edge keeps from the rooftop plaque's own text — generous on purpose: a
 * character-budget estimate of a *different* element's own (smaller, different-font) text is inherently rougher
 * than estimating a tag in its own font, so this keeps real headroom rather than cutting it close. */
const TIP_PLAQUE_MARGIN = 30;
/** The plaque's own widest line ('Switchboard'; `RoofPlaque`), generously estimated (not `TAG_CHAR_PX`'s own
 * per-character budget, calibrated for a different, larger font) so the tooltip clamp below keeps real clearance
 * from the plaque's own right edge, not just its anchor point. */
const PLAQUE_HALF_WIDTH = 55;
/** Worst-case px `layoutAntennaTags` could ever lift a tag above its tip (`TAG_MAX` lanes, the '+k' row past them)
 * and the widest realistic tag's own half-width ('FairMind · Insights ×9', comfortably past any real name) —
 * `facadeOf` reserves this much room in its own viewBox so the (dynamic, scene-fed) tags this module places at
 * render time are never clipped, without this module needing the real, live `activeLines` itself. */
export const TAG_RESERVE_H = TAG_LIFT_PX + TAG_MAX * TAG_LANE_PX;
export const TAG_RESERVE_W = 170;

/**
 * Places a readable text tag next to every lit antenna (hq-mcp-switchboard Phase 4 — requirement 1, user feedback
 * 2026-10-19 "ora sono antenne ma non si capisce a cosa servono"): a tag's tip is its own stub's, or the mast's
 * for the Fairmind line. Tags are swept left to right and stacked into a higher lane whenever the next one's own
 * estimated box would otherwise overlap the last tag placed in its lane — the same idea a timeline's own label-
 * collision pass takes, done here without measuring a real glyph (`TAG_CHAR_PX`). Capped at `TAG_MAX` lines,
 * prioritised Fairmind-first then busiest-first, so a fully-lit building still reads at a glance; the rest
 * collapse into one `overflow` tag ('+k more'), never silently dropped. Every tag (and the overflow tag) is
 * clamped left of `labelX` minus `TAG_LABEL_MARGIN`, so a tag can never reach into the floor label column on the
 * building's own right (`Facade.svelte`'s `label` snippet) — the other half of requirement 1's "don't overlap
 * each other or floor labels".
 */
export function layoutAntennaTags<L extends Pick<ActiveLine, 'slot' | 'fairmind' | 'count'>>(
  stubs: readonly AntennaStub[],
  mast: Line,
  labelX: number,
  lines: readonly L[],
  textOf: (line: L) => string,
): AntennaTagLayout {
  const tipOf = (l: Pick<ActiveLine, 'slot' | 'fairmind'>): Point => {
    if (l.fairmind) return [mast[2], mast[3]];
    const stub = stubs.find((s) => s.slot === l.slot);
    return stub ? [stub.line[2], stub.line[3]] : [mast[2], mast[3]];
  };
  const priority = [...lines].sort((a, b) => Number(b.fairmind) - Number(a.fairmind) || b.count - a.count || a.slot - b.slot);
  const shown = priority.slice(0, TAG_MAX);
  const hidden = priority.slice(TAG_MAX);

  const withTip = shown
    .map((l) => {
      const [tipX, tipY] = tipOf(l);
      const text = textOf(l);
      return { l, tipX, tipY, text, halfWidth: (text.length * TAG_CHAR_PX) / 2 };
    })
    .sort((a, b) => a.tipX - b.tipX);

  // Every lane sits at one shared height, not each tag's own tip lifted by the same amount: two adjacent stubs'
  // own tips already sit at slightly different heights (the isometric projection's own x-skew), so a per-tip lift
  // put two tags bumped into "different" lanes back within a few px of each other instead of the clear
  // `TAG_LANE_PX` gap a lane bump is meant to guarantee — found exactly this way, screenshotting the real demo
  // (Playwright + Slack, adjacent slots 5/6: lane 0 and lane 1 landed 3.2px apart, not 16, because stub 6's own tip
  // sits higher than stub 5's). `topTipY` (the highest/smallest of every shown tip) is always at or above every
  // tag's own tip, so lane 0 here still clears every stub's own `+N` badge (`Facade.svelte`, fixed at tip - 16)
  // even more comfortably than a per-tip lift did.
  const topTipY = Math.min(...withTip.map((t) => t.tipY));
  const laneRight: number[] = [];
  const tags: AntennaTag[] = withTip.map((t) => {
    const x = Math.min(t.tipX, labelX - TAG_LABEL_MARGIN - t.halfWidth);
    let lane = 0;
    while (lane < laneRight.length && x - t.halfWidth < laneRight[lane]! + TAG_GAP_PX) lane++;
    laneRight[lane] = x + t.halfWidth;
    return { slot: t.l.slot, fairmind: t.l.fairmind, text: t.text, tipX: t.tipX, tipY: t.tipY, x, y: topTipY - TAG_LIFT_PX - lane * TAG_LANE_PX, halfWidth: t.halfWidth };
  });

  const tagsTopY = tags.length > 0 ? Math.min(...tags.map((t) => t.y)) : topTipY - TAG_LIFT_PX;
  if (hidden.length === 0) return { tags, overflow: null, topY: tagsTopY };
  const text = `+${hidden.length} more`;
  const halfWidth = (text.length * TAG_CHAR_PX) / 2;
  const avgTipX = hidden.reduce((sum, l) => sum + tipOf(l)[0], 0) / hidden.length;
  const x = Math.min(avgTipX, labelX - TAG_LABEL_MARGIN - halfWidth);
  const overflowY = tagsTopY - TAG_LANE_PX;
  return { tags, overflow: { x, y: overflowY, halfWidth, text }, topY: overflowY };
}

export interface TooltipAnchor {
  x: number;
  halfWidth: number;
  /** `text`, verbatim, or shortened with an ellipsis when the room between the plaque and the floor label column
   * is narrower than the text itself needs — see below. */
  text: string;
}

/** The least room (px) `tooltipAnchor` ever tries to fit a tooltip into before giving up truncating further and
 * just centring whatever is left on the antenna's own tip — a pathologically narrow building only, never a real
 * one (`MIN_WIDTH` alone already clears this by a wide margin). */
const TIP_MIN_ROOM = 24;

/**
 * Where a lit antenna's own hover/focus tooltip centres (requirement 3), text-anchor middle like a tag: nudged
 * right of the rooftop plaque's own text, clamped left of the floor label column — the same `labelX` bound
 * `layoutAntennaTags` already respects. Unlike a tag, this text's own length is effectively unbounded
 * (`ActiveLine.caller`/`.tool` are free text up to `tool-label.ts`'s own 80-character cap each), so clamping
 * alone cannot always guarantee both boundaries hold at once — on a narrow building a long enough tooltip
 * genuinely has nowhere left that clears both. Rather than pick one boundary to silently violate, the tooltip
 * is shortened (with a trailing '…') to whatever room actually exists between the plaque and the label column,
 * the same "never block the building's own directory, never cover the plaque's own static sign" guarantee a tag
 * already gets via `TAG_MAX`'s own "+k" summary — a long tooltip gives way the same way a crowded roof's tags do,
 * rather than overlapping either.
 *
 * Found live, not by inspection: screenshotting the real demo repeatedly showed the Fairmind mast's own tooltip —
 * centred on the mast, the roof's own rightmost point, but carrying the longest realistic text (a long caller
 * label plus a long tool verb) — reading over the plaque's static "MCP / Switchboard" text at the roof's own left
 * end; widening the plaque's own clearance alone did not fix it, because the floor label column was the binding
 * constraint, not the plaque — the room between the two was simply narrower than the text.
 */
export function tooltipAnchor(tipX: number, text: string, labelX: number, plaqueX: number): TooltipAnchor {
  const plaqueRight = plaqueX + PLAQUE_HALF_WIDTH + TIP_PLAQUE_MARGIN;
  const labelLeft = labelX - TAG_LABEL_MARGIN;
  const room = Math.max(TIP_MIN_ROOM, labelLeft - plaqueRight);
  let shown = text;
  let halfWidth = (shown.length * TIP_CHAR_PX) / 2;
  if (2 * halfWidth > room) {
    const maxChars = Math.max(1, Math.floor(room / TIP_CHAR_PX) - 1);
    shown = text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
    halfWidth = (shown.length * TIP_CHAR_PX) / 2;
  }
  const clearOfPlaque = Math.max(tipX, plaqueRight + halfWidth);
  const x = Math.min(clearOfPlaque, labelLeft - halfWidth);
  return { x, halfWidth, text: shown };
}

export interface FacadeModel {
  viewBox: string;
  /** The viewBox's width and height. */
  size: { width: number; height: number };
  /** Windows per floor. */
  width: number;
  /** Where the floor label column starts (its leader lines run up to this x): `layoutAntennaTags` clamps every
   * rooftop tag clear of it, so a tag can never reach into a floor's own name. */
  labelX: number;
  shadow: { cx: number; cy: number; rx: number; ry: number };
  plinth: Box;
  lobby: { wall: Box; windows: string[]; doors: string[]; side: string; label: Label };
  /** Bottom-up, the order they are drawn in. */
  floors: FacadeFloor[];
  roof: { slab: Box; units: Box[]; mast: Line; stubs: AntennaStub[]; plaque: RoofPlaque };
}

const LIT: ReadonlySet<ShownState> = new Set(['working', 'needs_you', 'done', 'in_meeting', 'no_signal']);

/** Grows a bounding box over everything drawn, so the viewBox frames the whole model. */
class Bounds {
  x0 = Infinity;
  y0 = Infinity;
  x1 = -Infinity;
  y1 = -Infinity;
  add([x, y]: Point): Point {
    this.x0 = Math.min(this.x0, x);
    this.y0 = Math.min(this.y0, y);
    this.x1 = Math.max(this.x1, x);
    this.y1 = Math.max(this.y1, y);
    return [x, y];
  }
  box(x0: number, y0: number, x1: number, y1: number, z0: number, z1: number): Box {
    for (const x of [x0, x1]) for (const y of [y0, y1]) for (const z of [z0, z1]) this.add(project(x, y, z));
    return box(x0, y0, x1, y1, z0, z1);
  }
}

function labelAt(b: Bounds, anchor: Point, labelX: number, hasMeta: boolean): Label {
  const [ax, ay] = anchor;
  b.add([labelX + LABEL_W, ay - 20]);
  b.add([labelX, ay + 20]);
  return {
    leader: [r1(ax + 4), r1(ay), r1(labelX - 6), r1(ay)],
    circle: [r1(labelX + 11), r1(ay)],
    nameAt: [r1(labelX + 32), r1(hasMeta ? ay - 2 : ay + 5)],
    metaAt: [r1(labelX + 32), r1(ay + 13)],
  };
}

/** The whole building for the scene's floors, listed top to bottom as the scene lists them. */
export function facadeOf(floors: readonly FloorSummary[]): FacadeModel {
  const b = new Bounds();
  const W = Math.max(MIN_WIDTH, ...floors.map((f) => f.windows.length));
  const D = DEPTH;
  const labelX = (W * TW) / 2 + 40;

  const plinth = b.box(-0.4, -0.4, W + 0.4, D + 0.4, -6, 0);
  const lobbyWall = b.box(0, 0, W, D, 0, LOBBY_H);
  const doorAt = Math.floor(W / 2) - 1;
  const doors: string[] = [];
  const lobbyWindows: string[] = [];
  for (let i = 0; i < W; i++) {
    if (i === doorAt || i === doorAt + 1) doors.push(points(onFront(D, i + 0.08, i + 0.92, 0, LOBBY_H - 14)));
    else lobbyWindows.push(points(onFront(D, i + 0.15, i + 0.85, 14, LOBBY_H - 10)));
  }
  const lobby = {
    wall: lobbyWall,
    windows: lobbyWindows,
    doors,
    side: points(onSide(W, 0.3, D - 0.3, 14, LOBBY_H - 10)),
    label: labelAt(b, project(W, 0, LOBBY_H / 2), labelX, false),
  };

  const stacked: FacadeFloor[] = [];
  for (let j = 0; j < floors.length; j++) {
    const f = floors[floors.length - 1 - j]!;
    const z0 = LOBBY_H + j * FLOOR_H;
    const windows: WindowShape[] = [];
    const slats: Line[] = [];
    for (let i = 0; i < f.windows.length; i++) {
      const w = f.windows[i]!;
      windows.push({ sessionId: w.sessionId, state: w.state, points: points(onFront(D, i + 0.18, i + 0.82, z0 + 13, z0 + FLOOR_H - 6)), lit: w.state !== null && LIT.has(w.state) });
      if (f.shutters) {
        for (let k = 1; k < 4; k++) {
          const z = z0 + 13 + (k * (FLOOR_H - 19)) / 4;
          const [ax, ay] = project(i + 0.18, D, z);
          const [bx, by] = project(i + 0.82, D, z);
          slats.push([r1(ax), r1(ay), r1(bx), r1(by)]);
        }
      }
    }
    stacked.push({
      key: f.key,
      number: f.number,
      plate: b.box(-0.08, -0.08, W + 0.08, D + 0.08, z0, z0 + 4),
      wall: b.box(0, 0, W, D, z0 + 4, z0 + FLOOR_H),
      windows,
      side: points(onSide(W, 0.35, D - 0.35, z0 + 13, z0 + FLOOR_H - 6)),
      shutters: f.shutters,
      slats,
      outline: points([project(0, D, z0 + FLOOR_H), project(0, D, z0), project(W, D, z0), project(W, 0, z0), project(W, 0, z0 + FLOOR_H), project(W, D, z0 + FLOOR_H)]),
      label: labelAt(b, project(W, 0, z0 + FLOOR_H / 2 + 2), labelX, true),
    });
  }

  const zr = LOBBY_H + floors.length * FLOOR_H;
  const slab = b.box(-0.12, -0.12, W + 0.12, D + 0.12, zr, zr + 6);
  const units = [b.box(0.6, 0.5, 1.9, 1.7, zr + 6, zr + 22), b.box(W - 2.3, 0.7, W - 1.1, 1.9, zr + 6, zr + 16)];
  const [m0x, m0y] = b.add(project(W - 0.5, 0.5, zr + 6));
  const [m1x, m1y] = b.add(project(W - 0.5, 0.5, zr + 46));
  // One antenna stub per line slot, evenly spaced across the slab, dark until Facade.svelte lights the ones
  // BuildingScene.activeLines names; a fixed footprint (not derived from the floors) so it never reflows as calls
  // come and go.
  const stubs: AntennaStub[] = Array.from({ length: LINE_SLOTS }, (_, slot) => {
    const x = 0.8 + ((slot + 0.5) * (W - 1.6)) / LINE_SLOTS;
    const [x0, y0] = b.add(project(x, 0.5, zr + 6));
    const [x1, y1] = b.add(project(x, 0.5, zr + 18));
    return { slot, line: [r1(x0), r1(y0), r1(x1), r1(y1)] };
  });

  // The switchboard's own name plaque (Phase 4): a short post at the roof's own front-left, left of both the left
  // AC unit (0.6–1.9) and the leftmost stub (>= 0.8), so it never collides with either whatever W is.
  const [pl0x, pl0y] = b.add(project(0.3, 0.5, zr + 6));
  const [pl1x, pl1y] = b.add(project(0.3, 0.5, zr + 24));
  const plaque: RoofPlaque = { post: [r1(pl0x), r1(pl0y), r1(pl1x), r1(pl1y)], labelAt: [r1(pl1x), r1(pl1y)] };

  // Reserves room for Phase 4's own antenna tags/overflow (layoutAntennaTags) above the stub row and the mast: this
  // module stays a pure function of the floors alone (no live activeLines), so it reserves the worst case the
  // layout could ever reach rather than measuring the real, dynamic tags Facade.svelte places at render time.
  b.add([m0x - TAG_RESERVE_W, m1y - TAG_RESERVE_H]);
  b.add([stubs[0]!.line[0] - TAG_RESERVE_W, stubs[0]!.line[1] - TAG_RESERVE_H]);

  const [cx, cy] = project(W / 2, D / 2, -14);
  const shadow = { cx: r1(cx), cy: r1(cy + 10), rx: r1((W + D) * 19), ry: r1((W + D) * 8) };
  b.add([shadow.cx - shadow.rx, shadow.cy - shadow.ry]);
  b.add([shadow.cx + shadow.rx, shadow.cy + shadow.ry]);

  const [x, y, width, height] = [b.x0 - PAD, b.y0 - PAD, b.x1 - b.x0 + 2 * PAD, b.y1 - b.y0 + 2 * PAD].map(r1) as [number, number, number, number];
  return {
    viewBox: `${x} ${y} ${width} ${height}`,
    size: { width, height },
    width: W,
    labelX,
    shadow,
    plinth,
    lobby,
    floors: stacked,
    roof: { slab, units, mast: [r1(m0x), r1(m0y), r1(m1x), r1(m1y)], stubs, plaque },
  };
}

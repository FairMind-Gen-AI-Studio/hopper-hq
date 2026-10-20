import { describe, expect, it } from 'vitest';
import { LINE_SLOTS } from '../../../src/scene/palette';
import type { ActiveLine, FloorSummary } from '../../../src/scene/types';
import {
  FLOOR_H,
  GLYPHS,
  LABEL_W,
  LOBBY_H,
  TAG_LANE_PX,
  TAG_MAX,
  TW,
  box,
  facadeOf,
  familySignOf,
  glyphKeyOf,
  layoutAntennaTags,
  points,
  project,
  tooltipAnchor,
  type FacadeModel,
  type GlyphKey,
} from '../../facade/geometry';
import { makeScene } from '../helpers/fixtures';

/** Every x,y pair the model draws, from points strings and lines. */
function everyPoint(m: FacadeModel): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const walk = (v: unknown): void => {
    if (typeof v === 'string' && /^-?\d/.test(v)) for (const p of v.split(' ')) out.push(p.split(',').map(Number) as [number, number]);
    else if (Array.isArray(v) && v.length === 4 && v.every((n) => typeof n === 'number')) {
      const [x1, y1, x2, y2] = v as [number, number, number, number];
      out.push([x1, y1], [x2, y2]);
    }
    else if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x);
  };
  walk({ plinth: m.plinth, lobby: m.lobby, floors: m.floors, roof: m.roof });
  return out;
}

function floorWith(n: number, overrides: Partial<FloorSummary> = {}): FloorSummary {
  const f = makeScene().floors[0]!;
  return { ...f, windows: Array.from({ length: n }, (_, i) => ({ sessionId: `s${i}`, state: 'working' as const })), ...overrides };
}

describe('façade geometry', () => {
  it('projects the grid isometrically, height going up the page', () => {
    expect(project(0, 0)).toEqual([0, 0]);
    expect(project(1, 0)).toEqual([32, 16]);
    expect(project(0, 1)).toEqual([-32, 16]);
    expect(project(0, 0, 10)).toEqual([0, -10]);
  });

  it('writes points to a tenth of a pixel', () => {
    expect(points([[1.234, -5.678], [0, 0.05]])).toBe('1.2,-5.7 0,0.1');
  });

  it('draws a box as its top and two front faces', () => {
    expect(box(0, 0, 1, 1, 0, 10)).toEqual({
      top: '0,-10 32,6 0,22 -32,6',
      left: '-32,6 0,22 0,32 -32,16',
      right: '32,6 0,22 0,32 32,16',
    });
  });

  it('stacks the floors bottom-up on the lobby: the scene lists them top-down', () => {
    const scene = makeScene();
    const m = facadeOf(scene.floors);
    expect(m.floors.map((f) => f.number)).toEqual([1, 2, 3, 4]);
    expect(m.floors.map((f) => f.key)).toEqual([...scene.floors].reverse().map((f) => f.key));
    const nameY = m.floors.map((f) => f.label.nameAt[1]);
    for (let j = 1; j < nameY.length; j++) expect(nameY[j]! - nameY[j - 1]!).toBeCloseTo(-FLOOR_H, 5);
    expect(m.lobby.label.circle[1]).toBeGreaterThan(m.floors[0]!.label.circle[1]);
  });

  it('gives each desk of a floor\'s plan a window, in desk order, dark where it is free, and leaves the row past its plan to the wall', () => {
    const m = facadeOf(makeScene().floors);
    expect(m.width).toBe(16);
    const checkout = m.floors[3]!;
    const free = (n: number) => Array<string>(n).fill('null:null:false');
    expect(checkout.windows.map((w) => `${w.sessionId}:${w.state}:${w.lit}`)).toEqual([
      'oa-c3:needs_you:true',
      ...free(3),
      'ps-d4:in_meeting:true',
      ...free(3),
      'sw-a1:working:true',
      'sw-b2:done:true',
      ...free(6),
    ]);
    const orders = m.floors[1]!;
    expect(orders.windows.map((w) => w.lit)).toEqual([true, true, true, false, true, false, false, false]);
    expect(orders).not.toHaveProperty('blanks');
    const xs = checkout.windows.map((w) => Number(w.points.split(' ')[0]!.split(',')[0]));
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
  });

  it('is as wide as the busiest floor, and never narrower than six windows', () => {
    expect(facadeOf([floorWith(9)]).width).toBe(9);
    expect(facadeOf([floorWith(2)]).width).toBe(6);
    expect(facadeOf([]).width).toBe(6);
  });

  it('lowers the shutters with three slats per window of its plan on a dormant floor only', () => {
    const m = facadeOf(makeScene().floors);
    expect(m.floors.map((f) => f.shutters)).toEqual([true, false, false, false]);
    expect([m.width, m.floors[0]!.windows.length]).toEqual([16, 8]);
    expect(m.floors[0]!.slats).toHaveLength(8 * 3);
    expect(m.floors[1]!.slats).toHaveLength(0);
  });

  it('frames the whole model and the label column in the viewBox', () => {
    for (const floors of [makeScene().floors, [floorWith(12)], []]) {
      const m = facadeOf(floors);
      const [x, y, w, h] = m.viewBox.split(' ').map(Number) as [number, number, number, number];
      for (const [px, py] of everyPoint(m)) {
        expect(px).toBeGreaterThanOrEqual(x);
        expect(px).toBeLessThanOrEqual(x + w);
        expect(py).toBeGreaterThanOrEqual(y);
        expect(py).toBeLessThanOrEqual(y + h);
      }
      expect(x + w).toBeGreaterThanOrEqual((m.width * TW) / 2 + 40 + LABEL_W);
    }
  });

  it('keeps an empty building to its lobby and roof', () => {
    const m = facadeOf([]);
    expect(m.floors).toEqual([]);
    expect(m.lobby.doors).toHaveLength(2);
    expect(m.lobby.windows).toHaveLength(4);
    expect(m.roof.units).toHaveLength(2);
    expect(m.roof.slab.top).toBe(box(-0.12, -0.12, 6.12, 3.12, LOBBY_H, LOBBY_H + 6).top);
  });

  it('lays an antenna stub per line slot on the roof, evenly spaced, a fixed footprint whatever the floors hold', () => {
    for (const floors of [[], makeScene().floors, [floorWith(20)]]) {
      const m = facadeOf(floors);
      expect(m.roof.stubs).toHaveLength(8);
      expect(m.roof.stubs.map((s) => s.slot)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
      // Left to right, inside the slab, each a plain vertical line (same x at both ends).
      const xs = m.roof.stubs.map((s) => s.line[0]);
      expect(xs).toEqual([...xs].sort((a, b) => a - b));
      expect(new Set(xs).size).toBe(8);
      for (const s of m.roof.stubs) {
        expect(s.line[0]).toBeCloseTo(s.line[2], 6);
        expect(s.line[1]).toBeGreaterThan(s.line[3]); // the stub's top is higher up the page than its base.
      }
    }
  });

  it('picks one of the eight known-server glyphs case- and punctuation-insensitively, and null past that set', () => {
    expect(glyphKeyOf('Notion')).toBe('notion');
    expect(glyphKeyOf('slack')).toBe('slack');
    expect(glyphKeyOf('MongoDB')).toBe('mongodb');
    expect(glyphKeyOf('GoogleSheets')).toBe('google-sheets');
    expect(glyphKeyOf('Google Sheets')).toBe('google-sheets');
    // classifyMcp's own canonical server token for this server (a claude.ai connector spelling, underscored):
    // glyphKeyOf must match it too, not just the two hand-cased spellings above (friendly server names follow-up).
    expect(glyphKeyOf('Google_Sheets')).toBe('google-sheets');
    expect(glyphKeyOf('ClickUp')).toBe('clickup');
    expect(glyphKeyOf('Chrome')).toBe('chrome');
    expect(glyphKeyOf('memory')).toBe('memory');
    expect(glyphKeyOf('Playwright')).toBe('playwright');
    expect(glyphKeyOf('Gmail')).toBeNull();
    expect(glyphKeyOf('fairmind')).toBeNull();
    expect(glyphKeyOf('')).toBeNull();
  });

  it("picks the mast's own per-family sign letter, and 'FM' past the five families (hq-mcp-switchboard proposal.md §5 Phase 3)", () => {
    expect(familySignOf('Studio')).toBe('S');
    expect(familySignOf('General')).toBe('G');
    expect(familySignOf('Brain')).toBe('B');
    expect(familySignOf('Insights')).toBe('I');
    expect(familySignOf('Code')).toBe('C');
    expect(familySignOf(null)).toBe('FM');
    expect(familySignOf('not-a-family')).toBe('FM');
  });

  it('draws every known-server glyph from plain primitives alone, inside its GLYPH_BOX square', () => {
    const keys = Object.keys(GLYPHS) as GlyphKey[];
    expect(keys.sort()).toEqual(['chrome', 'clickup', 'google-sheets', 'memory', 'mongodb', 'notion', 'playwright', 'slack']);
    for (const key of keys) {
      expect(GLYPHS[key].length).toBeGreaterThan(0);
      for (const part of GLYPHS[key]) {
        if (part.kind === 'path') expect(part.d.length).toBeGreaterThan(0);
        else if (part.kind === 'line') expect([part.x1, part.y1, part.x2, part.y2].every((n) => n >= 0 && n <= 16)).toBe(true);
        else expect(part.cx - part.r).toBeGreaterThanOrEqual(0 - 0.01);
      }
    }
  });

  it("mounts the switchboard's own name plaque clear of the units, the stubs and the mast, and exposes labelX for the layout below", () => {
    for (const floors of [[], makeScene().floors, [floorWith(20)]]) {
      const m = facadeOf(floors);
      expect(m.labelX).toBe((m.width * TW) / 2 + 40);
      expect(m.roof.plaque.post[0]).toBeCloseTo(m.roof.plaque.post[2], 6); // a plain vertical post, same x at both ends
      expect(m.roof.plaque.post[1]).toBeGreaterThan(m.roof.plaque.post[3]); // its top is higher up the page than its base
      expect(m.roof.plaque.labelAt).toEqual([m.roof.plaque.post[2], m.roof.plaque.post[3]]);
      expect(m.roof.plaque.post[0]).toBeLessThan(m.roof.stubs[0]!.line[0]);
      expect(m.roof.plaque.post[0]).toBeLessThan(m.roof.mast[0]);
    }
  });
});

describe('antenna tag layout (hq-mcp-switchboard Phase 4, requirement 1: readable tags that "don\'t overlap each other or floor labels")', () => {
  const activeLine = (slot: number, fairmind: boolean, count = 1): ActiveLine => ({
    slot,
    fairmind,
    count,
    server: fairmind ? 'fairmind' : `server-${slot}`,
    family: null,
    tool: 'tool',
    caller: 'caller',
  });

  it("places a tag above every lit stub's own tip, and the Fairmind line's above the mast's", () => {
    const m = facadeOf([floorWith(8)]);
    const lines = [activeLine(1, false), activeLine(4, true)];
    const { tags, overflow } = layoutAntennaTags(m.roof.stubs, m.roof.mast, m.labelX, lines, (l) => (l.fairmind ? 'FairMind' : 'Server'));
    expect(overflow).toBeNull();
    expect(tags).toHaveLength(2);
    for (const t of tags) expect(t.y).toBeLessThan(t.tipY); // lifted up the page from its own tip
    const mastTag = tags.find((t) => t.fairmind)!;
    expect([mastTag.tipX, mastTag.tipY]).toEqual([m.roof.mast[2], m.roof.mast[3]]);
    const stubTag = tags.find((t) => !t.fairmind)!;
    const stub1 = m.roof.stubs.find((s) => s.slot === 1)!;
    expect([stubTag.tipX, stubTag.tipY]).toEqual([stub1.line[2], stub1.line[3]]);
  });

  it('never lets a tag, or the "+k" overflow tag, reach into the floor label column', () => {
    const m = facadeOf([floorWith(8)]);
    const lines = Array.from({ length: LINE_SLOTS }, (_, slot) => activeLine(slot, false, slot + 1));
    const wide = () => 'FairMind · Insights ×9'; // the worst-case tag width geometry.ts's own viewBox reservation assumes
    const { tags, overflow } = layoutAntennaTags(m.roof.stubs, m.roof.mast, m.labelX, lines, wide);
    for (const t of tags) expect(t.x + t.halfWidth).toBeLessThan(m.labelX);
    expect(overflow).not.toBeNull();
    expect(overflow!.x + overflow!.halfWidth).toBeLessThan(m.labelX);
  });

  it('shows at most TAG_MAX tags — the Fairmind line always among them, then the busiest — and collapses the rest into one "+k" tag, left to right by their own tip', () => {
    const m = facadeOf([floorWith(8)]);
    const lines = [activeLine(0, false, 1), activeLine(1, false, 5), activeLine(2, false, 2), activeLine(3, false, 1), activeLine(4, true, 1), activeLine(5, false, 1)];
    const { tags, overflow } = layoutAntennaTags(m.roof.stubs, m.roof.mast, m.labelX, lines, (l) => (l.fairmind ? 'FairMind' : `S${l.slot}`));
    // Priority (Fairmind, then busiest-first, ties by slot) keeps {fairmind, slot 1, slot 2, slot 0}; slots 3 and 5
    // collapse into the overflow. The mast sits to the right of every stub (proved by geometry alone: the mast's
    // own x, W-0.5, always exceeds the rightmost stub's), so left to right that reads S0, S1, S2, FairMind.
    expect(tags).toHaveLength(TAG_MAX);
    expect(tags.map((t) => t.text)).toEqual(['S0', 'S1', 'S2', 'FairMind']);
    expect(overflow).not.toBeNull();
    expect(overflow!.text).toBe('+2 more');
  });

  it('never overlaps two shown tags, same lane (clear x) or not (a real, shared TAG_LANE_PX gap — never each tag\'s own tip lifted by the same amount)', () => {
    const m = facadeOf([floorWith(2)]); // MIN_WIDTH=6: stubs packed at their closest, the hardest case to keep clear
    const lines = Array.from({ length: LINE_SLOTS }, (_, slot) => activeLine(slot, false, 1));
    const { tags } = layoutAntennaTags(m.roof.stubs, m.roof.mast, m.labelX, lines, () => 'FairMind · Insights ×9');
    for (let i = 0; i < tags.length; i++) {
      for (let j = i + 1; j < tags.length; j++) {
        const [a, b] = [tags[i]!, tags[j]!];
        if (a.y === b.y) expect(Math.abs(a.x - b.x)).toBeGreaterThanOrEqual(a.halfWidth + b.halfWidth);
        else expect(Math.round(Math.abs(a.y - b.y) / TAG_LANE_PX)).toBeCloseTo(Math.abs(a.y - b.y) / TAG_LANE_PX, 6); // every lane shares one height across every tag
      }
    }
  });

  it('bumps two adjacent-slot tags into lanes a real TAG_LANE_PX apart even though their own stubs sit at different heights (regression: screenshotting the real demo first found Playwright/Slack on slots 5/6 landing only 3.2px apart — each lifted from its own tip instead of a shared lane height)', () => {
    const m = facadeOf([floorWith(8)]);
    const lines = [activeLine(5, false, 1), activeLine(6, false, 1)];
    const { tags } = layoutAntennaTags(m.roof.stubs, m.roof.mast, m.labelX, lines, (l) => (l.slot === 5 ? 'Playwright' : 'Slack'));
    expect(tags).toHaveLength(2);
    const [a, b] = tags as [(typeof tags)[0], (typeof tags)[0]];
    expect(a.y).not.toBe(b.y); // their estimated boxes do overlap in x, so they must land in different lanes
    expect(Math.abs(a.y - b.y)).toBe(TAG_LANE_PX);
  });

  it("exposes topY above every shown tag, so a tooltip anchored there never lands on a neighbour's own tag (regression: screenshotting the real demo found the Playwright antenna's own focus tooltip, lifted from its own tip alone, landing on slot 6's own \"Slack\" tag)", () => {
    const m = facadeOf([floorWith(8)]);
    const lines = [activeLine(5, false, 1), activeLine(6, false, 1)];
    const { tags, topY } = layoutAntennaTags(m.roof.stubs, m.roof.mast, m.labelX, lines, (l) => (l.slot === 5 ? 'Playwright' : 'Slack'));
    for (const t of tags) expect(topY).toBeLessThanOrEqual(t.y);
  });
});

describe('tooltip anchor (hq-mcp-switchboard Phase 4, requirement 3)', () => {
  it('centres on the tip for a short tooltip, nowhere near either boundary, unshortened', () => {
    const m = facadeOf([floorWith(8)]);
    const stub = m.roof.stubs.find((s) => s.slot === 5)!; // comfortably clear of the plaque and the label column
    const { x, text } = tooltipAnchor(stub.line[2], 'Slack', m.labelX, m.roof.plaque.labelAt[0]);
    expect(x).toBeCloseTo(stub.line[2], 6);
    expect(text).toBe('Slack');
  });

  it("nudges clear of the rooftop plaque for a longer tooltip near the roof's own left edge, still whole, on a building wide enough for both boundaries to be satisfiable at once", () => {
    const m = facadeOf([floorWith(20)]);
    const stub = m.roof.stubs.find((s) => s.slot === 0)!; // the leftmost stub, right next to the plaque
    const full = 'Notion · create_page · called by storefront-web-a1';
    const { x, halfWidth, text } = tooltipAnchor(stub.line[2], full, m.labelX, m.roof.plaque.labelAt[0]);
    expect(text).toBe(full); // room enough: never shortened
    expect(x).toBeGreaterThan(stub.line[2]); // nudged right, off its own tip
    expect(x - halfWidth).toBeGreaterThan(m.roof.plaque.labelAt[0]);
    expect(x + halfWidth).toBeLessThan(m.labelX);
  });

  it("shortens, with a trailing '…', rather than ever overlap either boundary — the plaque on the left or the floor label column on the right — for the longest realistic tooltip on a narrow building, where the two are too close together for the text's own full length (regression: screenshotting the real demo repeatedly found this long caller name/tool pair reading over the 'MCP / Switchboard' plaque; widening the plaque's own clearance alone did not fix it, because the floor label column — not the plaque — was the binding constraint)", () => {
    const m = facadeOf([floorWith(8)]);
    const long = 'FairMind · General · rag_search_docs · called by Implement the refund path';
    for (const tip of [m.roof.mast[2], m.roof.stubs.find((s) => s.slot === 7)!.line[2], m.roof.stubs.find((s) => s.slot === 0)!.line[2]]) {
      const { x, halfWidth, text } = tooltipAnchor(tip, long, m.labelX, m.roof.plaque.labelAt[0]);
      expect(text.length).toBeLessThan(long.length);
      expect(text.endsWith('…')).toBe(true);
      expect(x - halfWidth).toBeGreaterThanOrEqual(m.roof.plaque.labelAt[0]);
      expect(x + halfWidth).toBeLessThanOrEqual(m.labelX);
    }
  });
});

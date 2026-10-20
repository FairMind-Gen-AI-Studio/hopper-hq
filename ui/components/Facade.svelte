<script lang="ts">
  import { cleanText, friendlyServer } from '../../src/scene/text';
  import type { ActiveLine, FloorSummary } from '../../src/scene/types';
  import {
    GLYPH_BOX,
    GLYPHS,
    MIN_SCALE,
    NAME_MAX,
    facadeOf,
    familySignOf,
    glyphKeyOf,
    layoutAntennaTags,
    tooltipAnchor,
    type AntennaTag,
    type Box,
    type Label,
  } from '../facade/geometry';
  import { STATES, antennaTag, antennaTooltip, floorLabel, floorMeta, type Meta } from '../lib/words';

  /**
   * The building from outside: one window per desk of each floor's plan, coloured by the state of whoever sits there and
   * dark in its frame where the desk is free, and plain wall past the plan, so that a floor shows its size and how full it
   * is; floors stacked on a lobby, newest on top. A floor is a button that goes inside; a window with somebody at its desk
   * goes straight to that desk. A building too big for the stage at MIN_SCALE is drawn at that scale, and the stage
   * scrolls.
   *
   * The roof carries the MCP switchboard (hq-mcp-switchboard proposal.md §2 "Many parallel calls" / §4 Façade): one
   * antenna stub per `activeLines` entry lights in its line colour, a `+N` badge on the busiest line, and the mast
   * lights Fairmind's own fixed teal while any active line is Fairmind's — this is the one honest read of
   * parallelism across the whole building, where the floor's headset collapses a session to its latest call.
   *
   * Phase 2 (proposal.md §5 / §7 Q4) traces a sign onto every lit stub: one of the eight known-server glyphs
   * (`GLYPHS`) when `line.server` is one of them, else the line's own colour and the first letter of its server
   * name. A Fairmind line never reaches a stub at all — it already has its own exclusive sign, the mast — so it
   * is filtered out of `activeBySlot`/`busiest` before either is built, not just skipped at render time; a slot a
   * Fairmind call happens to hash to must read exactly as dark as one with no call at all.
   *
   * Phase 3 (proposal.md §5; ActiveLine.family, SCENE_VERSION 9) gives the mast its own sign too, teal-on-gold
   * (`mastSign`): one of the five family initials (`familySignOf`), or the house's own 'FM' for a family:null
   * Fairmind call — the façade's mirror of the floor headset's per-family VIP forms (fairmind-forms.ts).
   *
   * Phase 4 (user feedback 2026-10-19, "ora sono antenne ma non si capisce a cosa servono" — the switchboard's own
   * antennas carried no explanation of what they meant) makes the whole switchboard self-explanatory, all at once:
   * a readable text tag next to every lit antenna (`layoutAntennaTags`, `antennaTag`), a static name plaque on the
   * roof itself (`model.roof.plaque`, always drawn, brighter while any line is live), a hover/focus tooltip naming
   * the server, the tool and the caller on every lit antenna (`antennaTooltip`), and a legend entry in the
   * building sidebar (`BuildingPanel.svelte`). A lit antenna's own `.antenna` wrapper carries `tabindex="0"` and
   * `role="button"` — not because it does anything on click or Enter/Space (it doesn't), but because the
   * accessibility tree's own rule for a focusable, non-interactive role flags exactly this pattern; `role="button"`
   * is the nearest honest fit for "a focusable target that reveals more on focus", the same disclosure pattern a
   * plain icon-button tooltip trigger already uses elsewhere on the web.
   */
  interface Props {
    /** Top to bottom, as the scene lists them. */
    floors: FloorSummary[];
    /** Distinct MCP server lines with a live call anywhere in the building (BuildingScene.activeLines). */
    activeLines: ActiveLine[];
    /** The floor that is open, outlined. */
    selected: string | null;
    onFloor: (key: string) => void;
    onDesk: (floorKey: string, sessionId: string) => void;
  }
  let { floors, activeLines, selected, onFloor, onDesk }: Props = $props();

  const model = $derived(facadeOf(floors));
  const byKey = $derived(new Map(floors.map((f) => [f.key, f])));
  /** Every active line except Fairmind's own (the mast's alone, below) — the set a regular antenna stub can light from. */
  const lines = $derived(activeLines.filter((l) => !l.fairmind));
  const activeBySlot = $derived(new Map(lines.map((l) => [l.slot, l])));
  /** The Fairmind line, if any is active — there is at most one (activeLinesOf collapses every Fairmind call into
   * one line), and its own `family` (SCENE_VERSION 9, proposal.md §5 Phase 3) is what the mast's own sign reads. */
  const mastLine = $derived(activeLines.find((l) => l.fairmind) ?? null);
  /** The line with the most parallel calls across the building, its `+N` badge (proposal.md §2); null while idle. */
  const busiest = $derived(lines.reduce((top: ActiveLine | null, l) => (top === null || l.count > top.count ? l : top), null));
  /** Any line at all is live — gates the rooftop plaque's own brightness (requirement 2) and nothing else. */
  const anyLive = $derived(activeLines.length > 0);
  /** Every lit antenna's own readable tag, placed and stacked clear of each other and of the floor label column
   * (geometry.ts's `layoutAntennaTags`, requirement 1); a '+k' summary past `TAG_MAX` of them. */
  const tagLayout = $derived(layoutAntennaTags(model.roof.stubs, model.roof.mast, model.labelX, activeLines, antennaTag));
  const tagBySlot = $derived(new Map(tagLayout.tags.filter((t) => !t.fairmind).map((t) => [t.slot, t])));
  const mastTag = $derived(tagLayout.tags.find((t) => t.fairmind) ?? null);

  function pick(e: MouseEvent, key: string): void {
    const id = (e.target as Element | null)?.closest('[data-desk]')?.getAttribute('data-desk');
    if (id) onDesk(key, id);
    else onFloor(key);
  }

  function press(e: KeyboardEvent, key: string): void {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    onFloor(key);
  }
</script>

{#snippet solid(b: Box, material: string)}
  <g class="box m-{material}">
    <polygon class="l" points={b.left} />
    <polygon class="r" points={b.right} />
    <polygon class="t" points={b.top} />
  </g>
{/snippet}

{#snippet sign(tipX: number, tipY: number, slot: number, server: string)}
  {@const key = glyphKeyOf(server)}
  <g class="sign sign-{slot}" transform="translate({tipX},{tipY})">
    <circle class="sign-bg" r="7" />
    {#if key}
      <g class="sign-glyph" transform="scale(0.6) translate({-GLYPH_BOX / 2},{-GLYPH_BOX / 2})">
        {#each GLYPHS[key] as part, i (i)}
          {#if part.kind === 'path'}
            <path d={part.d} />
          {:else if part.kind === 'line'}
            <line x1={part.x1} y1={part.y1} x2={part.x2} y2={part.y2} />
          {:else}
            <circle cx={part.cx} cy={part.cy} r={part.r} />
          {/if}
        {/each}
      </g>
    {:else}
      <text class="sign-letter" x="0" y="0.5">{friendlyServer(server).charAt(0).toUpperCase()}</text>
    {/if}
  </g>
{/snippet}

{#snippet mastSign(tipX: number, tipY: number, family: string | null)}
  <g class="mast-sign">
    <circle class="mast-sign-bg" cx={tipX} cy={tipY} r="13" />
    <text class="mast-sign-letter" x={tipX} y={tipY + 0.5}>{familySignOf(family)}</text>
  </g>
{/snippet}

{#snippet antennaTagEl(t: AntennaTag)}
  <line class="tag-leader" x1={t.tipX} y1={t.tipY} x2={t.x} y2={t.y} />
  <text class="tag-name halo" x={t.x} y={t.y} text-anchor="middle">{t.text}</text>
{/snippet}

{#snippet callTip(tipX: number, text: string)}
  <!-- y anchors on `tagLayout.topY` — the highest point any tag (or the overflow tag) reaches, shared across every
       antenna — not this antenna's own tip: a tip-relative lift collided with a *neighbouring* antenna's own tag
       when the two sat close together (found screenshotting the real demo: focusing the Playwright antenna on
       slot 5 put its tooltip right on top of slot 6's own "Slack" tag), the identical shared-baseline problem
       `layoutAntennaTags`'s own lane stacking already fixed, for the identical reason. `tooltipAnchor` keeps its
       own x clear of the rooftop plaque on the left and the floor label column on the right, shortening the
       *visible* text (never the `.antenna` wrapper's own `aria-label`, read in full regardless) when a narrow
       building leaves less room than the full text needs. -->
  {@const anchor = tooltipAnchor(tipX, text, model.labelX, model.roof.plaque.labelAt[0])}
  <text class="call-tip halo" x={anchor.x} y={tagLayout.topY - 16} text-anchor="middle">{anchor.text}</text>
{/snippet}

{#snippet label(l: Label, num: string, name: string, metas: Meta[])}
  <line class="leader" x1={l.leader[0]} y1={l.leader[1]} x2={l.leader[2]} y2={l.leader[3]} />
  <circle class="t-btn" cx={l.circle[0]} cy={l.circle[1]} r="11" />
  <text class="t-num" x={l.circle[0]} y={l.circle[1] + 0.5}>{num}</text>
  <text class="t-name halo" x={l.nameAt[0]} y={l.nameAt[1]}>{name}</text>
  {#if metas.length > 0}
    <text class="t-meta halo" x={l.metaAt[0]} y={l.metaAt[1]}>{#each metas as meta, k (k)}<tspan class={meta.tone ? `c-${meta.tone}` : undefined} dx={k > 0 ? 10 : undefined}>{meta.text}</tspan>{/each}</text>
  {/if}
{/snippet}

<svg
  class="facade"
  viewBox={model.viewBox}
  preserveAspectRatio="xMidYMid meet"
  style:min-width="{Math.round(model.size.width * MIN_SCALE)}px"
  style:min-height="{Math.round(model.size.height * MIN_SCALE)}px"
  role="group"
  aria-label="Office building"
>
  <ellipse class="ground-shadow" cx={model.shadow.cx} cy={model.shadow.cy} rx={model.shadow.rx} ry={model.shadow.ry} />
  {@render solid(model.plinth, 'plinth')}
  <g class="lobby">
    {@render solid(model.lobby.wall, 'wall')}
    {#each model.lobby.windows as quad, i (i)}<polygon class="sfill st-empty" points={quad} />{/each}
    {#each model.lobby.doors as quad, i (i)}<polygon class="door" points={quad} />{/each}
    <polygon class="sfill st-empty" points={model.lobby.side} />
    {@render label(model.lobby.label, 'L', 'Lobby', [])}
  </g>
  {#each model.floors as floor (floor.key)}
    {@const summary = byKey.get(floor.key)!}
    <g
      class="floor"
      class:selected={floor.key === selected}
      class:shut={floor.shutters}
      role="button"
      tabindex="0"
      aria-label={floorLabel(summary)}
      onclick={(e) => pick(e, floor.key)}
      onkeydown={(e) => press(e, floor.key)}
    >
      <title>{summary.name}</title>
      {@render solid(floor.plate, 'plate')}
      {@render solid(floor.wall, 'wall')}
      {#each floor.windows as w, i (i)}
        {#if w.sessionId !== null && w.state !== null}
          <polygon class="sfill st-{w.state}" class:lit={w.lit} points={w.points} data-desk={w.sessionId}><title>{STATES[w.state].label}</title></polygon>
        {:else}
          <polygon class="sfill st-free" points={w.points} />
        {/if}
      {/each}
      {#each floor.slats as s, i (i)}<line class="slat" x1={s[0]} y1={s[1]} x2={s[2]} y2={s[3]} />{/each}
      <polygon class="sfill st-empty" points={floor.side} />
      {@render label(floor.label, String(floor.number), cleanText(summary.name, NAME_MAX), floorMeta(summary))}
      <polygon class="outline" points={floor.outline} />
    </g>
  {/each}
  <g class="roof">
    {@render solid(model.roof.slab, 'roof')}
    {#each model.roof.units as unit, i (i)}{@render solid(unit, 'unit')}{/each}

    <line
      class="plaque-post"
      x1={model.roof.plaque.post[0]}
      y1={model.roof.plaque.post[1]}
      x2={model.roof.plaque.post[2]}
      y2={model.roof.plaque.post[3]}
    />
    <g class="plaque" class:plaque-active={anyLive}>
      <text class="plaque-title halo" x={model.roof.plaque.labelAt[0]} y={model.roof.plaque.labelAt[1] - 4} text-anchor="middle">MCP</text>
      <text class="plaque-sub halo" x={model.roof.plaque.labelAt[0]} y={model.roof.plaque.labelAt[1] + 8} text-anchor="middle">Switchboard</text>
    </g>

    {#if mastLine}
      <g class="antenna antenna-mast" tabindex="0" role="button" aria-label={antennaTooltip(mastLine)}>
        <line class="mast lit" x1={model.roof.mast[0]} y1={model.roof.mast[1]} x2={model.roof.mast[2]} y2={model.roof.mast[3]} />
        {@render mastSign(model.roof.mast[2], model.roof.mast[3], mastLine.family)}
        {#if mastTag}{@render antennaTagEl(mastTag)}{/if}
        {@render callTip(model.roof.mast[2], antennaTooltip(mastLine))}
      </g>
    {:else}
      <line class="mast" x1={model.roof.mast[0]} y1={model.roof.mast[1]} x2={model.roof.mast[2]} y2={model.roof.mast[3]} />
    {/if}

    {#each model.roof.stubs as stub (stub.slot)}
      {@const line = activeBySlot.get(stub.slot)}
      {#if line}
        {@const tag = tagBySlot.get(stub.slot)}
        <g class="antenna" tabindex="0" role="button" aria-label={antennaTooltip(line)}>
          <line class="stub stub-{stub.slot} lit" x1={stub.line[0]} y1={stub.line[1]} x2={stub.line[2]} y2={stub.line[3]} />
          {@render sign(stub.line[2], stub.line[3], stub.slot, line.server)}
          {#if busiest && line.slot === busiest.slot && line.count > 1}
            <text class="stub-badge halo" x={stub.line[2]} y={stub.line[3] - 16}>+{line.count}</text>
          {/if}
          {#if tag}{@render antennaTagEl(tag)}{/if}
          {@render callTip(stub.line[2], antennaTooltip(line))}
        </g>
      {:else}
        <line class="stub stub-{stub.slot}" x1={stub.line[0]} y1={stub.line[1]} x2={stub.line[2]} y2={stub.line[3]} />
      {/if}
    {/each}

    {#if tagLayout.overflow}
      {@const o = tagLayout.overflow}
      <text class="tag-overflow halo" x={o.x} y={o.y} text-anchor="middle">{o.text}</text>
    {/if}
  </g>
</svg>

<style>
  .facade { display: block; width: 100%; height: 100%; }
  .m-wall { --c: var(--wall); }
  .m-plate { --c: var(--slab); }
  .m-plinth { --c: var(--plinth); }
  .m-roof { --c: var(--roof); }
  .m-unit { --c: var(--slab); }
  .box .t { fill: var(--c); }
  .box .l { fill: color-mix(in oklab, var(--c) 84%, var(--shade)); }
  .box .r { fill: color-mix(in oklab, var(--c) 68%, var(--shade)); }
  .box polygon { stroke: var(--edge); stroke-width: .6; stroke-linejoin: round; }
  .ground-shadow { fill: var(--shadow); }

  .sfill { fill: var(--win-off); color: var(--win-off); stroke: var(--edge); stroke-width: .5; }
  .sfill.st-free { stroke: var(--win-frame); stroke-width: 1.2; }
  .sfill.st-working { fill: var(--s-working); color: var(--s-working); }
  .sfill.st-needs_you { fill: var(--s-needs); color: var(--s-needs); animation: pulse 1.6s ease-in-out infinite; }
  .sfill.st-done { fill: var(--s-done); color: var(--s-done); }
  .sfill.st-in_meeting { fill: var(--s-meeting); color: var(--s-meeting); }
  .sfill.st-no_signal { fill: var(--s-nosignal); color: var(--s-nosignal); animation: flicker 3.2s ease-in-out infinite; }
  .sfill.st-idle { fill: color-mix(in oklab, var(--win-off) 74%, var(--s-working)); }
  .sfill.st-dormant, .shut .sfill { fill: var(--shutter); animation: none; }
  .sfill.lit { filter: var(--win-filter); }
  .shut .sfill.lit { filter: none; }
  .door { fill: color-mix(in oklab, var(--s-working) 55%, var(--win-off)); stroke: var(--edge); stroke-width: .5; }
  .slat { stroke: color-mix(in oklab, var(--shutter) 70%, var(--shade)); stroke-width: 1; }
  .mast { stroke: var(--muted); stroke-width: 1; }
  /* Fairmind's own fixed teal (tokens.css --fairmind-teal, materials.ts FAIRMIND_TEAL): the var itself is never
     restated in the dark blocks, so the brand holds identically by day and by night (proposal.md §4 "day/night").
     Round-2 enlargement: thickened from 2.5 to 4 — at the building's default view the thinner mast read as barely
     more than its own unlit hairline next to the roof's other silhouette lines. */
  .mast.lit { stroke: var(--fairmind-teal); stroke-width: 4; }

  /* Phase 3 (proposal.md §5; ActiveLine.family, SCENE_VERSION 9): the mast's own sign, teal-on-gold — distinctly
     premium next to a generic antenna stub's single-colour sign (`--fairmind-gold`, tokens.css, fixed outside the
     theme exactly like `--fairmind-teal`, so the mast's own badge holds its colours day and night too). One of
     the five family initials (`familySignOf`), or 'FM' for a family:null Fairmind call — the façade's own mirror
     of the floor headset's "brand mark alone" default (fairmind-forms.ts `fairmindFormOf`).
     Round-2 enlargement: the badge circle grew from r=9 to r=13 and its letter from 10px to 15px — at the
     building's own default view (zoomed out far enough to see every floor at once) the old sign was little more
     than a speck next to a floor's own `t-btn` label circle (r=11, a plain UI chip, no reason to out-rank the
     mast's own brand sign). `mast-sign`'s own `filter` below adds a soft halo in both fixed brand colours — never
     a theme token, so, like the fill and stroke themselves, it glows identically by day and by night rather than
     only at night the way a lit window's own `--win-filter` does (tokens.css: `none` in the day theme, a
     `drop-shadow` only in the dark ones) — a lit window's glow is diegetic (a light shining in the dark), the
     mast's is the brand's own fixed signage, lit the same whatever the sky is doing. */
  .mast-sign { filter: drop-shadow(0 0 2px var(--fairmind-gold)) drop-shadow(0 0 6px var(--fairmind-teal)); }
  .mast-sign-bg { fill: var(--fairmind-teal); stroke: var(--fairmind-gold); stroke-width: 1.8; }
  .mast-sign-letter { font-family: var(--font-mono); font-size: 15px; font-weight: 700; fill: var(--fairmind-gold); text-anchor: middle; dominant-baseline: central; }

  /* The rooftop switchboard's antenna stubs (hq-mcp-switchboard proposal.md §4 Façade): dark and thin until a line
     slot's call lights it, in the matching --line-N token (theme.ts, the same eight slots a robot's headset bead
     draws from, materials.ts). */
  .stub { stroke: var(--muted); stroke-width: 1; opacity: .35; }
  .stub.lit { stroke-width: 2; opacity: 1; }
  .stub-0.lit { stroke: var(--line-0); }
  .stub-1.lit { stroke: var(--line-1); }
  .stub-2.lit { stroke: var(--line-2); }
  .stub-3.lit { stroke: var(--line-3); }
  .stub-4.lit { stroke: var(--line-4); }
  .stub-5.lit { stroke: var(--line-5); }
  .stub-6.lit { stroke: var(--line-6); }
  .stub-7.lit { stroke: var(--line-7); }
  .stub-badge { font-family: var(--font-mono); font-size: 11px; font-weight: 700; fill: var(--fg); text-anchor: middle; }

  /* Phase 2 (proposal.md §5 / §7 Q4): the sign traced on a lit stub's tip — a known-server glyph (`sign-glyph`,
     one of the eight `GLYPHS`) or, past that set, the line colour and the first letter of the server name
     (`sign-letter`). `color` carries the line's own token down to the glyph's strokes via `currentColor`, the
     same one `.stub-N.lit` already uses, so a sign is never a second colour decision. */
  .sign-bg { fill: var(--panel); stroke: var(--edge); stroke-width: .6; }
  .sign-glyph path, .sign-glyph line { stroke: currentColor; stroke-width: 1.3; stroke-linecap: round; stroke-linejoin: round; fill: none; }
  /* A glyph's `circle` parts are always small filled dots (memory's nodes, Playwright's eyes, Chrome's hub) — a
     ring (Chrome's outer rim) is traced as a `path` instead, so `circle` never has to carry a stroke/fill switch. */
  .sign-glyph circle { fill: currentColor; stroke: none; }
  .sign-letter { font-family: var(--font-mono); font-size: 9px; font-weight: 700; fill: currentColor; text-anchor: middle; dominant-baseline: central; }
  .sign-0 { color: var(--line-0); }
  .sign-1 { color: var(--line-1); }
  .sign-2 { color: var(--line-2); }
  .sign-3 { color: var(--line-3); }
  .sign-4 { color: var(--line-4); }
  .sign-5 { color: var(--line-5); }
  .sign-6 { color: var(--line-6); }
  .sign-7 { color: var(--line-7); }

  /* Phase 4 (user feedback 2026-10-19, "ora sono antenne ma non si capisce a cosa servono" — "now they're antennas
     but it's not clear what they're for"): the switchboard's own name plaque, mounted on its own short post at the
     roof's front-left (geometry.ts's `plaque`, clear of every stub/unit/mast whatever the building's width).
     Always drawn, even on a wholly idle building — a first-time viewer otherwise has nothing at all to explain a
     bare, unlit antenna row — faint by default and brought up to full strength only once a line is actually live,
     so its own brightness still reads as the one truthful "is anything on the phone right now" signal (requirement
     2; the same "always drawn, dims rather than disappears" choice a free desk's own window already takes). */
  .plaque-post { stroke: var(--muted); stroke-width: 1; opacity: .5; }
  .plaque { opacity: .4; transition: opacity .2s ease; }
  .plaque.plaque-active { opacity: 1; }
  .plaque-title { font-family: var(--font-display); font-stretch: 72%; font-weight: 700; font-size: 10px; letter-spacing: .08em; text-transform: uppercase; fill: var(--fg); }
  .plaque-sub { font-family: var(--font-body); font-size: 8px; fill: var(--muted); }

  /* Phase 4 (requirement 1): a readable text tag next to every lit antenna — the server's name, or the brand (with
     its family) for the Fairmind line, and a small live-caller count past one (`ui/lib/words.ts`'s `antennaTag`) —
     in the same typographic family the floor labels use on the right (`.t-name`), one size down since a roof tag
     is a secondary read next to a floor's own name. `layoutAntennaTags` (geometry.ts) places and stacks it clear
     of every other tag and of the floor label column; this class only draws what that module already positioned. */
  .tag-name { font-family: var(--font-display); font-stretch: 75%; font-weight: 700; font-size: 11px; letter-spacing: .04em; fill: var(--fg); }
  .tag-leader { stroke: var(--muted); stroke-width: 1; stroke-dasharray: 2 3; opacity: .7; }
  .tag-overflow { font-family: var(--font-mono); font-size: 10px; font-weight: 600; fill: var(--muted); }

  /* Phase 4 (requirement 3): a lit antenna's own hover/focus tooltip — server (+ family for the Fairmind line), the
     tool it is calling and which session or sub-agent is calling it (`ui/lib/words.ts`'s `antennaTooltip`, reading
     tool-label.ts's own privacy rule: only ever names, `ActiveLine.tool`/`.caller`, never a call's own input). The
     wrapping `.antenna` group carries the same text in its own `aria-label` — read on focus whether or not a
     screen reader renders this visual box at all — and reveals the box on `:hover`/`:focus-visible`, the same
     toggle `.floor`'s own outline already uses below, so a keyboard-only sighted user gets it too, not just a
     mouse one. */
  .antenna { cursor: default; }
  .call-tip { opacity: 0; pointer-events: none; font-family: var(--font-mono); font-size: 10px; font-weight: 600; fill: var(--fg); transition: opacity .1s ease; }
  .antenna:hover .call-tip, .antenna:focus-visible .call-tip { opacity: 1; }

  .floor { cursor: pointer; outline: none; }
  .outline { fill: transparent; stroke: transparent; stroke-width: 2; pointer-events: none; }
  .floor:hover .outline, .floor:focus-visible .outline { stroke: var(--accent); fill: color-mix(in oklab, var(--accent) 8%, transparent); }
  .floor.selected .outline { stroke: var(--accent); stroke-width: 2.5; fill: color-mix(in oklab, var(--accent) 12%, transparent); }
  .floor .sfill[data-desk]:hover { stroke: var(--accent); stroke-width: 1.5; }

  .leader { stroke: var(--muted); stroke-width: 1; stroke-dasharray: 2 3; }
  .t-btn { fill: var(--panel); stroke: var(--fg); stroke-width: 1.3; }
  .t-num { font-family: var(--font-mono); font-size: 11px; font-weight: 600; fill: var(--fg); text-anchor: middle; dominant-baseline: central; }
  .t-name { font-family: var(--font-display); font-stretch: 72%; font-weight: 700; font-size: 16px; letter-spacing: .07em; text-transform: uppercase; fill: var(--fg); }
  .t-meta { font-family: var(--font-body); font-size: 11.5px; fill: var(--muted); }
  .c-needs { fill: var(--needs-ink); font-weight: 600; }
  .c-done { fill: var(--done-ink); font-weight: 600; }
  .c-meeting { fill: var(--meeting-ink); font-weight: 600; }
  .c-nosignal { fill: var(--nosignal-ink); font-weight: 600; }
  .halo { paint-order: stroke; stroke: var(--halo); stroke-width: 4px; stroke-linejoin: round; }

  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .5; } }
  @keyframes flicker { 0%, 100% { opacity: .9; } 45% { opacity: .55; } 50% { opacity: .85; } }
</style>

# Hopper HQ — "MCP switchboard" design: visualising live MCP calls

Date: 2026-10-16
Status: implemented
Builds on: `2026-10-09-hopper-hq-design.md` (§4 adapters, §10 scene), `2026-10-13-m3a-detail-design.md`
(§4 scene v2, interns and meeting rooms), `2026-10-15-agent-moods.md` / `2026-10-15-agent-personas.md`
(the same adapter -> collector -> reducer -> scene-build -> renderer seam, and the cigar's
show-while-active / clear-on-finish lifecycle this feature reuses)

## 1. Scope

Every MCP tool call (`mcp__<server>__<tool>`) is a phone call the office places to an outside
party. On the floor, the calling robot puts on a slim headset whose earpiece bead glows in that
server's line colour; on the façade, the rooftop becomes a switchboard — one lit antenna stub per
server with a live call anywhere in the building, so parallelism and "who are we talking to" read
from outside. FairMind is the house's own private hotline: its calls light the tall rooftop mast
in brand teal and give the caller a teal earpiece carrying the FairMind mark.

**In scope (MVP, this note)**: classifying an MCP tool call at ingest (server, family, read/write,
Fairmind identity); carrying it through both adapters, the reducer and `build.ts`'s scene
projection; the floor headset (with a minimum hold so sub-second calls still register) and its DOM
chip; the façade rooftop switchboard (per-line stubs, the FairMind mast); the dropped-call error
flash; making all of it visible in `hopper-hq demo` and `hopper-hq demo --showcase`.

**Out of scope (MVP)**: Phase 2 façade glyph/archetype signs (`proposal.md` §5 Phase 2 — landed
since, see §9); Phase 3 FairMind per-family VIP forms (Brain-core orb, etc., §5 Phase 3 — landed
since, see §10); real per-robot parallelism (a session's `openTool` is one object — only the façade
carries true building-wide concurrency, see §5); a server-key allowlist beyond the canonical-resolver rules
already in `classifyMcp`.

See the approved design proposal (`.fairmind/hopper-hq/hq-mcp-switchboard/proposal.md`, Technical
Lead synthesis of two judge panels) and the user decisions it was approved against
(`.fairmind/hopper-hq/hq-mcp-switchboard/user-decisions.md`, 2026-10-16) for the full concept
scoring and the open-questions table this note's §6 answers from.

## 2. Data flow: a tool name -> a classified call -> the scene

```
tool.started's raw tool name (mcp__<server>__<tool>)
  -> src/core/tool-label.ts: classifyMcp(tool) -> McpCall { server, family, write, fairmind } | null
     (pure; canonicalises every Fairmind spelling to 'fairmind'; the ONLY surface it reads is the
     tool name string itself — never its arguments, never its result: proposal.md §3 "Privacy")
  -> both adapters (hooks.ts, transcript.ts) set it on the RawEvent's own `mcp?` field, exactly
     parallel to `smoke?` (2026-10-15-agent-moods.md §2)
  -> src/core/reducer.ts: applyEvent sets `call`/`callAt` on the right entity (Session, ChildAgent
     or RunAgent, routed by the existing agentId logic) from a tool.started that carries `mcp`;
     NOT wiped back to null by the matching tool.finished — only a newer MCP call overwrites them
     (see §4 "call vs callAt" for why this is the one place this design diverges from the cigar's
     wipe-on-close precedent)
  -> src/scene/build.ts: headsetOf(call, callAt, error, now) projects `call`/`callAt`/`error` into
     a transient OnCallView (slot, family, write, fairmind, error), live from `callAt` for
     MIN_HOLD_MS (1.8s) — covers both a call still open and the minimum-hold window after a
     sub-second one already closed; and activeLinesOf(views, now) tallies every distinct live
     server, building-wide, into BuildingScene.activeLines
  -> ui/renderer/robot.ts: setOnCall(obj, call) toggles the headset's hook+bead group (no rebuild,
     mirroring setSmoking) and recolours it to the call's line slot or Fairmind's fixed teal
  -> ui/facade/geometry.ts + Facade.svelte: a fixed LINE_SLOTS-sized row of antenna stubs lights
     from `activeLines`, and the mast lights Fairmind teal while any active line is Fairmind's
  -> ui/renderer/labels.ts: callChip(call, label) appends the DOM chip ("<server>: <tool>", a ✗ on
     a dropped call) to an occupant's existing tag — the non-visual, authoritative-identity path
```

**SCENE_VERSION 6 -> 7**: `Occupant`/`Intern`/`MeetingAgent` each gain `call: OnCallView | null`;
`BuildingScene` gains `activeLines: ActiveLine[]`. Mandatory for any new scene field (trips the
stale-tab reload prompt by design).

## 3. `classifyMcp`: server, family, read/write, Fairmind identity

Pure, no I/O, reads only the tool name string `mcp__<server>__<tool>` (`src/core/tool-label.ts`).

- **Canonical server-key resolver**: `mcp__plugin_<plugin>_<server>__…` reduces to `<server>` (its
  last `_`-separated segment); `mcp__claude_ai_<Name>__…` reduces to `<Name>`; every other spelling
  is the server as-is. A Fairmind identity (`/^fairmind(?![a-z0-9])/i`, the plugin's own anchored
  rule from `_mcp_config.py`, applied to the *server* segment — a different axis from
  `src/scene/fairmind.ts`'s `FAIRMIND_NAMESPACE`, which keys on an *agent's* plugin namespace, not
  on which MCP server it is calling) always canonicalises to the literal `'fairmind'`, whatever
  spelling it was called under (`'Fairmind'`, `'fairmind-dev'`, a plugin-qualified one).
- **Family**: for a Fairmind call only, the tool name's own prefix — `Studio_`, `General_`/`rag_`,
  `Brain_`, `Insights_`, `Code_` — else `null` (a non-Fairmind call never carries a family).
- **Read/write**: a short list of Fairmind write verbs (`record_`, `set_status`,
  `bulk_update_status`, `process_journal`, `add_document`, `supersede_`, `bind_repository`);
  everything else defaults to read. This means a generic server's write-shaped call (a Slack post,
  a Notion page create) still classifies as `write: false` today — a known, tested limit of
  Phase 0's heuristic (`test/core/tool-label.test.ts`), not something this integration changed or
  widened; the demo's own "Slack post" beat (§7) is a write *in spirit*, not in the classifier's
  own verdict.

## 4. Reconciling the two Phase-1 branches: `call`/`calls` vs `call`/`callAt`

Phase 1 Groups A (`mcp/A-data`: adapters + reducer) and B (`mcp/B-scene-facade`: scene projection +
façade) were built in parallel against the same three entities and landed on two different field
shapes for "the entity's current MCP call":

- **Group A** (what the reducer originally wrote): a nested `call`/`calls` pair, the same spirit as
  `openTool`'s own fields — `call` set from the started tool's `mcp`, wiped back to `null`
  unconditionally on `tool.finished`; `calls` a monotonic per-entity counter, meant to let the
  renderer detect a fresh call via a *delta* rather than `openTool`'s instantaneous identity (the
  sub-second-lifetime fix both judge panels in the proposal demanded).
- **Group B** (what `build.ts`'s `headsetOf`/`agentCallOf` actually consume): a flat `call`/`callAt`
  pair — `call` persisted, **not** wiped on finish; `callAt` the timestamp `build.ts`'s
  `MIN_HOLD_MS` window reads against `now`. Group B's own code comment (now in `core/types.ts`,
  `Session.call`) names the problem directly: Group A's wipe-on-finish clears the very field
  (`call`, the server/family/fairmind identity) the hold window needs to still read *after* the
  call that set it already closed `openTool` — a monotonic counter alone proves "a call happened"
  but not "which one", for exactly the window this whole feature exists to extend.

This integration (`feat/mcp-switchboard-int`) kept Group B's `call`/`callAt` pair on all three
entities — consistent with what `build.ts` already consumed — and rewrote `core/reducer.ts`
(which Group B's own branch never touched, since it predates Group A's reducer work) to actually
populate `callAt` on `tool.started` and leave both fields untouched on `tool.finished`, instead of
Group A's wipe/count. `openTool`'s own `call`/`calls` pair is unrelated and unchanged — it is a
different, already-shipped mechanism (the main agent's currently-open tool, cleared the moment it
closes) that this feature does not touch.

The façade's own `AntennaStub`/`roof` shape had the same kind of two-branch disagreement — Group
B's first draft computed a dynamic, per-active-line antenna layout (repositioning stubs as calls
start and stop); the later, more polished `mcp/C-renderer` branch replaced it with a fixed
`LINE_SLOTS`-sized footprint that never reflows and is lit/badged reactively from `activeLines` in
`Facade.svelte`. This integration kept the fixed layout (stable stub positions, `geometry.ts`
stays a pure function of the floors alone) and C's actually-theme-aware `--line-N` palette (Group
B's repeated the same eight hex values in both the light and dark blocks).

## 5. Rendering

- **Floor**: `robot.ts`'s `setOnCall(obj, call)` toggles a 2-mesh group (`HEADSET`: hook + bead, on
  the neck group so it holds in every pose, mirroring the cigar) — `cast: false` on both, plus the
  FairMind mark mesh when shown (`castShadow = false` explicitly). A dropped call (`error: true`)
  flashes the bead a red tint before the headset clears with the hold window's natural expiry.
  **Single-`openTool`-collapse limit, inherited, not fixed here**: a session's two parallel calls
  show only the latest server on its own floor headset (`openTool` is one object); each crew
  member (intern, run agent) carries its own flag independently, so concurrent calls *across a
  crew* are individually visible — the façade is where true building-wide parallelism reads
  honestly (see the demo's own "parallel calls" beat, §7).
- **Façade**: SVG, entirely outside the three.js budget — a fixed row of antenna stubs (one per
  `LINE_SLOTS`), dark until `activeLines` lights the matching slot, with a `+N` badge on the
  busiest line past one call; the mast (the building's one hotline) lights Fairmind's own fixed
  teal (`tokens.css --fairmind-teal`, never restated in the dark blocks, so the brand holds
  identically day and night) while any active line is Fairmind's.
- **Budget**: re-measured for the full three-branch merge (`ui/test/renderer/budget.test.ts`) —
  unchanged from `mcp/C-renderer`'s own measurement, since nothing in reconciling the branches
  touched a mesh-count path: fullest floor 3,934 meshes / 4,151 draws / 423 casters (caps 4,327 /
  4,566 / 465); every robot on the fullest floor also on a call (every intern and room agent
  `fullestFloor` already types to a Fairmind plugin, so the headset's extra Fairmind-mark mesh is
  pinned too) 4,371 meshes / 4,588 draws / **423 casters — unchanged**, exactly the "casters must
  not grow" requirement: the headset's hook, bead and mark are all `cast: false`, so lighting it on
  every robot simultaneously raises meshes and draws alone, never the shadow pass.

## 6. Open questions, as decided (`user-decisions.md`, 2026-10-16)

- **Q1 — scope**: both the floor headset and the rooftop switchboard ship in the MVP.
- **Q2 — FairMind per-family VIP forms**: deferred to Phase 3 (landed, §10), Brain-core orb built
  first as the premium beat; the MVP itself already gave FairMind the teal earpiece, the mast and a
  family-named chip (`Fairmind: Studio_get_task`), which already read as "di riguardo".
- **Q3 — minimum hold**: ~1.8s (`MIN_HOLD_MS`, `build.ts`), a tunable constant.
- **Q4 — Phase 2 glyph set**: Notion, Slack, memory, MongoDB, Playwright, Google Sheets, ClickUp,
  Chrome get a traced mark; everything else is colour + first letter. Not built in this MVP (§1).
- **Q5 — error state**: in the MVP — the dropped-call red flash, gated on the reducer actually
  reading `tool.finished`'s `ok` (already landed, Phase 0).
- **Q6 — SCENE_VERSION coordination with `feat/room-screens`**: this branch started from
  `feat/agent-moods` and bumps 6 -> 7; `room-screens` also bumps to 7 from its own base. Neither
  has merged to `main` yet (still 4 there) — whichever of the two merges to `main` second takes the
  next bump to 8. Not this integration's concern to resolve; noted for whoever does that merge.

## 7. Demo and showcase

Both `hopper-hq demo` (`src/adapters/demo.ts`) and `hopper-hq demo --showcase`
(`src/adapters/showcase.ts`) script a small set of MCP beats, each timed to land on a desk or
agent that is otherwise idle at that moment — none of them overwrites a tracked state (an open
permission wait, the smoke-test cigar, a meeting's room slot) — built from `classifyMcp`/
`toolLabel` the same way the real hooks adapter computes a `tool.started`'s `mcp`/`label` fields,
so they render from the same data a live call would produce, not a hand-built shortcut:

- a **Notion search** (read) and a **Slack post**, each a plain, non-Fairmind call;
- a **dropped call** (`ok: false`) on a sub-agent, for the error-flash state;
- **parallel calls to two distinct servers** (Google Sheets, ClickUp) on two different entities at
  the same instant — the one honest read of parallelism the rooftop switchboard exists for;
- FairMind's own **`Studio_get_task`** (read, by a session directly — the teal earpiece on an
  occupant's own robot, not a sub-agent's) and **`Brain_record_decision`** (write, by a sub-agent —
  a workflow run's own agent "reporting home").

`demo.ts` additionally gives the address desk's own Explore intern a Playwright call overlapping
the desk's own Slack call, so a single floor screenshot can show a session's headset and an
intern's lit at once.

## 8. Testing

- **Pure core**: `test/core/tool-label.test.ts` (Phase 0, unchanged by this integration) covers
  `classifyMcp`'s canonicalisation, family and read/write rules. `test/core/reducer.test.ts` and
  `test/core/reducer.runs.test.ts` were rewritten (not merely re-merged) to assert the reconciled
  `call`/`callAt`-persists-past-close behaviour (§4) on the main agent, a child and a run agent, in
  place of Group A's wipe-on-finish/monotonic-count assertions.
- **Scene**: `test/scene/build.test.ts` covers `headsetOf`'s minimum-hold window and
  `activeLinesOf`'s building-wide tally, including the Fairmind-line collapse.
- **Renderer**: `ui/test/renderer/budget.test.ts`'s `SWITCHBOARD_BUDGET` (§5); `ui/test/renderer/
  robot.test.ts` and `materials.test.ts` cover `setOnCall` and the line-colour/Fairmind-teal
  materials. `ui/test/facade/geometry.test.ts` and `ui/test/components/Facade.test.ts` cover the
  fixed antenna-stub layout and the mast/stub lighting from `activeLines`.
- **Adapters**: `test/adapters/demo.test.ts` and `test/adapters/showcase.test.ts` each gained
  coverage for the new MCP beats (and `demo.test.ts`'s `startDemo` exact-event-count assertions
  were updated for the added events).
- **e2e** (`e2e/smoke.spec.ts`, unchanged by this task): already drives the built demo in headless
  Chrome; the switchboard's static meshes/stubs render the same way the existing cigar and leisure
  props do, so no new assertion was needed there for this task.

## 9. Phase 2 — façade glyph/archetype signs

Date: 2026-10-19. Status: implemented (`proposal.md` §5 Phase 2; §7 Q4; `user-decisions.md` Q4).
Pure façade SVG, entirely outside the three.js budget — no renderer-side change.

**Scope**: every lit antenna stub now carries a sign at its tip — one of eight traced glyphs
(Notion, Slack, memory, MongoDB, Playwright, Google Sheets, ClickUp, Chrome) for the line's own
known server, else the line's colour and the first letter of its server name. The DOM chip
(`labels.ts`) is unchanged — it was already the authoritative identity before Phase 2 and stays
so; this phase is the façade's own, strictly cosmetic, second read of the same data.

**Why `ActiveLine` needed a new field, not just a façade-side lookup**: the façade only ever held
the *hashed* line slot (`ActiveLine.slot`, `classifyMcp`'s server token run through `slotOf`), never
the server name itself — by design, MVP's own doc comment on `ActiveLine` called the DOM chip "the
authoritative identity" for exactly this reason. A known-server glyph needs the real name, not the
slot, so `ActiveLine` gained `server: string` (`src/scene/types.ts`, SCENE_VERSION 7 → 8) and
`activeLinesOf` (`src/scene/build.ts`) now keeps the canonical name of whichever call tallied into
a slot first, read straight off the same raw `McpCall` `callOf`/`agentCallOf` already gate
liveness on — never re-derived, so it can't disagree with the slot/fairmind verdict those two
functions already made for the same tick. Two live servers whose names hash into the same slot no
longer share it: lines are grouped per server and a later name (in name order) probes to the next
free slot, so every live server gets its own antenna; only past 8 distinct live servers do two share
a stub, the first-tallied name kept. The DOM chip remains the one truly authoritative identity.

**A Phase-1 façade quirk, fixed here, not separately**: because a Fairmind call's own line was
unshifted into the same `activeLines` list `Facade.svelte`'s stub loop reads, a Fairmind call
could light its hashed slot's *generic* stub (in that slot's own line colour) in addition to the
mast — never intended (`proposal.md` §2 "FairMind never renders as a generic grey bead", §6
"FairMind is forced out of the rotation"), and surfaced only once Phase 2 needed to decide what
sign that stub would carry. `Facade.svelte` now filters Fairmind lines out of `activeBySlot` and
`busiest` before either is built: a slot a Fairmind call hashes to now reads exactly as dark as an
idle one, with no sign — the mast is its only tell. Covered by a new Facade.svelte test.

**Glyphs** (`ui/facade/geometry.ts`: `GLYPHS`, `glyphKeyOf`, `GLYPH_BOX`): plain SVG primitives
(`path`/`line`/`circle`) in a 16×16 local box, no `<image>`, single-colour (`currentColor`,
recoloured per the stub's own `--line-N` token, same as the stub itself) — Notion an "N", Slack a
hash, memory three linked nodes, MongoDB a leaf, Playwright a masked shield, Google Sheets a grid,
ClickUp a stacked chevron, Chrome a three-spoke pinwheel. `glyphKeyOf` matches on the server name
normalised to bare lowercase letters/digits, so `'Google Sheets'`, `'GoogleSheets'` and
`'google-sheets'` all resolve to the same glyph — the same leniency `classifyMcp`'s own canonical
resolver already established for the Fairmind identity (§3).

**Testing**: `ui/test/facade/geometry.test.ts` covers `glyphKeyOf` (every known name, case- and
punctuation-insensitively, and null past the eight) and that every `GLYPHS` entry draws from valid
primitives inside its box. `ui/test/components/Facade.test.ts` covers a known-server glyph
rendering, the letter fallback for an unnamed server, and the Fairmind-stub exclusion (mast lit,
no stub, no sign). `test/scene/build.test.ts` covers `activeLinesOf` carrying `server` end to end,
including the first-tallied-wins rule on a guaranteed slot collision (50 synthetic server names
into 8 slots, pigeonholed).

**Visual verification**: screenshotted the real demo app (`node dist/bin.js demo`) at the moments
its own scripted beats put two known servers live at once (Slack+Playwright, then
GoogleSheets+ClickUp), day and night — both read correctly in situ. For the full eight-glyph set
plus the letter fallback and the Fairmind-stub exclusion together (more than any single real demo
beat lines up at once), a throwaway `ui/lab` Svelte page mounted the real `Facade.svelte` with a
crafted `activeLines` prop and was screenshotted in both themes, then removed before `npm test`
(never committed, per repo convention). One round of iteration on the first pass: the memory
glyph's node circles (`r: 1.3`) read as a plain triangle at antenna scale, indistinguishable in
spirit from a generic warning triangle; widened to `r: 2` (clearly past the edge lines' own stroke
width) so each corner reads as a linked node, confirmed by re-screenshotting.

## 10. Phase 3 — FairMind per-family VIP forms

Date: 2026-10-19. Status: implemented (`proposal.md` §2 "FairMind tool families" / §5 Phase 3;
`user-decisions.md` Q2 "Brain-core orb first"). The one part of the switchboard the proposal itself
called "the premium beat" — FairMind no longer renders every call the same way once it is classified
into one of `classifyMcp`'s five families; the brand mark alone (the MVP's own form) steps aside for
a small motif of that family's own work, on both the floor headset and the façade mast.

**Scope**: `ui/renderer/fairmind-forms.ts` (new) builds six hidden forms once per robot, as siblings
on one group on the headset bead, and `setFairmindForm` shows the one the call's family picked and
hides the rest — no rebuild, mirroring `setOnCall`/`setSmoking`'s own discipline:

| Family | Motif | Meshes |
|---|---|---|
| Studio | a drafting roll — a short teal cylinder tilted on two axes, like a blueprint tucked under an arm | 1 |
| General (+ rag_) | a document beam — a thin standing teal pane | 1 |
| Brain | a glowing teal core ringed in gold — the only two-mesh form, the premium beat (user-decisions.md Q2) | 2 |
| Insights | a ticker — a wide, flat gold strip, telemetry always writing itself out | 1 |
| Code | a wireframe teal cube — the code graph's own repo, drawn in line, not fill | 1 |
| *(none)* | the brand mark alone (`fairmind-badge.ts`), unchanged from the MVP, the "sensible default form" a family:null Fairmind call still gets (`bulk_update_status`, `process_journal`, every call outside the five prefixes) | 1 |

Every mesh is `MeshBasicMaterial`, fixed teal (`mats.fairmindDisc`/`fairmindMark`/`fairmindWire`) or
fixed gold (`mats.fairmindGold`, `FAIRMIND_GOLD = '#D4AF37'`, `materials.ts` — the one new colour
this phase adds), never a theme token, so the brand holds by day and by night exactly as
`FAIRMIND_TEAL` already does. Every mesh is `cast: false` — the same budget rule the headset itself
was built under.

**Write vs read**: the shown form pulses in step with the bead, in the same direction (`robot.ts`
`animateRobot`, `CALL_PULSE`) — a write grows the whole form outward past its resting size, a read
shrinks it gently inward, the same "direction" encoding the plain bead already carries, now visible
on a form a FairMind call is senior enough to show. `RobotRig.headsetFairmind` gates this: a
non-Fairmind call still pulses the bead but never the (hidden) Fairmind forms group.

**Façade mast sign**: `ActiveLine` gained `family: string | null` (SCENE_VERSION 8 → 9,
`src/scene/types.ts`), carried by the same first-tallied-wins rule `server` already uses
(`activeLinesOf`, `src/scene/build.ts`) — null for every non-Fairmind line, and also null for a
Fairmind line whose first-tallied call carried none. `familySignOf` (`ui/facade/geometry.ts`) maps
it to one letter — `S`/`G`/`B`/`I`/`C`, or `FM` (the house's own initials) past the five families —
drawn as a teal-on-gold circle at the mast's own tip (`Facade.svelte`'s `mastSign` snippet), reusing
`--fairmind-teal`/`--fairmind-gold` (`tokens.css`, both fixed outside the theme). The mast itself was
already the Fairmind identity's exclusive sign (Phase 2 fixed the quirk that let a Fairmind call also
light its hashed stub); this phase only adds the letter on top of it.

**Budget**: re-measured against `ui/test/renderer/budget.test.ts`'s existing `SWITCHBOARD_BUDGET`
(4,808 meshes / 5,046 draws / 465 casters — unchanged from the MVP, not raised for this phase). The
real worst case for Phase 3's own added meshes is every Fairmind-plugin intern and room agent on the
fullest floor showing the two-mesh Brain form (`fullestFloorOnBrainCall`, `ui/test/renderer/
fixtures.ts`): measured 4,496 meshes / 4,713 draws / 423 casters — comfortably under the existing cap
with a tenth to spare, and casters unchanged from `fullestFloorOnCall`'s own 423 (every form mesh is
`cast: false`, so swapping the default mark for the Brain orb on every such robot simultaneously
raises meshes and draws alone, never the shadow pass). `test/scene/budget.test.ts`'s own `JSON_BUDGET`
(the fullest floor's wire JSON) needed no re-measure: `ActiveLine` lives on `BuildingScene`, not the
per-floor `FloorDetail` that test measures, and that fixture never sets an open MCP call, so `call`
still serialises as `null` regardless of how many fields `OnCallView` carries.

**Demo**: the switchboard's own demo beats (`src/adapters/demo.ts`) now exercise all five families
plus the family:null default somewhere in the loop — General (`rag_search_docs`, read) on the
checkout-verify run's Build-phase Security Engineer; Brain (`Brain_record_decision`, write) then Code
(`Code_search_symbol`, read) in turn on the same Review-phase run agent, so both VIP forms are visible
on one robot's headset across the loop; the default form (`bulk_update_status`, write, no family) on
the Ship-phase QA Engineer; Studio (`Studio_get_task`, read, unchanged from the MVP) and Insights
(`Insights_record_loop_stats`, write) on the dependency-investigate desk's own session. `test/adapters/
demo.test.ts` asserts the full set — all five families and the null default, nothing missing, nothing
extra — directly off `demoScript()`'s own `tool.started` events.

**Testing**: `ui/test/renderer/robot.test.ts` covers `fairmind-forms.ts` end to end — exactly one form
shown per family and the rest hidden; the null-family and unknown-family fallback to the default
mark; every form hidden for a non-Fairmind call and for none; the Brain orb's two meshes against
every other form's one; no shadow casting from any of the six, shown or hidden; the write/read pulse
direction, gated on `headsetFairmind`. `ui/test/facade/geometry.test.ts` covers `familySignOf` for
all five families, `null`, and an unrecognised family. `ui/test/components/Facade.test.ts` covers the
mast sign for each family and the `FM` fallback, and that no sign draws while the mast is dark.
`test/scene/build.test.ts` covers `activeLinesOf` carrying `family` end to end, including the
family:null case for a Fairmind line whose first-tallied call carried none.

**Visual verification**: screenshotted the real demo app (`node dist/bin.js demo`) for the floor —
a Brain-family call's headset, in the fullest-floor default zoom, day and night (the teal orb with
its gold ring holds its own colours identically in both); and the façade — the FairMind mast's own
`B` sign next to a generic antenna stub's glyph, and the `FM` default sign, day and night. A
throwaway `ui/lab` page mounted the real `buildRobot`/`setFairmindForm` and the real `Facade.svelte`
to close-up every one of the six forms individually (Studio's tilt, General's pane, Brain's two
meshes, Insights' gold strip, Code's wireframe, the default mark) at a scale no real demo beat holds
still long enough to screenshot at, then was removed before `npm test` (never committed).

## 11. Phase 4 — self-explanatory antennas: tags, plaque, tooltip, legend

Date: 2026-10-19. Status: implemented. User feedback, in Italian: "trova una soluzione per
identificare le antenne sul tetto, ora sono antenne ma non si capisce a cosa servono" — "find a
way to identify the rooftop antennas; right now they're antennas but it isn't clear what they're
for." Phases 1-3 made the switchboard real (lit stubs, glyph signs, the mast's own per-family
sign) but never explained any of it to a first-time viewer. Phase 4 closes that gap, all at once:
a readable text tag next to every lit antenna, a static name plaque on the roof itself, a
hover/focus tooltip naming the server/tool/caller, and a legend entry — pure façade SVG, no scene
or renderer budget impact outside the two new `ActiveLine` fields below.

**Scope**: entirely in `ui/facade/geometry.ts` (new pure layout functions), `ui/components/
Facade.svelte` (wiring + CSS), `ui/lib/words.ts` (wording), `ui/components/BuildingPanel.svelte`
+ `ui/styles/base.css` (the legend entry), and two new fields on `ActiveLine`/`McpCall` (below).

**`ActiveLine` gains `tool`/`caller` (SCENE_VERSION 9 → 10)**: the tooltip (requirement 3) needs to
name the tool being called and who's calling it, neither of which Phase 1-3's `ActiveLine` carried.
`McpCall` itself gained `tool: string` (`src/core/tool-label.ts`'s `classifyMcp`, the verb segment
alone, exactly as spelled in the tool name — the same text the DOM chip's `toolLabel` already shows
elsewhere, so this is not a new privacy surface). `build.ts`'s `activeLinesOf` carries both through
by the identical first-tallied-wins rule `server`/`family` already use: `tool` from the winning
call's own `McpCall.tool`; `caller` from the entity's own already-shown name (a session's `nameOf`,
or a subagent's type/label — the same fallback chain `DeskPanel.svelte`'s `intern.type ?? 'Subagent'`
and `RunPanel.svelte`'s `agent.label ?? agent.type ?? 'Agent'` already use, so the tooltip never
invents a name the rest of the UI wouldn't show).

**Requirement 1 — readable tags, `layoutAntennaTags` (`geometry.ts`)**: a pure, DOM-free layout
function the Svelte component calls reactively with the live `activeLines` (kept out of `facadeOf`
itself, which stays "a pure function of the floors alone" exactly as its own doc comment already
promised). Each lit line's tag reads its server name (or "FairMind", with its family after a middle
dot, for the Fairmind line — `ui/lib/words.ts`'s `antennaTag`) plus a `×N` count past one call. Lit
lines are prioritised Fairmind-first then busiest-first, capped at `TAG_MAX` (4) shown tags; the
rest collapse into one "+k more" summary, never silently dropped. Tags are swept left to right and
stacked into a higher "lane" whenever the next one's own estimated text box (`TAG_CHAR_PX`, a
character-budget estimate in the same spirit `NAME_MAX` already uses for a floor's own name — this
module never measures a real glyph) would otherwise overlap the last one placed in its lane; every
lane shares one height (`topTipY`, the highest of every shown tag's own tip) rather than each tag's
own tip lifted by the same amount — a bug found live (below) that the first version got wrong.
Every tag (and the overflow tag) is clamped left of the floor label column (`FacadeModel.labelX`,
newly exposed), so a tag can never reach into a floor's own name.

**Requirement 2 — the rooftop plaque, always drawn**: `RoofPlaque` (`geometry.ts`) is a short,
static post at the roof's own front-left (x=0.3 in grid units — provably clear of the left AC unit,
0.6-1.9, and the leftmost stub, ≥0.8, for every width `facadeOf` accepts), carrying "MCP" /
"Switchboard" text. Decision: drawn always, not only while a line is live — opacity 0.4 at idle,
1.0 once any line is active. A wholly idle building (the first thing a new viewer is likely to see)
would otherwise offer zero explanation for a bare antenna row; dimming rather than hiding is the
same choice a free desk's own window already makes, and the brightness change still carries the
"is anything live right now" signal honestly.

**Requirement 3 — the hover/focus tooltip**: every lit stub (and the mast, while a Fairmind line is
live) is wrapped in a `<g class="antenna" tabindex="0" role="button" aria-label={antennaTooltip(line)}>`.
`role="button"` (not `role="group"`) satisfies `svelte-check`'s own `a11y_no_noninteractive_tabindex`
rule (part of `npm run typecheck`'s `--fail-on-warnings`) for a focusable element that does nothing
on click or Enter/Space — the nearest honest ARIA fit for "a focusable target that reveals more on
focus." The visible tooltip text (`.call-tip`, `ui/lib/words.ts`'s `antennaTooltip`: server [+
family], tool, caller, a "+N more calls" count past one — server/tool *names* only, never a call's
own inputs, `antennaTooltip`'s own type signature makes this structurally impossible) is revealed
via `.antenna:hover .call-tip, .antenna:focus-visible .call-tip`, the identical CSS disclosure
pattern `.floor:hover .outline, .floor:focus-visible .outline` already uses a few lines below in
the same file — so a keyboard-only user gets the same information a mouse user does, and the
`aria-label` carries it to a screen reader regardless of whether the visual box renders at all.

**Legend**: `BuildingPanel.svelte`'s existing `<ul class="legend">` gained one static entry past the
state-driven ones — "Rooftop antennas — MCP servers in use right now; FairMind lights the mast in
teal." — with a new `.sw-mcp { --sw: var(--fairmind-teal) }` swatch rule in `base.css`, reusing the
legend's existing swatch mechanism.

**Two bugs found live, not by inspection, and fixed** (both from the mandatory visual check against
the real built demo, `node dist/bin.js demo`, neither predicted by reasoning about the algorithms
alone):

1. *Tag lane height, not a real gap*: `layoutAntennaTags`'s first version lifted each bumped tag
   from *its own* antenna's tip (`tipY - TAG_LIFT_PX - lane*TAG_LANE_PX`). Adjacent stubs' own tips
   sit at slightly different screen heights (the isometric projection's own x-skew: a stub further
   right projects slightly lower even at the same world height), so two tags in "different" lanes
   could land only a few px apart instead of the intended `TAG_LANE_PX` gap — found screenshotting
   Playwright (slot 5) and Slack (slot 6) landing 3.2px apart, not 16. Fixed by lifting every lane
   from one *shared* height (`topTipY`, the highest of every shown tip) instead.
2. *Tooltip vs. the plaque, and vs. a neighbouring tag*: the hover/focus tooltip, first anchored
   `tipY - 48` with no horizontal clamp, could read over the plaque's own "MCP / Switchboard" text
   when its own content was long (a long caller name plus a long tool verb, centred on the mast —
   the roof's own rightmost point); separately, anchored purely from its own tip, it could also
   land on a *neighbouring* antenna's own tag (focusing Playwright on slot 5 put its tooltip on
   slot 6's own "Slack" tag) — the identical shared-baseline problem bug 1 already needed fixing,
   for the identical reason. Fixed in two parts: `AntennaTagLayout` gained `topY` (the highest point
   any tag reaches), which every tooltip now anchors above, never its own tip; and `tooltipAnchor`
   (new) computes the real room between the plaque and the floor label column and shortens the
   *visible* tooltip text (trailing '…', never the `aria-label`, always full) when the text needs
   more room than exists — provably guaranteeing both boundaries hold for every input, rather than
   picking one to silently violate when a narrow building and a long tooltip can't both be cleared.
   A first attempt at this (just widening the plaque's own clearance margins) visibly did nothing,
   because the floor-label-column bound — not the plaque — was the one actually deciding the
   tooltip's position in that case; truncation is the only fix that holds in general.

**Testing**: `test/core/tool-label.test.ts` and `test/scene/build.test.ts` cover `McpCall.tool` and
`ActiveLine.tool`/`.caller` (first-tallied-wins, the caller-naming fallback chain for a session vs.
an intern vs. a meeting agent). `ui/test/facade/geometry.test.ts` covers `layoutAntennaTags` (tag
content, TAG_MAX + overflow, left-to-right lane placement, the lane-height regression, no overlap
with the label column), the plaque's static placement, and `tooltipAnchor` (centred for a short
tooltip, nudged clear of the plaque when there's room, shortened with both boundaries holding when
there isn't — the exact regression). `ui/test/components/Facade.test.ts` covers the plaque's
always-on/brightens-when-live behaviour, tag text and TAG_MAX+overflow in the rendered DOM, the
`aria-label`/`tabindex`/visible-tooltip-text on both a stub and the mast, no antenna wrapper while
idle, and the CSS hover/focus-visible reveal (grepped from the component's own `<style>` text, the
existing convention this file already uses for every other static CSS assertion). `ui/test/lib/
words.test.ts` covers `antennaTag`/`antennaTooltip`, including an adversarial-string test proving
no input can leak through (`antennaTooltip`'s own type signature only accepts five known fields).
`ui/test/components/BuildingPanel.test.ts` covers the new legend entry.

**Visual verification**: screenshotted the real built demo (`node dist/bin.js demo`), signed in via
Playwright exactly like `e2e/smoke.spec.ts`, polling `/api/scene` for `activeLines` to catch real
MCP beats rather than guessing at timing: the building at idle, with exactly one generic line lit,
with several lines including a live Fairmind line, a tooltip open (via keyboard focus — `.hover()`
on a thin SVG line/`<g>` proved an unreliable pointer-hit-testing target in headless Chrome and kept
racing the element's own re-render, so the check moved to `.focus()`, which is also the more
representative test of "keyboard accessible"), the night theme, and a 390px-wide viewport. Iterated
seven times against the real demo until no overlap remained anywhere in that matrix.

## 12 — Parallel MCP calls, and friendly server names

Date: 2026-10-19. Status: implemented. A live test of hopper-hq against a real Claude Code session
found the bug Phase 1's own §1 scope note had already named and accepted as a limitation: one turn
called six MCP servers in parallel (`clickup`, `Notion`, `Google_Calendar`, `Gmail`, `Google_Drive`,
`slack`) in a single message, and the rooftop lit at most one antenna — every entity's own `call`/
`callAt` pair (core/types.ts) held only its single most-recently-started call, so each parallel
`tool.started` silently overwrote the last, not just on the floor's one `openTool` slot (an accepted
limit, still true) but in `activeLinesOf`'s own building-wide tally too (not an accepted limit —
nothing in the design ever called a session's own *concurrent* calls out of scope, only a *session's
headset* showing one call at a time). Alongside it, the same real session's tool names (MCP server
ids straight off the wire: `claude_ai_Notion`, `plugin_slack_slack`) showed up verbatim everywhere a
server name is displayed, never rendered as anything a person would recognise.

**Parallel calls — the data model**: `Session`/`ChildAgent`/`RunAgent` each gain `calls?: Record<string,
OpenCall>` (core/types.ts, `OpenCall = { call: McpCall; callAt: number }`), keyed by toolId — every
one of the entity's own MCP calls currently tracked, alongside its pre-existing `call`/`callAt` pair
(unchanged: still the single most-recent, read unconditionally by every pre-existing consumer).
`reducer.ts`'s `withCall` upserts an entry on every MCP `tool.started` (falling back to a key built
from the event's own `seq` when an adapter names no toolId, so two such calls never collide on one
empty key); `withoutCall` deletes only the matching toolId on that call's own `tool.finished` — a
sibling call, still open or still within its own `MIN_HOLD_MS` hold, is untouched. Bounded at
`MAX_OPEN_CALLS` (50), oldest dropped first, since a call whose end is never reported (a vanished
subagent) would otherwise sit there forever. `openTool`'s own single-slot `calls` counter (a
different, already-shipped mechanism — the main agent's currently-open tool, cleared the moment it
closes) is untouched: this feature does not touch the "Running …" label's own single-latest-tool
limit, only the MCP call identity underneath it.

**Parallel calls — the scene projection**: `build.ts`'s `liveCalls(calls, now, call, callAt)` reads
every live entry of the map (`now - callAt < MIN_HOLD_MS`, the same rule `headsetOf` already applies
to a single call); when the map has none live, it falls back to the entity's own `call`/`callAt`
pair — the fallback both covers a call held past its own `tool.finished` within its own min-hold
tail (`withoutCall` already removed it from the map, by design) and keeps every pre-existing fixture
and a session restored from a store saved before `calls` existed reading exactly as a single live
call always did; no double-count is possible, since `call`/`callAt` are themselves always one of the
map's own entries by construction whenever the map has anything live at all. `OnCallView` gains
`count?: number` (SCENE_VERSION 10 → 11): how many of the entity's calls are concurrently live right
now, omitted past a single call so every pre-existing `OnCallView` literal (fixtures, snapshots)
still typechecks unchanged. `activeLinesOf` now tallies every one of an entity's own live calls, not
only its single most-recent: a session with six parallel calls to six distinct servers now lights
six slots instead of one — `ActiveLine.count` itself needed no shape change, since it already tallied
live calls building-wide; it simply tallies more of them per entity now.

**Parallel calls — the floor and the DOM chip**: the robot still wears one headset, showing its
most-recent call's own colour (a robot has one earpiece, not several) — `labels.ts`'s `callText` and
`DeskPanel.svelte`'s "Running" line both append a `×N` past `OnCallView.count > 1`, e.g. `Notion:
search ×6 ✗`, the chip's own trace of a parallelism its one colour cannot show. The façade's own
`ActiveLine.count` (already rendered as `Facade.svelte`'s `+N` busiest-line badge) needed no change
at all to read correctly once it tallied more calls per entity — the rooftop was always the one
honest read of building-wide parallelism; the floor headset's own single-colour limit is unchanged
and, for one robot wearing one headset, intentional.

**Friendly server names**: `friendlyServer` (`src/scene/text.ts` — not `tool-label.ts`, which only
`ui/test/hygiene.test.ts`'s own `SHARED` allowlist does not let the browser import at runtime, and
not `ui/lib/words.ts` either, since `src/core/tool-label.ts`'s own `toolLabel` needs it server-side
too; `scene/text.ts` is the one module already shared, by design, between the server and the
browser) maps a server token — already stripped of its `plugin_<plugin>_`/`claude_ai_` prefix by
`tool-label.ts`'s own `resolveServer` — to its own brand spelling: ClickUp, Slack, Notion, Gmail,
Google Calendar, Google Drive, Google Sheets, Microsoft 365, MongoDB, Playwright, Fireflies, Chrome,
FairMind, Memory, matched loosely (underscores, hyphens, case) the same way `ui/facade/geometry.ts`'s
own `glyphKeyOf` already matches its eight glyphs; an unlisted server Title Cases instead, underscores
turned to spaces ('my_internal_server' → 'My Internal Server'). Used everywhere a server name is
shown — `toolLabel`'s own 'server: tool' label (so the DOM chip and the side panel's "Running" line,
which both read that one string, get it for free), the rooftop tag and the hover/focus tooltip
(`ui/lib/words.ts`'s `antennaTag`/`antennaTooltip`), and the façade's own letter-fallback sign
(`Facade.svelte`) — while every lookup keyed by the server's own raw, canonical token (`glyphKeyOf`,
`slotOf`, `ActiveLine.server`/`McpCall.server` themselves) is untouched: `friendlyServer` only ever
picks what a person reads, never an identity anything else looks up by. Fairmind keeps its own raw
spelling in the label unconditionally (`labels.ts`'s own `tagTitle` doc comment already named this as
deliberate) — `toolLabel` checks `resolveServer`'s own `fairmind` flag before applying it.

**Testing**: `test/core/reducer.test.ts` and `test/core/reducer.runs.test.ts` cover `withCall`/
`withoutCall` end to end — interleaved started/finished for six servers on the main agent (mirroring
the real report), a run agent's own two-parallel-call case, each finish removing only its own toolId,
and `MAX_OPEN_CALLS`'s own bound. `test/scene/build.test.ts` covers `liveCalls`'s fallback (`calls`
present-and-empty vs. absent entirely), the headset's own `count`, and `activeLinesOf` lighting six
distinct slots from one session's own six concurrent calls. `test/adapters/transcript.test.ts` covers
the adapter emitting one `tool.started` per `tool_use`, each its own toolId, when an assistant turn
already carries several MCP calls in one message (the real shape Claude Code's own transcript already
takes for a parallel tool-use turn — no adapter change was needed there, only a test naming it).
`test/scene/text.test.ts` covers `friendlyServer` for every known brand and the Title-Case fallback;
`test/core/tool-label.test.ts` covers `toolLabel`'s own friendly-name substitution and Fairmind's
exemption from it; `ui/test/lib/words.test.ts`, `ui/test/components/Facade.test.ts` and
`ui/test/facade/geometry.test.ts` (a `Google_Sheets` regression alongside the existing `GoogleSheets`/
`Google Sheets` cases) cover the display surfaces. `test/adapters/demo.test.ts` covers a new demo beat
(below) calling all six of the real report's own servers in parallel from one session, none finishing
before the others.

**Budget**: re-measured honestly against both existing budgets, neither raised. `test/scene/
budget.test.ts`'s `JSON_BUDGET` (the fullest floor's wire JSON) needed no re-measure: that fixture
never sets an open MCP call, so `OnCallView`'s new optional `count` field never serialises regardless
of how it is measured — the same reasoning Phase 3's own budget note already gave for the identical
case. `ui/test/renderer/budget.test.ts`'s `SWITCHBOARD_BUDGET` needed no re-measure either: nothing in
this follow-up adds, removes or resizes a mesh — the headset and the Fairmind forms are still built
from a single `OnCallView` exactly as before, `count` read by neither.

**Demo**: `demoScript` (`src/adapters/demo.ts`) gained a new beat — the dependency-investigate desk's
own session (`demo-oa-g7`, already idle in this window) places all six of the real report's own
servers at once (49-50.7s), none finishing before the others, so a single floor screenshot can show
one desk's headset reading `×6`, while the rooftop lights six distinct antennas (colliding slots
probe to the next free one). The doc comment at the top of `demoScript` and its own event-count assertions
(`test/adapters/demo.test.ts`) were updated for the twelve MCP beats this now totals, up from eleven.

**Visual verification**: screenshotted the real built demo (`node dist/bin.js demo --port 17331`),
signed in via Playwright exactly like `e2e/smoke.spec.ts`, timed to the new beat's own 49-50.7s
window: the building's home view with four antennas lit at once from the one dependency-investigate
desk, each carrying its own friendly-name tag (ClickUp, Notion, Google Calendar, Slack — none of them
the raw, prefixed wire spelling), and the floor view showing that desk's own robot with its headset's
`×6` chip (the single headset's own count of every concurrently-live call, independent of how many of
them land on a distinct rooftop slot).

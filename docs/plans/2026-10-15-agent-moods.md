# Hopper HQ — "Agent moods" design: the mega sigaro and the aperitivo/biliardino

Date: 2026-10-15
Status: implemented
Builds on: `2026-10-09-hopper-hq-design.md` (§4 adapters, §10 scene), `2026-10-13-m3a-detail-design.md` (§4 scene v2, interns and meeting rooms), `2026-10-13-m3b-motion-design.md` (§7.1 mesh/draw budget, §8 demo)

## 1. Scope

Two whimsical, standalone visualizer features, with no new dependency, no DB, and no change to
how a session or subagent is detected or reported — both ride the existing adapter -> collector
-> reducer -> scene-build -> renderer seam (`2026-10-09-hopper-hq-design.md` §4/§10).

- **Feature B, "mega sigaro"**: a session or subagent running a *smoke test* looks like it is
  smoking a huge cigar, with a small smoke puff rising from its tip. It clears the moment the
  tool closes.
- **Feature A, "aperitivo/biliardino"**: a subagent that has finished while a sibling under the
  same parent (another intern of the same session, or another agent of the same workflow run) is
  still running goes to the office's break area instead of sitting idle. *If the hour allows*, it
  holds a gin tonic at the bar cart, alone, or plays table football (biliardino, which needs two
  players) paired with another waiter. Outside those hours it holds a coffee at the machine
  instead (OQ-3, below) — never idle in the open; always away at the break area.

**In scope**: detection heuristics (pure core), the two new scene fields and the `SCENE_VERSION`
bump that carries them, the break-area furniture and its walk spots, the renderer's cigar/puff
and leisure props, and making both visible in `hopper-hq demo` / `hopper-hq demo --showcase`.

**Out of scope**: a per-day-of-week leisure schedule (`LeisureWindow.days` is reserved but not
read); more leisure activities; smoking or leisure for a session with a desk but no running work
(a session itself never smokes unless its own tool is open, and never gets a leisure pose — only
subagents and run agents wait at the break area).

## 2. Feature B: smoke-test detection

`isSmokeTest(tool, input)` (`src/core/tool-label.ts`) is pure, no I/O, no `Date`. It flags:

- a `Bash` command that both invokes a test runner (`npm|pnpm|yarn|npx|bun` with `run`/`test`, or
  a runner binary — `playwright|vitest|jest|cypress`) **and** either contains the word "smoke",
  names a `*smoke*.(spec|test).[tj]sx?` file, or has a `/smoke/` path segment; or matches an npm
  script named `test:smoke`/`run:smoke` etc. on its own, runner or not;
- a `Skill` tool call whose skill name contains "smoke" (case-insensitive);
- an `mcp__playwright__*` call whose input holds a smoke-test file path.

The flag rides the existing `tool.started` event as `smoke?: boolean` (`src/core/types.ts`), set
by whichever adapter calls `isSmokeTest`. The reducer (`src/core/reducer.ts`) turns a
`tool.started{smoke:true}` into `smoking: true` on the entity whose tool it is — the session's own
`OpenTool`, a `ChildAgent` (intern), or a `RunAgent` (workflow agent) — and clears it on
`tool.finished` or whenever the agent itself finishes while still "smoking" (so a cigar never
survives its owner). A session only smokes while its tool is actually open (`working` or
`no_signal`); a subagent or run agent only while `running`.

The demo and showcase scripts set `smoke: true` directly on a `tool.started` event, since they
emit `RawEvent`s straight to the collector rather than going through an adapter that calls
`isSmokeTest` — see §5.

## 3. Feature A: leisure detection

`src/core/leisure.ts`, all pure, no I/O:

- **`inLeisureWindow(now, window, hourOf)`**: `hourOf` (default: `new Date(now).getHours()`,
  the viewer's local hour — hopper-hq is local-first) against a `{ fromHour, toHour }` window
  (`src/config.ts`). `toHour <= fromHour` wraps past midnight. **OQ-1**: the default window is
  `{ fromHour: 17, toHour: 2 }` — 17:00 through 01:59, every day — and it is the only clock this
  module reads; tests must inject `hourOf` explicitly to stay timezone-independent
  (`test/core/leisure.test.ts` covers 16:59 out, 17:00 in, 23:59 in, 00:30 in, 01:59 in, 02:00
  out). It is configurable by passing a different `LeisureWindow` wherever `leisureOf` /
  `Collector`'s `leisureWindow` option is used; `days` is reserved for a future per-day-of-week
  restriction and is not yet read.
- **`waitingSubagents(agents)`**: the finished ids among `agents`, only when at least one sibling
  is still running (empty otherwise — nobody to wait for, or everybody's still running).
- **`assignLeisure(waitingIds, inWindow)`** (**OQ-2**): outside the window, every waiter gets
  `'coffee'` (OQ-3, below), whatever the count. Inside it, ids are sorted by code unit (so the
  result does not depend on event order) and paired two at a time into `'biliardino'`; a lone
  leftover gets `'gintonic'`.
- **`leisureOf(now, agents, window, hourOf)`**: the above three composed, for convenience.

**OQ-3 (new scope beyond the original conductor plan)**: outside the window a finished subagent
waiting on running siblings does not just sit idle — it is shown taking a **coffee break** at a
coffee machine in the break area, holding a cup. This reached every layer that OQ-2's gin
tonic/biliardino reached: `Leisure`/`SceneLeisure` is `'gintonic' | 'biliardino' | 'coffee'`
end to end (core, scene model, renderer pose/prop), the break area gained a coffee machine next to
the bar cart and the biliardino table (§4), and the renderer's `coffee` pose holds a cup in the
same hand the other two poses hold a glass or the "done" paper (`ui/renderer/robot.ts`).

`waitingSubagents`/`assignLeisure` run per cohort — a session's own interns (`v.children`) and
each workflow run's own agents (`r.agents`) separately (`src/scene/build.ts`'s `leisureMapOf`,
called from both `internsOf` and `meetingAgentsOf`). A session's interns and a workflow run's
agents are never pooled together, so a session with one waiting intern and a workflow run with
two waiting agents on the same floor show a lone gin tonic and a separate biliardino pair at the
same time — this is exactly what the demo exercises (§5).

**Important architectural fact this design and the demo both lean on**: whether the window is
open is a single boolean (`Collector.leisureOpen(now)` -> `inLeisureWindow`), computed once per
scene/floor read from the collector's own clock and `hourOf`. It is *not* per-cohort or per-floor
— every waiting cohort the same `buildScene`/`buildFloorDetail` call touches sees the same
in-window/out-of-window answer. See §5 for what this means for the demo.

## 4. Scene model and break-area placement

`SCENE_VERSION` is **6** (`src/scene/types.ts`), not 5: it went 4 -> 5 when `smoking` and
`leisure` were added to `Occupant`/`Intern`/`MeetingAgent` (Feature B + the OQ-1/OQ-2 core of
Feature A), then 5 -> 6 when OQ-3's coffee machine needed its own fixed decor placement
(`FloorDetail.breakArea`, a `GridRect` alongside `core`, `lounge` and `roomSlots`) and the stand
spots for a third leisure pose. (An earlier draft of this task's work package said 5; this note
records the number actually shipped, confirmed in `src/scene/types.ts` and the `feat/agent-moods`
history.)

- `Intern.smoking` / `MeetingAgent.smoking` / `Occupant.smoking`: `boolean`, mirroring
  `ChildAgent`/`RunAgent`/`OpenTool.smoking` through `build.ts`'s `smokingOf`/`meetingAgentsOf`.
- `Intern.leisure` / `MeetingAgent.leisure`: `SceneLeisure | null`, from `leisureMapOf` (§3);
  `null` while running or with no running sibling to wait for.
- `FloorDetail.breakArea`: one `GridRect`, a bar cart and a biliardino table (and, since OQ-3, a
  coffee machine between them) placed as fixed decor near the lounge, shared by every subagent on
  the floor at leisure, regardless of which session or run they belong to. It is laid out once per
  floor plan, like `core` and `roomSlots`, and the walk grid stays connected around it at every
  plan size (T5's own acceptance criterion).
- The renderer places a waiting intern/agent at a free stand spot of the matching furniture
  (bar cart for `gintonic`, the table's two sides for `biliardino`, the machine for `coffee`) and
  gives its robot the matching pose and hand prop — a glass and lime, a hand on the foosball rod,
  or a cup — never a shadow caster, and never drawn at all for a session itself (only subagents
  and run agents get a leisure pose).

## 5. Demo and showcase (T8)

Both `hopper-hq demo` and `hopper-hq demo --showcase` needed to show both features without
changing what either script is *for* (a believable day in a fake company).

### 5.1 Smoke test

Chosen, per script, by extending an existing idle-forever `Bash` beat that no test asserted on,
rather than adding a new session or subagent:

- **demo** (`src/adapters/demo.ts`): `demo-ss-e5` (search-svc, "Tune BM25 weights with click
  data") already ran `Bash: npm test` for the whole loop with no `tool.finished`. Its label is
  now `Bash: npm run test:smoke` (a label `isSmokeTest` would also flag on its own merits, so the
  demo stays representative of what production detection would say of the same transcript) and
  its `tool.started` carries `smoke: true` explicitly, since the demo emits `RawEvent`s directly
  rather than through an adapter that calls `isSmokeTest`. A new `tool.finished` step at 45s
  clears the cigar, after being visible for most of the 60s loop.
- **showcase** (`src/adapters/showcase.ts`): `sc-pay-3` ("Retry a declined card a second time")
  arrives at sec 18 with `Bash: npm run test:smoke -- retry`, `smoke: true` (the shared `arrive()`
  helper grew an optional `smoke` parameter, defaulting to `false` so every other call site is
  unchanged); a new step at sec 45 closes it with `tool.finished`.

### 5.2 Leisure: forcing the window open for the live demo

`inLeisureWindow` reads the real local hour by default (§3), so Feature A would be invisible to
anyone running `hopper-hq demo` outside 17:00-02:00. `src/daemon.ts`'s `serve()` now passes
`hourOf: () => DEMO_LEISURE_HOUR` into the `Collector` it builds, gated behind `opts.demo` —
`DEMO_LEISURE_HOUR = 18` (18:00, well inside the default window, away from both edges), exported
from `demo.ts` next to `DEMO_LOOP_MS`. This is the same pattern `serve()` already uses for every
other demo-only override (the in-memory store, the summarizer's canned config, the auth code
TTL, the simulated focus driver): one new option on an existing, already-tested parameter
(`Collector`/`leisure.ts` already expose `hourOf` for exactly this purpose —
`test/core/leisure.test.ts`), reached only through `opts.demo`. A real (non-demo) daemon is
unaffected: it still reads the viewer's actual local hour.

### 5.3 Leisure: which cohorts show it, and why no new ones were added

Once the window is open, both scripts' *existing* cohorts already produce both shapes Feature A
needs — no new intern or agent beat was added for this (adding one would have been a second,
redundant source of the same visual; see the task journal for the fuller rationale):

- **demo**: the address desk's two interns (`demo-sw-a1`) hold a lone gin tonic between 6s and
  30s (`demo-a1-explore` finishes while `demo-a1-review` keeps running); the payments desk's
  `checkout-verify` workflow run holds a biliardino pair between 16s and 28s (`demo-wf-0` and
  `demo-wf-1` finish in the Build phase while `demo-wf-2` keeps running) — both windows overlap,
  so a viewer sees a gin tonic and a biliardino pair on screen together.
- **showcase**: `sc-web-2`'s two helpers hold a lone gin tonic between sec 34 and 42; `sc-web-1`'s
  `release-check` run holds biliardino pairs from sec 39 (two or more of its agents finish
  together in a later phase while that phase's own agents keep running) — again overlapping with
  the lone gin tonic window.

### 5.4 "Both an in-window and an out-of-window case, if feasible" (user decision)

Not feasible *live*: §3 established that whether the window is open is one boolean for the whole
scene read, so a single running `hopper-hq demo` process shows either every waiting cohort as
gin-tonic/biliardino, or every one of them as coffee — never a mix, and forcing the window open
(§5.2) is what makes Feature A visible at all regardless of time of day. Building a second,
per-cohort clock to fake both at once would weaken the module's actual contract (one clock, one
window) for a cosmetic gain nothing in the acceptance criteria asks for.

Feasible, and built: `test/adapters/demo.test.ts` and `test/adapters/showcase.test.ts` each
replay the identical script events through two `Collector`s that differ only in `hourOf` — one
forced to `DEMO_LEISURE_HOUR` (in-window: asserts `gintonic`/`biliardino`), one forced to an
out-of-window hour (asserts the same cohorts instead get `coffee`). This demonstrates, from the
same realistic demo data, that both branches of Feature A work — at the layer (collector/build)
where "both at once" is actually meaningful, rather than at the single live render where it isn't.

## 6. Testing

- **Pure core** (`test/core/leisure.test.ts`, `test/core/tool-label.test.ts`): window edges and
  wrap, pairing/coffee assignment, `isSmokeTest` per tool, all with injected time — no test reads
  the real clock.
- **Scene build** (`test/scene/build.test.ts`, "smoking (version 5, feature B)" and "leisure
  (version 5, feature A)"): the reducer -> build round trip for `Occupant`/`Intern`/
  `MeetingAgent.smoking` and `.leisure`, determinism regardless of session order, and the demo
  snapshot (updated deliberately for this task's `smoke`/label change on `demo-ss-e5` — the only
  diff in `test/scene/__snapshots__/build.test.ts.snap`).
- **Renderer** (`ui/test/renderer/budget.test.ts`, `props.test.ts`, `robot.test.ts`): the cigar
  and its puff add meshes and draw calls but never a shadow caster, measured against the fullest
  floor (§7.1 of the m3b design: 3,388 meshes / 3,424 draws / 443 casters with every running
  intern, room agent and working/no_signal occupant smoking, a tenth of headroom rounded down to
  the 3,726/3,766/487 budget); the break area's bar cart, biliardino table and coffee machine are
  measured at full capacity the same way.
- **Adapters** (this task): `test/adapters/demo.test.ts`'s "the demo smoke test (mega sigaro)"
  and "the demo leisure window" describe blocks, and the equivalent two in
  `test/adapters/showcase.test.ts`, assert the beats described in §5 — the smoke cigar's on/off
  timing, and both leisure outcomes from the same events via the two-`hourOf` technique of §5.4.
- **e2e** (`e2e/smoke.spec.ts`, unchanged by this task): already runs with `motion=off`, so the
  smoke puff's animation (which only runs under `animateRobot`) is out of its path; the cigar and
  leisure props themselves are static meshes and show regardless.

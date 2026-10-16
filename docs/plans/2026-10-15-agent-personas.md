# Hopper HQ — "Agent personas" design: a recognisable costume per agent type

Date: 2026-10-15
Status: implemented
Builds on: `2026-10-09-hopper-hq-design.md` (§4 adapters, §10 scene), `2026-10-13-m3a-detail-design.md`
(§4 scene v2, interns and meeting rooms), `2026-10-15-agent-moods.md` (smoking/leisure, the same
adapter -> collector -> reducer -> scene-build -> renderer seam)

## 1. Scope

Every agent-type string the scene already carries (`Intern.type`, `MeetingAgent.type`) gets a
low-poly costume, so roles read apart at floor-view distance: a tech lead's campaign hat, a QA's
deerstalker, a security engineer's sunglasses and earpiece, and so on. The session's own robot
(no type at all) gets a "boss" look instead. Standalone feature, no new dependency, no DB, no
change to how a session or subagent is detected.

**In scope** (this note, task TP3 of the hq-agent-personas plan): making several distinct
personas visible together in `hopper-hq demo` and `hopper-hq demo --showcase`, and documenting
the whole feature (this file + the README subsection). The classifier (TP1) and the renderer
accessories (TP2) shipped first, on the same `feat/agent-moods` branch; this note mirrors their
design as well as TP3's own demo/showcase work, per the work package.

**Out of scope**: a scene-model change (persona is never sent over the wire — see §2); a
server-side classifier (the renderer is the only consumer today); more than one held prop or more
than 4 meshes per persona (§4); a persona for the main session beyond "boss" (§6).

## 2. Data flow: type string -> persona -> accessories

```
scene (Intern.type / MeetingAgent.type, a free-text agent-type string)
  -> src/scene/persona.ts: personaOf(type, kind?) -> Persona   (pure, client-side, no I/O)
  -> ui/renderer/floor-scene.ts: classifies at cast()/place() time, sets Look.persona
  -> ui/renderer/robot.ts: buildPersona() builds the accessories; hasHeadgear()/PERSONA_BODY
     decide the hard-hat suppression and the outfit recolour
  -> ui/renderer/persona.ts: the actual meshes (headgear group on the neck, held-prop group on
     the left arm), toggled per pose by setPersonaVisible()
```

**Key decision (conductor-plan.md): classify client-side, no scene-model change.** `personaOf` is
a pure function of the type string the scene already carries; `src/scene/build.ts` and
`src/scene/types.ts` are untouched and `SCENE_VERSION` stays at **6** (unchanged since
`2026-10-15-agent-moods.md`). This keeps the renderer the only layer that changes — the lowest
merge surface against the concurrent break-area work (bar, gin tonic, biliardino) that landed on
the same branch around the same time.

A session carries no sub-agent type at all (the scene model has no field for one), so
`personaOf` takes an explicit `kind: 'session' | 'subagent'` (default `'subagent'`):
`personaOf(null, 'session')` always returns `'boss'`, regardless of what a type string would have
been — floor-scene.ts calls it that way only for the session's own robot (§6).

## 3. The ordered rule table

`PERSONA_RULES` (`src/scene/persona.ts`) is evaluated top to bottom; the **first match wins**,
case-insensitive, against the full normalized type string (substring match on a short list of
multi-word phrases) and against its whole tokens (split on runs of non-alphanumerics, so a plugin
prefix like `fairmind-coding:` splits harmlessly into `fairmind` and `coding`):

| # | persona | example type | visual cues | meshes |
|---|---------|--------------|-------------|--------|
| 1 | security | `fairmind-coding:Security Engineer` | dark sunglasses + earpiece | 2 |
| 2 | techlead | `fairmind-coding:Technical Lead / Architect` | campaign hat (brim + dome) | 2 |
| 3 | reviewer | `fairmind-coding:Code Reviewer` | white wig + gavel | 3 |
| 4 | qa | `fairmind-coding:QA Engineer` | deerstalker + magnifying glass | 4 |
| 5 | debugger | a type naming debugging/troubleshooting | gas-mask goggles + spray wand | 3 |
| 6 | librarian | `fairmind-coding:Technical Writer` | reading glasses + open book | 3 |
| 7 | designer | `fairmind-coding:Frontend Engineer` | beret + palette | 3 |
| 8 | developer | `fairmind-coding:Software Engineer` | thick glasses + headphones | 3 |
| 9 | explorer | `Explore` | pith helmet + binoculars | 3 |
| 10 | planner | a type naming planning/strategy | pencil behind ear + blueprint roll | 2 |
| 11 | generalist | `general-purpose` | cap + wrench | 3 |
| — | none | `workflow-subagent`, `agent`, null/empty/unknown | plain (today's look) | 0 |

### Priority tie-breaks (explicit, user-called-out)

- `Security Engineer` must land on **security**, not fall through to developer on its `engineer`
  token — security sits at priority 1, well above developer (8).
- `QA Engineer` must land on **qa**, same reasoning — qa sits at 4, above developer.
- `Technical Lead / Architect` must land on **techlead**, not planner (its `lead`/`architect`
  tokens could otherwise only be reached there if nothing claimed them first, and "strategy/plan"
  tokens are a separate rule): techlead sits at 2, above planner (10).
- `Code Reviewer` sits at 3, above developer, for the same reason the `review` token would
  otherwise never be reached by a role that also happens to say "engineer".

## 4. The mesh/shadow budget

**≤4 meshes per persona** (headgear + held prop together), **none a shadow caster**:
`PERSONA_MESHES` (`ui/renderer/persona.ts`) records the real count per persona and
`ui/test/renderer/budget.test.ts`'s "per-persona accessory budget" asserts
`Math.max(...Object.values(PERSONA_MESHES)) <= 4` and `PERSONA_MESHES.none === 0`. Every part a
persona builds passes `{ cast: false }` explicitly — at a persona accessory's size (a sunglasses
bar, a magnifying-glass ring) a shadow draw would cost more than the mesh is worth, the same
reasoning as the hard hat's brim or the smoke-test cigar (`2026-10-15-agent-moods.md`). The
fullest-floor and break-area-at-leisure budgets in the same file were re-measured for this change
(every running intern typed to `developer`, every room agent to `qa`, every session wearing
`boss`) and bumped deliberately; the shadow-caster caps did **not** grow, because a persona's
headgear only ever *replaces* a hard hat that already cast its own shadow (§5) and no persona
accessory casts one of its own — a real drop in casters where the hard hat's dome used to draw,
not a bug.

## 5. Coexistence rules

- **Persona headgear suppresses the workflow hard hat.** `hasHeadgear(persona)` is true for every
  sub-agent persona but `none`; `robot.ts` hides the hard-hat meshes (not skips building them, so
  a later type/persona change can still show them again) whenever it is. A persona with no
  headgear of its own (`none`) keeps the hat, same as today. This rule is moot for `boss`: only
  workflow agents ever wear the hard hat, and a session (the only robot `boss` is assigned to) is
  never a workflow agent, so the question of suppressing it never arises for the boss look itself
  (concurrent work, not in this task's scope — see §6 OQ-1).
- **The held prop lives in the left hand** (the right already holds the paper, the gin-tonic
  glass and lime, or the coffee cup — `2026-10-15-agent-moods.md`), and is **hidden** in the same
  poses that hide those right-hand props: holding (gin tonic, coffee), biliardino, and while
  walking. **Headgear is never hidden** by a pose — it is the persona's primary, always-on
  silhouette cue, the one thing legible at floor distance and on a 0.55-scale intern alike.
- The smoke-test cigar (mouth) and an intern's jetpack (back) occupy neither the head's headgear
  slot nor the left arm's held-prop slot, so they never collide with a persona's accessories; a
  persona that is also smoking or flying on a jetpack shows both without conflict. (A few
  individual headgear/goggle heights were tuned a few millimetres so their bottom edge clears the
  cigar rod's own span — see the per-persona comments in `ui/renderer/persona.ts`.)

## 6. Open questions and the chosen defaults (user-decisions.md, 2026-10-15)

- **OQ-1 — main session → "boss".** New beyond the original conductor plan: every session's own
  robot (kind `'session'`, which carries no type at all) gets a manager look — a black hat and an
  oversized wide tie kept in the feature colour, with a gold mug held in the left hand —
  regardless of anything a type string could have said. Workflow room agents and interns never
  get `boss`; only a session's own robot does. (The boss look's own renderer implementation is
  concurrent work in `ui/renderer/*`, out of this task's scope — §1; this note describes it only
  to the extent `personaOf`/the classifier side is concerned, §2.)
- **OQ-2 — `workflow-subagent` → no persona.** A workflow agent whose scene type is the generic
  `workflow-subagent` tool name keeps today's plain look (and its hard hat); `personaOf` falls
  through every rule to `none` for it, the same as for `null`/empty/unknown. A workflow agent
  whose *real* agent type is set (because the run started it with a plugin role, not the generic
  placeholder) still gets classified and costumed like any other typed agent — this is exactly
  what TP3's demo/showcase changes exercise (§7): the `checkout-verify`/`release-check` runs type
  their agents to plugin roles, while the `orders-replay`/`migration-replay` runs keep the plain
  `workflow-subagent` type, on purpose, so the two show side by side.
- **OQ-3 — outfit recolour → yes, overriding the original "accessories only" plan.** Each persona
  also recolours the robot's body (the outfit) to a role colour (`PERSONA_BODY`,
  `ui/renderer/persona.ts`): e.g. security's own dark suit, the tech lead's olive drab, the
  librarian's burgundy cardigan. The **tie keeps the feature colour** and the **boss keeps the
  body in the repo colour** — in both cases the thing a viewer needs to read from a desk away
  (which feature, which repo) stays the existing cue; the persona reads at headgear/held-prop
  distance instead.

## 7. Demo and showcase (TP3)

Before this task, `hopper-hq demo` and `hopper-hq demo --showcase` only ever spawned `Explore`
(explorer) and `general-purpose` (generalist) sub-agents, plus workflow agents typed to the
generic `workflow-subagent` (persona `none`). Making several distinct personas visible needed no
new machinery — `demo.ts`'s `runAgent` helper and `showcase.ts`'s `agent` helper already build an
`agent.started` event's `agentType` field; both now take an optional `agentType` parameter
(default unchanged: `'workflow-subagent'`), so only the calls that want a persona pass one.

- **`src/adapters/demo.ts`**: the payments desk's `checkout-verify` workflow run types its five
  agents to plugin roles instead of the generic placeholder — Plan to
  `fairmind-coding:Technical Lead / Architect` (**techlead**), the two Build agents to
  `fairmind-coding:Software Engineer` (**developer**) and `fairmind-coding:Security Engineer`
  (**security**), Review to `fairmind-coding:Code Reviewer` (**reviewer**), and Ship to
  `fairmind-coding:QA Engineer` (**qa**) — five distinct personas, alongside the address desk's
  existing explorer and generalist interns, seven in total. A finished run agent stays listed in
  its room (not removed), so from 8s (Build starts) to 52s (the run completes) at least three of
  these personas are visible together in the payments desk's meeting room for most of the loop.
  The orders desk's `orders-replay` run keeps the plain `workflow-subagent` type, unchanged — a
  deliberate contrast: a typed run shows a cast, an untyped one shows none (OQ-2).
- **`src/adapters/showcase.ts`**: `release-check` (web1's workflow run) and `a11y-sweep` (web3's)
  are typed the same way — release-check's Plan/Build/Review/Ship agents cover **techlead**,
  **developer**, **security**, **qa**, **reviewer** and **librarian** (`Technical Writer`, for
  "Review the copy and the empty states"); a11y-sweep's agents are all **designer**
  (`Frontend Engineer`). Between sec 15 and sec 39, release-check's Build phase (developer,
  security and qa, all running at once) plus its already-finished-but-still-listed Plan agent
  (techlead) sit alongside web2's own explorer/generalist helpers in the same frame: six distinct
  personas visible together, well before a11y-sweep even starts. `migration-replay` (api1's run)
  keeps the plain `workflow-subagent` type, the same contrast as the demo's replay run.
- Every added type string carries the `fairmind-coding:` namespace, so each of these agents also
  wears the **Fairmind badge** (`src/scene/fairmind.ts`'s `isFairmindAgent`, shipped on this same
  branch) — exercising the badge classifier's namespace-prefix handling end to end, alongside the
  persona classifier's own prefix handling (§3: a prefix like `fairmind-coding:` splits into
  harmless tokens).
- Neither change touches `src/scene/build.ts`, the desk/room caps in `src/scene/layout.ts`
  (`INTERNS_MAX = 3`, `MEETING_AGENTS_MAX = 24`), or any session/workspace data: only which
  `agentType` string an already-existing demo beat carries.

## 8. Testing

- **Pure core**: `test/scene/persona.test.ts` (TP1, unchanged by this task) covers the rule table,
  the tie-breaks and `kind: 'session'` always returning `boss`.
- **Renderer**: `ui/test/renderer/persona.test.ts` and `budget.test.ts` (TP2, unchanged by this
  task) cover the accessory meshes, the hard-hat suppression, the outfit recolour and the
  per-persona mesh/shadow budget.
- **Adapters** (this task): `test/adapters/demo.test.ts` and `test/adapters/showcase.test.ts`
  each gained a test that replays the whole script, runs every `agent.started` event's
  `agentType` through `personaOf`, and asserts at least 5 distinct personas (plus one that the
  demo's existing snapshot/assertions — `test/scene/build.test.ts`'s demo-building snapshot, and
  the one assertion in `test/adapters/demo.test.ts` that pinned the payments desk's Plan agent's
  type — were updated to the new typed value). `showcase.test.ts` additionally asserts that a
  single frame (sec 20) shows at least 6 distinct personas at once, per §7.
- **e2e** (`e2e/smoke.spec.ts`, unchanged by this task): already drives the built demo in headless
  Chrome with `motion=off`; the new personas show as static meshes, same as the existing cigar and
  leisure props, so no new assertion was needed there for this task.

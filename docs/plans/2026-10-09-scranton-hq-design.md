# Scranton HQ — Design

Date: 2026-10-09
Status: validated design, pre-implementation

## 1. Problem

A developer running many coding-agent sessions in parallel (one per repo, several worktrees per repo, dynamic workflows that spawn further agents, plus cloud sessions) loses track of them. Three pains, in priority order:

1. **What is each session doing, and which ones work together?** Session names are derived from the working directory and say nothing about the task. Sessions in different repos often work on the same feature.
2. **Is everything moving, or is something waiting for me?** Sessions blocked on a permission prompt, a question or a plan approval sit unnoticed, locally and in the cloud.
3. **Finished sessions are never archived** for fear of losing their context, so they clutter every view.

## 2. Goals and non-goals

Goals (v1):

- Show every session grouped by feature, with a one-line description of its task.
- Surface every session that needs the user, with the reason, at a glance and outside the dashboard (tmux status bar, and a band above the prompt of every Claude Code session).
- Make archiving safe: keep a searchable, resumable record of every finished session.
- Support Claude Code, local and cloud. Keep the core agent-agnostic so other coding agents can be added as adapters.
- Ship as an open-source project.

Non-goals (v1):

- Acting on sessions: answering prompts, approving permissions, sending messages, launching sessions.
- Desktop notifications, menu-bar app.
- Adapters for agents other than Claude Code (the interface exists, the adapters do not).
- Windows support.
- Multi-user / team views.

## 3. Principles

- **Read-only** towards agent sessions. scranton-hq never writes into an agent's own directories. The Claude Code integration is a plugin (a mod) the user installs and removes with Claude Code's own `/plugin` commands.
- **Local-only.** The server binds to `127.0.0.1`. No telemetry. Nothing leaves the machine except opt-in summaries sent through a provider the user configures.
- **Documented surfaces first.** An agent's own extension API (for Claude Code, its function-hooks plugin API) is the primary live source of state. Undocumented files are used for discovery, backfill, detail and as the fallback when no plugin is installed, and their parsing is confined to adapters.
- **Tolerant parsing.** Unknown fields are ignored, missing fields degrade the view; a format change never crashes the collector.
- **Agent-agnostic core.** Domain names are generic (`Session`, `Agent`, `Workspace`), never vendor-specific.
- **Scene model separate from renderer.** The renderer reads a layout model and knows nothing about agents.

## 4. Architecture

```
sources ──► adapters ──► normalized events ──► SQLite ──► scene model ──► web UI (WebSocket)
                                                   │
                                                   └──► HTTP API ──► CLI / tmux status / Claude Code band
```

- One TypeScript (Node) process: collector, store, API, static UI. Distributed via `npx scranton-hq`.
- Storage: SQLite (events, derived session state, user-side state such as "seen" and manual feature tags, archive with FTS5).
- Transport: plain HTTP API for the CLI and the Claude Code mod; Server-Sent Events push to the UI (one-way is all the UI needs, and it needs no dependency). `EventSource` cannot send headers, so the served page authenticates the stream with a same-origin `HttpOnly` cookie set by the daemon.
- Client store and scene model: framework-agnostic TypeScript modules, shared by the UI, the renderer and the CLI.
- UI chrome (attention bar, panels, archive search, settings): Svelte 5 single-page app built with Vite, served as static files by the daemon. No SvelteKit: there is no server-side routing or rendering to do.
- Renderer: a framework-agnostic TypeScript module on plain three.js (see §10). It receives the scene model and emits selections; the UI mounts it on a canvas and never reaches into it.

### Adapter interface

An adapter discovers sessions and emits normalized `Event`s (`session.started`, `session.state_changed`, `agent.spawned`, `tool.started`, `tool.finished`, `prompt.submitted`, `turn.finished`, `session.ended`, …). Adapters declare the agent kind and the source version range they were verified against.

v1 adapters:

| Adapter | Source | Documented | Used for |
|---|---|---|---|
| `claude-code/mod` | The scranton-hq mod, a Claude Code plugin, posts each session's events to the local API | Yes (function-hooks API, early access) | Real-time state, wait reasons, last action; the band above the prompt |
| `claude-code/fs` | `~/.claude/sessions/*.json`, project transcripts (`*.jsonl`), `subagents/*.meta.json`, `workflows/wf_*.json` | No | Discovery, backfill, subagents, workflow runs, fallback state |
| `claude-code/cloud` | A supported channel for cloud sessions (to be confirmed, see §14) | TBD | Cloud sessions and their state |

Mod transport: the mod hooks Claude Code's native events (`prompt.submit`, `tool.call`, `tool.check`, `agent.spawn`, `turn.complete`, `session.end`) and turns each into a small JSON payload that uses the field names of Claude Code's settings hooks, so one mapper reads them. Hooks only append to an in-memory queue and always continue the session's chain; a timer posts the queue to `127.0.0.1` every half second, and `session.end` posts what is left. A stopped collector costs the session nothing: the queue is bounded and retried. The mod reads the daemon's port and token from `~/.scranton-hq/daemon.json`.

The mod's API is early access. It is verified per Claude Code release (first on 2.1.296), and its tests run with `claude plugin test`. Under `claude -p`, the `classic.*` events (the settings hooks' own events) did not reach a `--plugin-dir` mod, so the mod relies on the native events only.

Transcript reading: incremental tailing with persisted offsets; files are never read whole after the first backfill.

## 5. Domain model

- `Workspace` — repo root, worktree path, branch.
- `Feature` — derived grouping key (see §6) or manual override.
- `Session` — agent kind (`claude-code`), location (`local` | `cloud`), workspace, feature, state, wait reason, title, summary, timestamps, resume handle.
- `Agent` — child of a session: subagent or workflow agent; parent reference, type, model, phase.
- `WorkflowRun` — name, phases, agents, status.
- `Event` — append-only normalized event.

## 6. Feature grouping

First match wins:

1. **Manual tag** set in the dashboard. Stored per branch, so it applies to future sessions on that branch.
2. **Ticket ID** extracted from the branch with configurable patterns (defaults cover `ABC-123`, `CU-xxxx`, `#123`).
3. **Normalized branch slug**: strip the type prefix (`feat/`, `fix/`, `docs/`, …) and a trailing repo-name suffix, so `team/r24-rubric-plugins` → `r24-rubric`.
4. **No feature**: trunk branches (`main`, `master`, `dev`), detached `HEAD`, and agent-generated worktree branches. The session belongs to its repo's department.

Recommended convention for users: `<type>/<feature-slug>`, identical across repos. Near-duplicate slugs (e.g. `q-detail` vs `question-details`) are surfaced as a merge suggestion, never merged automatically.

## 7. Session states

| State | Entered on | Left on |
|---|---|---|
| `needs_you` | Permission request, `AskUserQuestion`, plan approval, cloud "waiting on a human" | User reply / prompt |
| `done` | Turn finished (`Stop`) | User prompt, marked seen, or after 4 h → `idle` |
| `working` | Prompt submitted, tool activity, transcript growth | Turn finished |
| `in_meeting` | Session idle but with running subagents or workflow agents | Last child finishes → `done` |
| `no_signal` | `working` with no event for N minutes | Any event |
| `idle` → `dormant` | `idle` for 3 days → dormant, archive candidate | User prompt |
| `ended` | `SessionEnd` or process gone → archive record | Resume |

Rules:

- The wait reason is shown verbatim ("Permission: Bash `rm -rf dist`", "Question: which database?", "Plan approval").
- `in_meeting` prevents a background workflow from producing a false `done`.
- `no_signal` never accuses: if the last event is a tool that started and did not finish, the label is "running `npm test` for 12 min".
- Source precedence: fresh hook events win; without hooks, state comes from `sessions/*.json` (no wait reason, ~1 s latency).
- Liveness: a local session is alive only if its PID exists and the process start time matches, so recycled PIDs do not resurrect dead sessions.
- "Seen" lives in the app database; agent sessions are never touched.
- All thresholds are configurable defaults.

## 8. Attention queue and status line

- Two sections: **Needs you** (longest wait first), **Done, to review** (oldest first). `no_signal` appears only as a soft marker on its floor.
- Visible at every navigation level. Clicking an entry navigates to the floor and desk.
- `scranton-hq status --format tmux` prints a compact counter (e.g. `◉2 ✓3`); the format is configurable for other status bars.
- With the mod installed, every Claude Code session shows a band above its prompt while another session waits or has finished: `◉ 1 waiting · orders-api-c3: Bash  [Go]  ✓ 2 done`. `Go` jumps to that session's tmux pane and appears only inside tmux. A session never lists itself. The mod raises no desktop notifications: with ten sessions open there would be ten of each.

## 9. Task summaries

Hybrid:

- **Deterministic line, always**: Claude Code's own session title (the `ai-title` entries in the transcript) is the primary task line, backed by the first and latest user prompt and the last action. Free and instant.
- **LLM one-liner, opt-in**: regenerated when the session's topic changes. Default provider runs `claude -p` with a small model on the user's existing account; providers are pluggable (API key, local model).
- Cloud sessions already carry a readable title, used as-is.
- The summarizer runs in a dedicated working directory that the fs adapter ignores, so its own sessions never appear in the building.

## 10. The building (scene)

Levels:

- **Building** — all sessions. The façade shows one window per desk: lit = working, red = needs you, dark = idle/dormant.
- **Floor** — one per group key: a feature, or a repo department for sessions without a feature.
- **Island** — inside a floor, one per repo/worktree. On a feature floor each island is a different repo working on the same feature.
- **Desk** — one session. Cloud sessions carry a "remote" badge. Clicking a local desk focuses its tmux pane (local action, the session is not touched).
- **Interns** — subagents next to their parent desk.
- **Meeting room** — a running workflow; the whiteboard shows phases, agents enter and leave.
- **Basement** — the archive (§11).

Floor order is stable (newest on top) to preserve spatial memory. Floors where everyone is dormant lower their shutters; after N days they move to the basement.

Rendering:

- 3D diorama in WebGL (three.js): orthographic isometric camera that rotates around the vertical axis, zooms and pans. Walls facing the camera are cut away.
- Everything is built from primitives in code (rounded boxes, cylinders, spheres): no model files, no rigging. Colors come from theme tokens, so light and dark themes (day and night) share one scene.
- Characters walk on a grid with A* pathfinding. Walking, sitting and gestures are procedural (pivot rotations), not skeletal animation.
- Labels, placards and the selection UI are HTML overlaid on the canvas, positioned by projecting 3D points.
- Level of detail: only the open floor is rendered in detail; other floors render as façade. The server streams the façade summary to all clients and floor detail only for the subscribed floor.
- The render loop pauses when the tab is hidden.

Characters encode information, not decoration:

| Channel | Meaning |
|---|---|
| Body color | Repo |
| Silhouette and size | Kind: session, subagent, workflow agent |
| One fixed accessory | Feature (visible across floors) |
| Location and pose | State: at the desk typing (`working`), standing and waving (`needs_you`), holding the result (`done`), at the meeting table (`in_meeting`), still at the desk (`no_signal`), in the lounge (`idle`), gone home (`dormant`) |
| Badge above the head | State again, readable when characters are small |

Character style: robots with a monitor head and a glowing visor. Subagents are small and hover on a jetpack; workflow agents wear a hard hat; the tie carries the feature colour.

Movement is the main signal: a state change is seen as a character walking somewhere, not read from a label. Subagents and workflow agents arrive and leave through the elevator.

Reference prototypes (single HTML files, sample data, no build): `prototypes/building-mockup.html` (façade and floor directory, SVG) and `prototypes/floor-3d-mockup.html` (one floor as a 3D diorama with a scripted simulation).

## 11. Archive (basement)

- Every ended or dormant session leaves a record: feature, repo/branch/worktree, title, summary, outcome (final assistant message), linked PR when found in the transcript, dates, duration, resume handle (`cd <cwd> && claude --resume <id>` locally, URL for cloud).
- Full-text search (SQLite FTS5) over title, summary and user prompts; records grouped by feature.
- Archive candidates: dormant ≥ 3 days, worktree removed, or branch merged (read-only git check). Confirmed in batch.
- If the worktree was removed, the record says so: it must be recreated at the same path before resuming.
- Archiving is app-side only in v1; closing the real session stays with the user.

## 12. Error handling and security

- Format drift: the adapter skips the record, counts the error and shows a banner ("Claude Code x.y.z not verified, some details may be missing").
- Collector down: the mod keeps a bounded queue and retries, and never blocks or refuses anything in the session; on restart the fs adapter backfills.
- No mod installed, unreachable cloud, failed summarizer: each degrades its own part; the rest keeps working.
- Local API protection: any website can send requests to `localhost`, so the API checks `Host` (against DNS rebinding) and `Origin`, and requires a per-install token. This matters most for endpoints with local side effects (tmux focus).
- Transcripts may contain secrets: nothing is exported; fixtures committed to the repo are redacted.

## 13. Testing

- **Adapter contract tests**: redacted fixtures per supported Claude Code version → expected normalized events.
- **Unit tests**: state machine (event sequences → state), feature rule (branch → key).
- **Scene snapshots**: domain model → layout model.
- **Demo mode**: `scranton-hq demo` is an adapter that emits scripted normalized events, so synthetic sessions flow through the real pipeline. Used for UI development, README screenshots and contributors without a fleet of live sessions.
- **Pure functions first**: pathfinding, state → target (location, pose, gesture), feature rule and layout generation are pure and unit-tested; the render loop stays thin.

## 14. Milestones

- **M0 — Spikes**: find a supported channel to observe cloud sessions; static isometric mockup with synthetic data to validate the visual style.
- **M1 — Collector**: fs adapter, the Claude Code mod (event forwarding and the band above the prompt), SQLite, state machine, feature rule, HTTP API, tmux status. Useful on its own.
- **M2 — Building**: façade, floors, attention bar, tmux pane focus.
- **M3 — Detail**: LLM summaries, meeting rooms for workflows and subagents.
- **M4 — Basement**: archive, search, archive candidates.

## 15. Open questions

- Cloud sessions: is there a supported, documented channel for a third-party local app to list them with their state? If not, the cloud adapter ships as experimental or is limited to sessions bridged from local ones.
- Default thresholds (`done` → `idle`, `idle` → `dormant`, `no_signal`) need tuning on real usage.
- The mod API is early access and changes between Claude Code releases; the minimum supported version must be pinned and the mod's tests rerun on each release.

## 16. Naming and licensing

- Name: `scranton-hq`, an unofficial fan tribute to the TV series *The Office* (US). The product uses no names, logos, characters or quotes from the show; the tribute is acknowledged in the README.
- Not affiliated with Anthropic; "Claude" is not used in the project name.
- License: Apache-2.0. All visual assets are generated in code, so there are no third-party asset licenses.

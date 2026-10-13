# Scranton HQ — M3a "Detail" design

Date: 2026-10-13
Status: validated design, pre-implementation
Builds on: `2026-10-09-scranton-hq-design.md` (§4 adapters, §7 states, §9 summaries, §10 scene)

## 1. Scope

M3 of the original plan ("LLM summaries, meeting rooms for workflows and subagents") ships in two steps.

**M3a, this document: data and static presentation.**
- Workflow runs and subagents are collected live, with the mod first and the filesystem as fallback and detail.
- They are shown as meeting rooms, interns and panels.
- An opt-in LLM line says where each session stands.
- It also takes four layout and colour fixes deferred from M2.

**M3b, designed separately after M3a:**
- motion: aisles between desk rows, A* on the grid, robots walking on state changes (desk, meeting room, lounge, elevator), elevator arrivals and departures;
- mesh instancing;
- decluttering of tags beyond about 40 desks;
- the island wrap rule.

Out of scope for M3a:
- cloud sessions;
- nested `workflow()` runs as separate rooms. A child run's agents carry the parent's run id, so they show in the parent's room.

## 2. Workflow runs and subagents

### 2.1 Model

`WorkflowRun` (design §5), kept per session; the latest 10 runs are retained and running ones are never dropped:

| Field | Meaning |
|---|---|
| `id` | Run id, `wf_…` |
| `name` | Script `meta.name`; null until known |
| `summary` | Script `meta.description` (the launch result's `Summary:` line); null until known |
| `phases` | Phase titles from `meta.phases`, in order; may be empty |
| `currentPhase` | Phase of the most recently started agent of the run; null before the first agent |
| `status` | `running` \| `completed` \| `failed` \| `killed` |
| `startedAt`, `endedAt` | Timestamps; `endedAt` null while running |
| `agents` | The run's agents (id, label, phase, type, running, updatedAt). The latest 64 are kept and running ones are never dropped |
| `agentsFinished` | Count of the run's agents that finished, kept even after old ones are dropped from `agents` |

Workflow agents live on their run, not in `Session.children`. `children` keeps plain subagents only, with their existing cap of 50. A run of 100 agents therefore neither evicts subagents nor loses its counts.

Events:
- **New, `workflow.started`**: carries `runId` plus `name`, `summary` and `phases`, each optional and possibly partial. A later event fills the fields an earlier one lacked.
- **New, `workflow.finished`**: carries `runId` and `status`.
- **`agent.started`** gains optional `runId` and `phase`; its `description` becomes the agent's label.
  - With a `runId`, the agent goes to that run. If the run is unknown, the reducer creates a placeholder run with null name and empty phases.
  - Without one, it is a plain subagent, as today.
- **`agent.finished`** is unchanged. The reducer looks the id up among children, then among running runs.

State rules (design §7, extended):
- A session is `in_meeting` when its main turn has finished and it has a running child or a running run.
- A run that finishes ends all its agents. A session that ends ends all its children and runs, and any run still running becomes `killed`.
- There is no timeout on workflow agents: runs last an hour or more. Session liveness covers dead processes.

### 2.2 Sources

**Mod (live, documented surface).**
- `agent.spawn` already forwards `SubagentStart`. It also forwards:
  - `description`;
  - `workflow_run_id` from `e.workflow.runId`, present only for a workflow script's `agent()`.
- `turn.complete` with an `agentId` is a subagent's loop finishing. Today `hooks.ts` drops it: the `Stop` case returns nothing when an agent id is present. It becomes `agent.finished`.
  - This is why, with the mod installed, a session that ran a workflow never reaches `done` again until it ends: every later turn finishes `in_meeting`. The mod starts the workflow agents, but nothing ever finishes them. The fs scan finishes plain subagents only, because it does not look below `subagents/`.
- The main loop's `turn.complete` forwards `answer`, the final assistant text, truncated in the mod to 4,000 characters, for the summarizer (§3).
- Phases and run names are not on the hooks surface. They come from the filesystem.

**Filesystem (undocumented; detail and fallback).** All paths are under the session's own project directory, `<projects>/<encoded cwd>/<sessionId>/`.

- **Launch, in the parent transcript.** The `tool_result` of a `Workflow` tool call starts `Workflow launched`. It carries:
  - `Run ID: wf_…`;
  - `Summary: …`;
  - `Script file: <path>`.
  This gives a `workflow.started`.
  - The script file is read only when its real path lies inside `<sessionId>/workflows/scripts/`; any other path is ignored.
  - Its `export const meta = {…}` literal is parsed by a small tolerant literal reader. It accepts object, array, string, number, boolean and null literals, reads `name`, `description` and `phases[].title`, and never evaluates code.
  - Size cap: 256 KiB read, meta literal ≤ 64 KiB.
- **Agents.** `subagents/workflows/wf_X/journal.jsonl` is tailed incrementally with the existing jsonl tail helpers.
  - `{"type":"started","agentId","label","phase"}` gives `agent.started` with `runId` and `phase`.
  - `{"type":"result","agentId"}` gives `agent.finished`.
  - `agent-<id>.meta.json` supplies `agentType`.
- **End.** `workflows/wf_X.json` is written once, when the run ends. Its appearance gives `workflow.finished` with its `status`.
- **Budget.**
  - Workflow directories are scanned only for live tracked sessions, on the existing subagent scan interval.
  - On the first scan, a run counts only when its journal was written within `childFreshMs` and has no `wf_X.json`. A long-used machine holds thousands of historical agent transcripts and hundreds of finished runs, and none of them is read.
  - Agent transcripts (`agent-*.jsonl`) are never read, only `stat`ed where needed.

Both sources may report the same agent or run. Every event is keyed by `runId` / `agentId`, and the reducer applies them idempotently.

## 3. "Where it stands" summaries

One line per session, generated by an LLM. It says what is done, what is in progress or what the session waits for, and complements Claude Code's own title (design §9).

### 3.1 Trigger and input

- **Trigger:** a main turn finishes (`done`, `needs_you`, `in_meeting`), and the hash of the input differs from the last summarized one.
- **Pacing:**
  - at most one summary per session every 3 minutes;
  - one request at a time across the daemon;
  - while a session waits in the queue, only its latest input counts.
- **No backfill:** only turns that finish after the daemon started are summarized.
- **Input**, about 4,000 characters at most, assembled from fields the collector already has:
  - the title;
  - the last user prompt;
  - the last 10 actions (cleaned tool labels, a new ring buffer on the session);
  - the last assistant message.
  - The last assistant message comes from the mod's forwarded `answer`, and otherwise from the transcript's last assistant text entry.
- **Instruction (fixed):** one line, at most about 100 characters, present tense, on what is done, in progress or waited for; no preamble.
- **Output** is untrusted text. It goes through `cleanText`, is capped at 120 characters, and is only ever rendered as text.

### 3.2 Providers

The interface is `summarize(input, signal) → Promise<string>`. Two implementations ship.

- **`claude-cli` (default).**
  - Command: `claude -p --safe-mode --model <model> --no-session-persistence --tools "" --strict-mcp-config`.
  - `--safe-mode` (documented in 2.1.296's `--help`) starts with installed plugins, hooks, CLAUDE.md, skills and MCP servers disabled, while OAuth auth works normally. Without it, every summary call would run all of the user's plugin hooks: other plugins' Stop and SessionStart hooks, such as judges and capture tools. They would cost time against the timeout and leave side effects.
  - Default model: alias `haiku`. Input goes on stdin, timeout 60 s, output capped at 16 KiB.
  - It runs with cwd `<dataDir>/summarizer`, created on first use, and with `SCRANTON_HQ_SUMMARIZER=1` in its environment.
  - The summarizer's own sessions are kept out of the building in three ways:
    1. the fs adapter skips session files whose cwd is under that directory;
    2. the collector drops hook events whose cwd is under it;
    3. the mod forwards nothing when `SCRANTON_HQ_SUMMARIZER` is set. This is a backstop in case `--safe-mode` ever loads it.
- **`anthropic-api`.**
  - `POST https://api.anthropic.com/v1/messages` through Node's `fetch`, with no SDK, so there are still no runtime dependencies.
  - Default model `claude-haiku-5-5`, `max_tokens` 100, timeout 30 s.
  - The key is read from `ANTHROPIC_API_KEY` in the daemon's environment and is never written to disk.

### 3.3 Configuration, failure, display

- **Configuration.** A new `<dataDir>/config.json`:
  `{ "summaries": { "enabled": false, "provider": "claude-cli", "model": null } }`.
  - `model: null` means the provider's default.
  - The daemon re-reads the file when its mtime changes, so no restart is needed.
- **CLI.** `scranton-hq summaries on|off|status [--provider claude-cli|anthropic-api] [--model <id>]` writes the file.
  - `status` also asks a running daemon, over the bearer API, for its state: enabled, provider, last success, last error, paused until.
- **Off by default.** The README states exactly what is sent and to whom.
- **Failure.**
  - Per session: back off exponentially, up to 30 minutes.
  - After 3 consecutive failures across the daemon: pause for 15 minutes.
  - A provider that hangs or fails affects nothing else.
- **Storage.** `summary: { text, at, inputHash }` is persisted with the session. A new `lastPromptAt` lets the scene mark a summary as superseded.
- **Display.**
  - Places: the desk panel, the floor panel's rows, and the attention bar entries (as a subtitle).
  - Each shows its age ("12 min ago").
  - The summary is dimmed when a prompt arrived after it.

## 4. Scene (SCENE_VERSION 2)

### 4.1 Model

**`Desk` gains:**
- `summary: { text, at, stale } | null`;
- `interns: { id, type, label, running }[]`: plain subagents, at most 3 shown, with `internsMore` for the rest;
- `away: boolean`: the robot sits in a meeting room instead of at the desk.

`agentsRunning` stays and counts both kinds.

**`FloorDetail` gains** `rooms: MeetingRoom[]` and `roomsMore: number`. A `MeetingRoom` has:
- `runId`, `hostSessionId`, `name` and `summary`;
- `phases: { title, state: 'done' | 'current' | 'upcoming' }[]`;
- `counts: { running, finished }`;
- `seats`: the running agents in start order, at most 8, with `more` for the rest;
- `host: Robot | null`: set when the host session is `in_meeting`;
- `rect`.

**Rooms.**
- One room per running run, on the host session's floor.
- Order: run start time, then run id.
- At most 4 rooms per floor; the rest are counted in `roomsMore` and shown as a "+k runs" sign.
- A finished run's room closes. Its outcome stays in the desk panel.

The façade is unchanged: `in_meeting` windows already show the meeting colour.

### 4.2 Layout

- The meeting wing is a column on the floor's east side, `AISLE` cells right of the islands.
- Rooms are 8×6 cells, stacked north to south: a table with 8 seats plus a head seat for the host, and a whiteboard on the north wall.
- Islands do not move. The floor grows east and south to fit the wing, and the camera framing follows, as it does today when a floor grows.
- The wrap rule and aisles come in M3b.

### 4.3 Renderer

- **Workflow agents:** robots with a hard hat, seated around the table. Body colour is the host's repo; tie colour is its feature.
- **Interns:** small robots on a jetpack, hovering in an arc behind the parent desk's monitor. Desks sit edge to edge, so the desk layout does not change.
- **The host:**
  - `in_meeting` with a running run: it sits at the head seat and its desk chair is empty (`away`). It jumps there; walking comes in M3b.
  - Working while its run goes on in the background: it stays at its desk, and the head seat holds only a placard.
- **Whiteboard:** an HTML overlay anchored to the board, like today's tags. It lists phases (✓ done, ● current, ○ upcoming) and counts ("3 running · 5 done"). At low zoom only the run name stays.
- **Bounds:** shadows stay static, as in M2. The caps (8 seats, 4 rooms, 3 interns) bound meshes and draw calls until instancing lands in M3b.

### 4.4 UI

- **Route:** `#/floor/<key>/run/<runId>`, next to the desk route.
- **Run panel:** name, summary, phases, agents (label, phase, running or finished), and a link to the host desk. "Go", or a double-click on the room, focuses the host's tmux pane through the existing focus endpoint.
- **Desk panel:**
  - the summary line with its age;
  - interns;
  - active runs;
  - the last finished runs, with status and duration.
- **Floor panel rows and attention bar:** the summary as a subtitle.
- **Accessibility:**
  - In the no-WebGL fallback and the screen-reader text, rooms are rows.
  - Room tags join the tab order after the islands.

### 4.5 Demo

`scranton-hq demo` adds:
- a scripted workflow run whose phases advance;
- two interns;
- a `demo` summary provider that returns fixed lines and never leaves the process.

It is the fixture for UI work, the e2e smoke and README screenshots.

## 5. Fixes carried over from M2

All four land first, so the demo slots and the scene snapshot are re-pinned once:

- **Colour slots.** Slots come from the high bits of the hash, `Math.floor(h * slots / 2**32)`. The low bits depend only on code units mod 8 (`web`/`Web` collide).
- **Same-basename repos.** They are told apart by the shortest distinguishing path suffix. This applies to the floor's `repos`, the island label and the repo colour key.
- **Long keys and symlinks.**
  - Floor and island keys beyond the cap become a prefix plus a hash, so two long keys never merge.
  - A cwd outside git is `realpath`ed.
- **Island metadata.** Branch and worktree come from the island's newest session.

## 6. Testing

- **Adapter contract tests** with redacted fixtures for:
  - the `Workflow launched` tool result;
  - a script copy's `meta` (including malformed and oversized ones);
  - `journal.jsonl`;
  - `agent-*.meta.json`;
  - `wf_X.json`;
  - mod payloads: spawn with a run id, a subagent's `turn.complete`, the main `answer`.
- **Reducer sequences:**
  - workflow lifecycle;
  - placeholder runs;
  - the `in_meeting` exit after a run finishes;
  - session end killing runs;
  - caps.
- **Summary pipeline with a fake provider:** trigger, hash dedup, 3-minute pacing, latest wins, backoff, global pause, config reload.
  - `claude-cli` is tested against a stand-in `claude` executable on a temporary `PATH`.
  - `anthropic-api` is tested with a stubbed `fetch`.
  - No test runs the real `claude` or reads `ANTHROPIC_API_KEY`.
- **Scene:** snapshots (v2) and layout unit tests for the wing.
- **Renderer** (happy-dom): rooms, seats, interns, the away host, the whiteboard overlay, picking rooms.
- **UI:** the run route and panel, desk panel additions, summary subtitles, the fallback rows.
- **e2e smoke** on the demo: a room is visible, and clicking it opens the run panel.

## 7. Risks

- The mod API is early access.
  - `workflow.runId` on `agent.spawn` and a subagent's `turn.complete` are taken from the 2.1.296 type definitions and need checking against a real session.
  - The fs path covers the same facts if they drift.
- The launch tool result, the script copy and the journal are undocumented formats. Their parsing stays in the fs adapter, unknown shapes are skipped, and drift degrades rooms to "run in progress" without phases.
- It is unverified whether `claude -p --no-session-persistence` still writes a live session file. The cwd and environment filters make the answer irrelevant.
- `--safe-mode` is taken from `--help` and cannot be exercised by the test suite. The user checks one real summary call before relying on it: no other plugin's hook runs and no session appears in the building.
- Summaries send session text to the configured provider. This is the only data that leaves the machine, and only when the user turns it on (design §3).

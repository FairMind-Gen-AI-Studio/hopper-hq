# scranton-hq

A local dashboard for keeping an eye on your coding-agent sessions while they work.

Every session gets a desk in an isometric office building: one floor per feature, pods of desks for each checkout, interns for subagents, meeting rooms for workflows, a lounge for idle sessions, and a basement archive for finished work. Robots walk between them as sessions change state. A red window on the façade means someone is waiting for you.

Built for Claude Code (local and cloud) first, with an adapter interface meant to welcome other coding agents.

## Status

Early. The collector, the CLI, the tmux counter and the building in the browser work, with meeting rooms for workflow runs, interns for subagents, robots that walk between desks, rooms, the lounge and the elevator, and an optional line that says where each session stands. The archive is planned. See [the design document](docs/plans/2026-10-09-scranton-hq-design.md), [the design of rooms, interns and summaries](docs/plans/2026-10-13-m3a-detail-design.md), and [the design of the floor plan and walking](docs/plans/2026-10-13-m3b-motion-design.md).

## What it does

- Shows which sessions work on the same feature. Sessions are grouped by branch, across repos.
- Shows which sessions are waiting for you, and why.
- Shows what runs inside each session: its workflow runs, phase by phase, and its subagents.
- Says in one line where each session stands, once you turn [summaries](#summaries) on.
- Keeps a record of finished sessions (coming).

## Install

Node 22.13 or later is required.

scranton-hq is not on npm yet. Install it from a clone of this repository:

```sh
npm install && npm run build && npm link
```

Once it is published, `npm install -g scranton-hq` will do the same.

### Upgrading

In your clone, pull the new version and run `npm install && npm run build` again. Then:

1. Restart the daemon: `scranton-hq down`, then `scranton-hq up`. If it runs in the foreground (`scranton-hq start`), stop it with Ctrl-C and start it again.
2. Update the mod: with `/plugin` in Claude Code, or install it again as in [The Claude Code mod](#the-claude-code-mod-recommended).
3. Reload every building tab you had open. A tab opened before this upgrade stops following the building without saying so. From now on, a tab that can no longer follow the building says so and asks for the reload.

The first start after an upgrade that brings the [floor plan](#the-floor-plan) seats every session afresh, once: each takes a desk on its floor's plan, and keeps it from then on, across restarts.

## Quick start

Run `scranton-hq up`. It starts the daemon in the background if it is not running yet, then opens the building in your browser. The daemon writes its log to `~/.scranton-hq/daemon.log`. `scranton-hq down` stops it.

To run the daemon in the foreground instead, in its own tmux window or terminal, use `scranton-hq start`. Then run `scranton-hq ls`, or `scranton-hq ui` to open the building in your browser.

This already works from the files Claude Code writes, without the mod.

## The building

`scranton-hq ui` signs your browser in and opens the building. The daemon must be running. With `--no-open` it only prints the link.

The façade has one floor per feature, shared by every repository working on that branch, and one floor per repository for sessions with no feature branch. Floors keep their place, newest on top. Each window is a desk of the floor's [plan](#the-floor-plan), so a floor shows from outside how large it is and how full:

| Window | State |
| --- | --- |
| Red, pulsing | Needs you: a permission, a question or a plan approval is waiting. |
| Green | Done: it finished its turn and waits for you to look. |
| Lit yellow | Working. |
| Purple | In a meeting: idle itself, while its subagents or workflow agents run. |
| Amber, flickering | No signal: working, but nothing new for a while, often a long command. |
| Unlit (grey by day, dark at night) | Idle, or dormant (idle for days). A floor where everyone is dormant lowers its shutters. |
| Unlit, with a frame | A free desk. |

The bar at the top lists who needs you (longest wait first) and what is done (oldest first) at every level. Click an entry to open its desk; `Go` switches tmux to its pane.

Click a floor to go inside. Each session has a desk and a robot, whose pose and badge show its state. Click a desk or its robot to see what it is doing. Double-click it, press Enter, or use `Go to pane` to switch tmux to its pane.

A desk's panel also lists the session's interns and its latest workflow runs, with how long each has run and how it ended. With [summaries](#summaries) on, it says in one line where the session stands, and so do the desk's row in the floor's side panel and its entry in the bar at the top.

Subagents that a session starts outside a workflow run are its interns: small robots that hover on jetpacks over its desk while they run, three at most.

Each workflow run that is going on has a meeting room, in a wing east of the desks on its session's floor:

- its agents sit at the table as robots in hard hats, eight at most;
- the robot of the session that started the run sits at the head of the table while the session waits for the run;
- a tag over the door names the run, and adds its current phase and its counts up close or when the room is selected;
- up close, the whiteboard lists the run's phases (✓ done, ● current, ○ upcoming) and how many agents run and have finished.

A floor has two rooms, and four once a third run goes on at the same time; its side panel counts the runs beyond four. A run keeps its room until it ends. The room then closes, its door shut and its lights dimmed, and the session's desk panel keeps how the run ended. Click a room or its tag to open the run's panel: its phases, its agents and a link to the session's desk. Double-click the room, press Enter, or use `Go to pane` to switch tmux to that session's pane.

The page's address names the floor, and the desk or the run on screen: a link opens it, and Back and reload keep your place.

| Key or gesture | Does |
| --- | --- |
| Esc | Goes up one level: desk or run, floor, building. |
| Q, E | Turns the floor a quarter left or right. |
| R | Resets the view. |
| Enter | With the floor or the selected desk's or room's label focused, goes to that desk's pane, or for a room to the pane of the session that started its run. |
| Drag, scroll, right-drag | Turns and tilts, zooms and pans the floor. |
| Arrows, Shift + arrows | Once you have clicked the floor, up and down walk ahead and back, and left and right steer. With Shift, up and down tilt the view, and left and right step aside. A focused label keeps the arrows for moving to the next one, and the side panel for scrolling. |

The theme button cycles through system, day and night. A browser without WebGL still lists a floor's desks and meeting rooms in the side panel. When the page can no longer follow the building, because the daemon was updated since it loaded, it says so and asks you to reload it.

Going to a pane switches the most recently used tmux client to it. The daemon talks to the tmux server it was started under, or the default one. It cannot bring the terminal window to the front.

### The floor plan

A floor's plan is fixed: desks, meeting rooms and a lounge that sessions take and leave.

- Desks come in pods of four, back to back on a rug, and pods in blocks of two: eight desks to a block.
- A new session sits in a pod where a session of its checkout sits, else at an empty pod, else at the first free desk. It keeps its desk until it ends or moves to another floor.
- A pod's rug takes its repository's colour while all its sessions share one repository. Its placard names their checkout, or only the repository when that is all they share.
- With no desk free, a new session takes the desk of the session that has been dormant longest, which takes a desk again when one frees up or it wakes. With none dormant, the floor grows by a block, up to four blocks: 32 desks. Further sessions wait for a desk: the side panel lists the first 24, marked "no desk", and counts the rest; the façade counts them all.
- A floor never shrinks while it has sessions. Once the last one leaves, it starts again from one block.
- A dormant session's robot goes home. Its desk stays its own, dimmed, with its name on a nameplate that shows closer in. A click on the nameplate selects the session.
- The lounge runs along the south wall, with eight seats on couches and beanbags. An idle session rests there until its next prompt; with the lounge full, it rests at its desk.

### Walking

Robots walk. A session that comes to a floor steps out of the elevator and walks to its desk; one that ends, goes dormant or moves to another floor walks back into it. As its state changes, a robot walks to its meeting room, to the lounge and back to its desk, round the furniture. Workflow agents walk from the elevator to their seats and back, and interns fly straight to their desk and back. Everyone keeps their seat until they leave. The elevator doors open for each robot that passes.

At rest, robots move a little: a working robot or agent types, one that needs you waves, one that is done holds up its paper, one without a signal dozes, an idle one breathes, and interns bob on their jetpacks.

A floor you open, reload or come back to shows everyone already in place: only what changes while you watch walks. Under your system's reduced-motion setting, robots go straight to their places and nothing moves at rest. So it is with `?motion=off` in the page's address (`/ui/?motion=off`), for screenshots and tests.

### Tags

- From far, which is how a floor first shows on most screens, a robot's tag is a dot in its state's colour, named only while it is selected, needs you or is done. Room tags keep their names, and the pods' placards hide.
- Closer in, every tag and placard shows whole.
- Where two overlap, the one that ranks lower gives way: the selected tag first, then needs you, done, rooms, working, the other states, and placards last. From far, a named tag that gives way keeps its dot where the dot is clear.
- Hover or focus a tag to read it whole: it shows on top of the others, and hides none of them, while you do. Free desks and dormant ones have no tag.

### Signing in

- The daemon listens on 127.0.0.1 only.
- `scranton-hq ui` asks the daemon for a one-time link. It works once, within a minute; the demo's link lasts 10 minutes.
- Opening the link sets a signed, HttpOnly cookie for that daemon's port. It lasts 30 days and survives daemon restarts. To sign every browser out, delete `~/.scranton-hq/token` and restart the daemon.
- A signed-in browser can watch the building, switch tmux panes and mark sessions as seen. It cannot send hook events, ask for sign-in links or stop the daemon. From a browser, changes are accepted only from the daemon's own page.
- The page loads nothing from the network. Scripts, styles and fonts come from the daemon, under a strict content security policy.
- Known risk: browsers do not keep cookies apart by port. Any other server on 127.0.0.1 that this browser talks to, such as a dev server an agent started, receives the cookie. It could reuse it for up to 30 days to watch the building, switch your tmux panes and mark sessions as seen. If that matters to you, sign everything out as above.
- In the demo, `Go` and `Go to pane` are simulated: the page says which pane it would switch to, and tmux is never touched.

## tmux

Add this to your `~/.tmux.conf`:

```tmux
set -g status-right '#(scranton-hq status --format tmux) %H:%M'
set -g status-interval 5
```

`◉` is the number of sessions waiting for you. `✓` is the number of finished sessions you have not looked at. `scranton-hq ack` clears the `✓`.

## The Claude Code mod (recommended)

The mod reports each session as things happen, with the exact reason a session waits. It also shows, above the prompt of every session, who else is waiting for you. A `Go` button jumps to that tmux pane.

Type `/scranton-hq` in any session to open the building. It runs `scranton-hq up`, so it also starts the daemon when it is not running, and it takes no turn of the model. The sign-in link stays out of the conversation. The `Open building` button in the band above the prompt does the same; the band shows only while another session waits for you or has finished. Both need `scranton-hq` on your `PATH`: see [Install](#install).

Install it from a shell:

```sh
claude plugin marketplace add <owner>/<repo>
claude plugin install scranton-hq@scranton-hq
```

To try it from a clone for one session:

```sh
claude --plugin-dir /path/to/scranton-hq/mod
```

Without the mod, scranton-hq still works from the files Claude Code writes. It has up to a second of delay and less detail about why a session waits.

## Summaries

scranton-hq can write one line per session that says where it stands: what is done, what is in progress, or what it waits for. A language model writes the line, so summaries are off by default. To turn them on:

```sh
scranton-hq summaries on
```

The full form is `scranton-hq summaries on|off|status [--provider claude-cli|anthropic-api] [--model <id>]`:

- `on` and `off` turn summaries on and off, and say what is now set. `status`, the default, prints the setting and what the running daemon does: its last summary, its last error, and a pause.
- `--provider` chooses where the notes go, below. `claude-cli` is the default. A `--provider` without `--model` goes back to that provider's default model.
- `--model` names another model: 1 to 64 letters, digits, `.`, `_`, `:` or `-`, starting with a letter or a digit. The defaults are `haiku` for `claude-cli` and `claude-haiku-5-5` for `anthropic-api`.

The setting lives in `~/.scranton-hq/config.json`, readable by you only. The daemon reads it again before each summary, so it needs no restart.

The line shows in the desk's panel with its age, under the desk's row in the floor's side panel, and under its entry in the bar at the top. Once you have sent the session a prompt since, its age says "(older than the last prompt)". The line is then dimmed in the panels, and set in italics in the bar.

### When a summary is written

When a session comes to a stop (it is done, needs you, or waits in a meeting), the daemon waits 8 seconds and reads the session again. Unless it is working again, it asks for a line.

- Only turns that end while the daemon runs are summarized. Notes that have not changed since the last line are not sent again.
- At most one summary per session every 3 minutes, and one at a time across the daemon.
- A failed summary is tried again later, while the session still stands where it did. Each failure makes the session wait longer for its next try: 1 minute, then twice as long each time, up to 30 minutes, and never less than the 3 minutes between two summaries.
- After 3 failures in a row, every summary pauses for 15 minutes. Changing the provider or the model lifts the pause.
- `scranton-hq summaries status` shows the last error and the pause. The daemon's log gets one line per failure, with the error.

### What is sent, and to whom

Each summary sends a fixed instruction and these notes about one session, each cut to one line:

- its title;
- its last request: your last prompt, or the first one;
- its state, with what it waits for when it waits: the tool that asks for permission and its command or file, or the question;
- the labels of its last 10 tool calls, such as `Bash: npm test` or `Edit src/app.ts`;
- its last reply, up to 2,000 characters.

The notes are cut to about 4,000 characters: the end of the reply goes first, then the oldest actions. scranton-hq sends nothing else.

Where they go depends on the provider:

- **`claude-cli`**, the default, runs `claude -p --safe-mode` with the notes on its standard input. It runs on your account: wherever your `claude` sends its requests.
  - `--safe-mode` starts it without your plugins, hooks, CLAUDE.md, skills and MCP servers. It gets no tools and saves no session.
  - It runs in its own directory, `~/.scranton-hq/summarizer`, with `SCRANTON_HQ_SUMMARIZER=1` set. The building leaves its sessions out, and the mod reports nothing from it.
  - Its environment is the daemon's, without `ANTHROPIC_API_KEY`, so it is never billed to a key. It also goes without the variables that tie it to a Claude Code session that may have started the daemon: `CLAUDECODE`, `AI_AGENT`, `CLAUDE_PID`, `CLAUDE_EFFORT`, `CLAUDE_PLUGIN_DATA`, `CLAUDE_PLUGIN_ROOT`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_EXECPATH`, `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_CODE_BRIDGE_SESSION_ID`, `CLAUDE_CODE_SSE_PORT`, and every `CLAUDE_CODE_SESSION_*` and `CLAUDE_CODE_MESSAGING_*`.
  - Every other variable stays, so `claude` signs in, connects and picks its provider as it does for you: `CLAUDE_CODE_OAUTH_TOKEN`, a client certificate, a proxy, `CLAUDE_CODE_USE_BEDROCK` and the like.
  - It needs `claude` on the daemon's `PATH`, and is stopped after 60 seconds.
- **`anthropic-api`** sends the notes to the Anthropic Messages API, at `api.anthropic.com`, with the key in `ANTHROPIC_API_KEY`.
  - The daemon reads the key from its own environment, which it takes from where you ran `scranton-hq up` or `scranton-hq start`. Set it there, and restart the daemon to change it.
  - The key is never written to disk. A request gives up after 30 seconds.

`--safe-mode` is a recent option of Claude Code. Once summaries are on, check that a line appears and that `scranton-hq summaries status` shows the last summary, with no new session in the building.

The demo (`scranton-hq demo`) writes fixed lines of its own and sends nothing anywhere.

### Cost

Each summary is one call to the model, a small one by default. A session gets at most one per finished turn, and one more each time a failed summary is tried again, spaced by the waits above: never more than one every 3 minutes. With `claude-cli` it counts against your account's usage, like any `claude -p`. With `anthropic-api` it is billed to the key.

## Commands

| Command | What it does |
| --- | --- |
| `scranton-hq up` | Starts the daemon in the background unless it is running, then opens the building like `ui`. Use `--no-open` to print the link only. |
| `scranton-hq down` | Stops the daemon. |
| `scranton-hq start` | Runs the daemon in the foreground: collector, file watcher and local API. One daemon runs per data directory. |
| `scranton-hq status` | Prints a summary. Use `--format text`, `tmux` or `json`. |
| `scranton-hq ls` | Lists floors and their sessions. |
| `scranton-hq ack` | Marks finished sessions as seen. |
| `scranton-hq ui` | Opens the building in your browser, signed in through a one-time link. Use `--no-open` to print the link only. |
| `scranton-hq summaries` | Turns the one-line summaries `on` or `off`, or prints how they stand (`status`). See [Summaries](#summaries). |
| `scranton-hq demo` | Runs a daemon with synthetic sessions, and prints a sign-in link for its building. |

## How it works

There are two sources of data: the mod, and Claude Code's own files under `~/.claude`. Both feed one collector. The collector serves a localhost API.

Workflow runs come from both: the mod reports their agents as they start and finish, and the files give each run's name, phases and end.

The files under `~/.claude` are internal to Claude Code and can change between versions. scranton-hq reads them defensively and never writes there. The mod uses Claude Code's plugin API, which is in early access.

## Privacy and security

- scranton-hq listens on 127.0.0.1 only.
- The CLI and the mod authenticate with a token stored in `~/.scranton-hq/token` (mode 600). Browsers sign in with a one-time link: see [Signing in](#signing-in).
- There is no telemetry. Nothing leaves your machine unless you turn [summaries](#summaries) on: each summary then sends one session's notes to the provider you chose.

## Development

```sh
npm test
npm run typecheck
npm run build
npm run test:mod
npm run test:e2e
```

`npm run build` writes the CLI and the daemon to `dist/` and the browser UI to `dist/ui/`.

`npm run test:mod` needs the `claude` CLI. It is not run in CI.

To try it with synthetic sessions, run `scranton-hq demo` (or `node dist/bin.js demo`). Then run `scranton-hq ls --data-dir ~/.scranton-hq/demo`. The demo replays a one-minute script. On its checkout floor, two workflow runs take turns, one starting before the other ends, so a meeting room is always open; five more sessions come and go, so the floor holds nine for a while and grows a block in the first minute; one of them rests in the lounge while it is idle. A desk has two interns, and the summary lines are fixed.

### The browser UI

The UI is a Svelte app in `ui/`, with a three.js renderer for the floors in `ui/renderer/`. To work on it with live reload, run a demo daemon on a spare port with a throwaway data directory, then the dev server:

```sh
npm run build
node dist/bin.js demo --port 17338 --data-dir "$(mktemp -d)"
SHQ_DAEMON=http://127.0.0.1:17338 npm run dev:ui
```

The dev server listens on 127.0.0.1:17173 and forwards `/api` and `/ui/login` to the daemon. Open the sign-in link the demo printed, with its port changed to 17173.

### Browser smoke test

`npm run test:e2e` builds the package and tests it in a real browser. It starts its own demo daemon on a free port between 17000 and 17999, with a temporary data directory. Then it signs in through the demo's link and walks the building, a floor in 3D, a desk, and a meeting room with its run's phases and its session's summary line, in headless Chrome, with `?motion=off`. With walking on, it then waits for a robot to step out of the elevator and reach its desk. It fails on any console error or content-policy violation. Its output goes to a temporary directory that is removed after a passing run and kept after a failing one, so the screenshot and error context stay for debugging.

It runs on the Google Chrome installed on your machine and never downloads a browser. Without Chrome it stops with a message saying so. It is not part of `npm test` and does not run in CI.

## A note on the name

scranton-hq is an unofficial fan tribute to the TV series *The Office* (US). It is not affiliated with, endorsed by, or sponsored by NBCUniversal or any rights holder of the show, and it uses none of the show's names, logos, characters or quotes.

scranton-hq is an independent project and is not affiliated with or endorsed by Anthropic. Claude and Claude Code are trademarks of Anthropic.

## License

[Apache-2.0](LICENSE)

The browser UI bundles the Archivo, IBM Plex Sans and IBM Plex Mono typefaces, under the SIL Open Font License 1.1, and the Svelte, clsx and three.js libraries, under the MIT licence: see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

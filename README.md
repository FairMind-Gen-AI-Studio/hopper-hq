# scranton-hq

A local dashboard for keeping an eye on your coding-agent sessions while they work.

Every session gets a desk in an isometric office building: one floor per feature, an island per repo, interns for subagents, meeting rooms for workflows, and a basement archive for finished work. A red window on the façade means someone is waiting for you.

Built for Claude Code (local and cloud) first, with an adapter interface meant to welcome other coding agents.

## Status

Early. The collector, the CLI, the tmux counter and the building in the browser work. Walking characters, interns, meeting rooms and the archive are planned. See [the design document](docs/plans/2026-10-09-scranton-hq-design.md).

## What it does

- Shows which sessions work on the same feature. Sessions are grouped by branch, across repos.
- Shows which sessions are waiting for you, and why.
- Keeps a record of finished sessions (coming).

## Install

Node 22.13 or later is required.

scranton-hq is not on npm yet. Install it from a clone of this repository:

```sh
npm install && npm run build && npm link
```

Once it is published, `npm install -g scranton-hq` will do the same.

## Quick start

Run `scranton-hq start` in its own tmux window or terminal. Then run `scranton-hq ls`, or `scranton-hq ui` to open the building in your browser.

This already works from the files Claude Code writes, without the mod.

## The building

`scranton-hq ui` signs your browser in and opens the building. The daemon must be running. With `--no-open` it only prints the link.

The façade has one floor per feature, shared by every repository working on that branch, and one floor per repository for sessions with no feature branch. Floors keep their place, newest on top. Each window is a session:

| Window | State |
| --- | --- |
| Red, pulsing | Needs you: a permission, a question or a plan approval is waiting. |
| Green | Done: it finished its turn and waits for you to look. |
| Lit yellow | Working. |
| Purple | In a meeting: idle itself, while its subagents or workflow agents run. |
| Amber, flickering | No signal: working, but nothing new for a while, often a long command. |
| Dark | Idle, or dormant (idle for days). A floor where everyone is dormant lowers its shutters. |

The bar at the top lists who needs you (longest wait first) and what is done (oldest first) at every level. Click an entry to open its desk; `Go` switches tmux to its pane.

Click a floor to go inside. Each checkout gets an island in its repository's colour, with a desk and a robot per session; the robot's pose and badge show its state. Click a desk to see what it is doing. Double-click it, press Enter, or use `Go to pane` to switch tmux to its pane.

| Key or gesture | Does |
| --- | --- |
| Esc | Goes up one level: desk, floor, building. |
| Q, E | Turns the floor a quarter left or right. |
| R | Resets the view. |
| Enter | With the floor or the selected desk's label focused, goes to that desk's pane. |
| Drag, scroll, right-drag | Turns, zooms and pans the floor. |

The theme button cycles through system, day and night. A browser without WebGL still lists a floor's desks in the side panel.

Going to a pane switches the most recently used tmux client to it. The daemon talks to the tmux server it was started under, or the default one. It cannot bring the terminal window to the front.

### Signing in

- The daemon listens on 127.0.0.1 only.
- `scranton-hq ui` asks the daemon for a one-time link. It works once, within a minute; the demo's link lasts 10 minutes.
- Opening the link sets a signed, HttpOnly cookie for that daemon's port. It lasts 30 days and survives daemon restarts. To sign every browser out, delete `~/.scranton-hq/token` and restart the daemon.
- A signed-in browser can watch the building, switch tmux panes and mark sessions as seen. It cannot send hook events or ask for sign-in links. Changes are accepted only from the daemon's own page.
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

## Commands

| Command | What it does |
| --- | --- |
| `scranton-hq start` | Runs the daemon: collector, file watcher and local API. |
| `scranton-hq status` | Prints a summary. Use `--format text`, `tmux` or `json`. |
| `scranton-hq ls` | Lists floors and their sessions. |
| `scranton-hq ack` | Marks finished sessions as seen. |
| `scranton-hq ui` | Opens the building in your browser, signed in through a one-time link. Use `--no-open` to print the link only. |
| `scranton-hq demo` | Runs a daemon with synthetic sessions, and prints a sign-in link for its building. |

## How it works

There are two sources of data: the mod, and Claude Code's own files under `~/.claude`. Both feed one collector. The collector serves a localhost API.

The files under `~/.claude` are internal to Claude Code and can change between versions. scranton-hq reads them defensively and never writes there. The mod uses Claude Code's plugin API, which is in early access.

## Privacy and security

- scranton-hq listens on 127.0.0.1 only.
- The CLI and the mod authenticate with a token stored in `~/.scranton-hq/token` (mode 600). Browsers sign in with a one-time link: see [Signing in](#signing-in).
- There is no telemetry. Nothing leaves your machine.

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

To try it with synthetic sessions, run `scranton-hq demo` (or `node dist/bin.js demo`). Then run `scranton-hq ls --data-dir ~/.scranton-hq/demo`.

### The browser UI

The UI is a Svelte app in `ui/`, with a three.js renderer for the floors in `ui/renderer/`. To work on it with live reload, run a demo daemon on a spare port with a throwaway data directory, then the dev server:

```sh
npm run build
node dist/bin.js demo --port 17338 --data-dir "$(mktemp -d)"
SHQ_DAEMON=http://127.0.0.1:17338 npm run dev:ui
```

The dev server listens on 127.0.0.1:17173 and forwards `/api` and `/ui/login` to the daemon. Open the sign-in link the demo printed, with its port changed to 17173.

### Browser smoke test

`npm run test:e2e` builds the package and tests it in a real browser. It starts its own demo daemon on a free port between 17000 and 17999, with a temporary data directory. Then it signs in through the demo's link and walks the building, a floor in 3D and a desk in headless Chrome, failing on any console error or content-policy violation.

It runs on the Google Chrome installed on your machine and never downloads a browser. Without Chrome it stops with a message saying so. It is not part of `npm test` and does not run in CI.

## A note on the name

scranton-hq is an unofficial fan tribute to the TV series *The Office* (US). It is not affiliated with, endorsed by, or sponsored by NBCUniversal or any rights holder of the show, and it uses none of the show's names, logos, characters or quotes.

scranton-hq is an independent project and is not affiliated with or endorsed by Anthropic. Claude and Claude Code are trademarks of Anthropic.

## License

[Apache-2.0](LICENSE)

The browser UI bundles the Archivo, IBM Plex Sans and IBM Plex Mono typefaces, under the SIL Open Font License 1.1: see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

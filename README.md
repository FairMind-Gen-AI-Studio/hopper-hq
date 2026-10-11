# scranton-hq

A local dashboard for keeping an eye on your coding-agent sessions while they work.

Every session gets a desk in an isometric office building: one floor per feature, an island per repo, interns for subagents, meeting rooms for workflows, and a basement archive for finished work. A red window on the façade means someone is waiting for you.

Built for Claude Code (local and cloud) first, with an adapter interface meant to welcome other coding agents.

## Status

Early. The collector, the CLI and the tmux counter work. The 3D building UI is next. See [the design document](docs/plans/2026-10-09-scranton-hq-design.md).

## What it does

- Shows which sessions work on the same feature. Sessions are grouped by branch, across repos.
- Shows which sessions are waiting for you, and why.
- Keeps a record of finished sessions (coming).

## Install

```sh
npm install -g scranton-hq
```

Node 22.13 or later is required.

From a clone:

```sh
npm install && npm run build && npm link
```

## Quick start

Run `scranton-hq start` in its own tmux window or terminal. Then run `scranton-hq ls`.

This already works from the files Claude Code writes, without the mod.

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
| `scranton-hq demo` | Runs a daemon with synthetic sessions. |

## How it works

There are two sources of data: the mod, and Claude Code's own files under `~/.claude`. Both feed one collector. The collector serves a localhost API.

The files under `~/.claude` are internal to Claude Code and can change between versions. scranton-hq reads them defensively and never writes there. The mod uses Claude Code's plugin API, which is in early access.

## Privacy and security

- scranton-hq listens on 127.0.0.1 only.
- Every request needs a token. The token is stored in `~/.scranton-hq/token` (mode 600).
- There is no telemetry. Nothing leaves your machine.

## Development

```sh
npm test
npm run typecheck
npm run test:mod
```

`npm run test:mod` needs the `claude` CLI. It is not run in CI.

To try it with synthetic sessions, run `scranton-hq demo` (or `node dist/bin.js demo`). Then run `scranton-hq ls --data-dir ~/.scranton-hq/demo`.

## A note on the name

scranton-hq is an unofficial fan tribute to the TV series *The Office* (US). It is not affiliated with, endorsed by, or sponsored by NBCUniversal or any rights holder of the show, and it uses none of the show's names, logos, characters or quotes.

scranton-hq is an independent project and is not affiliated with or endorsed by Anthropic. Claude and Claude Code are trademarks of Anthropic.

## License

[Apache-2.0](LICENSE)

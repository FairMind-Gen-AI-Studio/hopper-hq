# Contributing to scranton-hq

Thank you for helping. scranton-hq is provided by [FairMind](https://fairmind.ai) and open source under the Apache License 2.0. By sending a contribution you agree that it is licensed under the same terms.

## Before you start

- For a bug, open an issue with what you did, what you saw, and what you expected. Say which version of Claude Code and of Node you run, and whether it happens in `scranton-hq demo`.
- For a feature, open an issue first, so that we can agree on the shape before you write it. The [design documents](docs/plans) say why things are as they are.
- For a security problem, do not open an issue: see [SECURITY.md](SECURITY.md).

## Set up

Node 22.13 or later.

```sh
npm install
npm run build
npm test
```

The [Development section of the README](README.md#development) lists every check, and says how to work on the browser UI with live reload against a demo daemon. `scranton-hq demo` plays synthetic sessions, and `scranton-hq demo --showcase` a longer scenario, so you can try a change without a real session.

## Checks

Before you open a pull request, these pass:

```sh
npm run typecheck
npm test
npm run build
```

`npm run test:e2e` walks the building in the Google Chrome installed on your machine; run it when you change the renderer or the page. `npm run test:mod` needs the `claude` CLI, and runs when you change the mod.

CI runs the typecheck, the tests and the build on Linux and macOS.

## Changes

- Keep a change to one thing, and add or update the tests that show it.
- Follow the code around yours: its naming, its comments and its level of detail. Comments say why, in English, as the rest of the code does.
- The server builds the scene (`src/scene`) and the browser draws it (`ui/renderer`); the data that crosses between them is typed in `src/scene/types.ts`. A change to what the server sends changes `SCENE_VERSION`.
- Snapshots are updated on purpose: read the diff before you accept it.
- The page loads nothing from the network, and the daemon listens on 127.0.0.1 only. A change that needs otherwise is a design question: open an issue.
- Write commit messages as a sentence that says what the change does.

## Pull requests

Describe what changes for a user and how you checked it. A screenshot or a short recording helps for anything that moves. A maintainer reviews it, and may ask for changes before it is merged.

## Conduct

Everyone who takes part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

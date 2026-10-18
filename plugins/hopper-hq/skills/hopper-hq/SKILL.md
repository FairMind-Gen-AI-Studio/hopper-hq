---
name: hopper-hq
description: Use when the user asks to open the Hopper HQ building or view their coding-agent sessions in Hopper.
---

Open Hopper HQ with the packaged helper. Resolve `../../scripts/hopper.mjs` relative to this skill's installed directory and pass its absolute path to Node:

```sh
node "/absolute/plugin/path/scripts/hopper.mjs" open
```

The helper checks the Hopper CLI, reuses an existing daemon or starts one, and opens the signed-in building. Run it in the user's execution environment, preserving `HOPPER_HQ_HOME` and any `HOPPER_HQ_BIN` override. `PLUGIN_ROOT` is guaranteed for hook commands, not for ordinary skill shell commands; do not depend on it here.

If the helper reports a missing or outdated CLI, follow the packaged setup skill at `../setup/SKILL.md`. Do not silently install software or replace a running daemon. Report a browser-open failure accurately and use the printed URL only when the user needs a manual link. A sign-in link is single-use; do not copy it into project files.

This skill opens the building. The plugin's trusted hooks supply monitoring events automatically; do not copy them into the user's `hooks.json` or start a second watcher.

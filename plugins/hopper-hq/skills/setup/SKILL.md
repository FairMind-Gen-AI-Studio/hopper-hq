---
name: setup
description: Use when setting up the Hopper HQ Codex plugin or repairing a missing Hopper CLI prerequisite.
---

Resolve `../../scripts/hopper.mjs` relative to this skill's installed directory, then run its absolute path:

```sh
node "/absolute/plugin/path/scripts/hopper.mjs" check
```

Hopper requires Node.js 22.13 or later and a Hopper CLI whose help includes `codex-hook`. The plugin supplies hooks and the opening skill; the CLI supplies the daemon and browser UI.

If the CLI is missing or outdated, explain the prerequisite. For a released Codex-capable package, the installation command is `npm install -g @fairmind-ai/hopper-hq`. For development from the Hopper repository, build that checkout with `npm ci && npm run build && npm link`. Confirm that the selected package or checkout includes `codex-hook`; the plugin itself does not publish a new CLI release. Set `HOPPER_HQ_BIN` to an executable path when `hopper-hq` is not on PATH. Install or update only when the user authorizes software installation; do not run npm from the plugin cache or bypass npm permission errors with sudo.

Codex must discover the plugin in a new CLI session after installation. Ask the user to inspect and trust the Hopper hook definitions with `/hooks`. Installing the plugin does not grant hook trust. If the hook feature is disabled, explain the setting and let the user enable it; do not edit Codex configuration or bypass trust automatically.

Once the prerequisite check succeeds, open the building through `node "/absolute/plugin/path/scripts/hopper.mjs" open`. Use the same `HOPPER_HQ_HOME` as the daemon when customized. After a CLI upgrade, an existing daemon may need a restart; explain this before stopping it.

Do not duplicate the bundled hooks in user configuration. Existing manual Hopper hooks should be removed only with the user's authorization, to avoid reporting each event twice. The plugin observes local Codex sessions; it makes no approval decisions and does not promise cloud-orchestrated hook support.

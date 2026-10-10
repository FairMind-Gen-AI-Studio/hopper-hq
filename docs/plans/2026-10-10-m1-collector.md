# M1 Collector Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (or superpowers:executing-plans in a separate session) to implement this plan task-by-task.
>
> **Model routing:** implementers run on **Sonnet** (`model: "sonnet"`). Spec and code reviewers, and the final verification, run on **Opus** (`model: "opus"`). Always pass `model` explicitly when dispatching.

**Goal:** A local daemon that watches every Claude Code session on this machine, works out what each one is doing and whether it needs the user, and exposes that through an HTTP API, a `scranton-hq ls` listing, a tmux status counter, and a band above the prompt of every Claude Code session.

**Architecture:** Two sources feed one collector. The filesystem adapter reads what Claude Code already writes under `~/.claude` and works with nothing installed. The scranton-hq mod, a Claude Code plugin, reports each session's events as they happen and draws the band above the prompt. A pure reducer folds normalized events into per-session state, and pure view functions derive time-based states, feature floors and the attention queue at read time. A single Node process (the daemon) hosts the collector, a SQLite store and a localhost-only HTTP API. A thin CLI and the mod talk to it over HTTP.

**Tech stack:** Node ≥ 22.13 (ESM, built-in `node:sqlite`, `node:http`, `node:util` `parseArgs`), TypeScript 5.8 (`module: NodeNext`), Vitest 3.2. **No runtime dependencies.** The mod uses Claude Code's function-hooks plugin API (early access; this plan's mod code was verified against Claude Code 2.1.296) and is checked with `claude plugin validate` and `claude plugin test`.

**Design reference:** `docs/plans/2026-10-09-scranton-hq-design.md` (§3 principles, §4 architecture and mod transport, §5 domain, §6 feature grouping, §7 states, §8 attention and the band, §12 security). M1 ships no browser UI; the Svelte app and the 3D renderer are M2.

---

## Ground rules (read before every task)

1. **Never touch the real `~/.claude` or `~/.scranton-hq`.** Every path is injectable (`claudeDir`, `dataDir`). Tests use `mkdtemp` directories and synthetic fixtures only. No test reads the real home directory.
2. **Never install anything into the user's Claude Code during implementation.** No `/plugin install`, no `claude plugin marketplace add`, no `claude --plugin-dir` sessions, no writes under `~/.claude` (settings, plugins, `dev-mods`). The mod lives in `mod/` in this repository and is checked only with `claude plugin validate`, `claude plugin test` and `tsc`. Installing it is a manual step the user takes at the end (Task 21, last section).
3. **The mod must never get in the way of a session.** Every hook ends by returning `next(e)`'s result. Every hook at a gating site (`prompt.submit`, `tool.call`, `tool.check`, `agent.spawn`) carries `.catch(($, e, next) => next(e))`. Hooks only append to a queue; network calls happen in timers and at session end.
4. **Tolerate undocumented formats.** `~/.claude/sessions/*.json`, transcripts and `subagents/*.meta.json` are internal Claude Code formats. Parse defensively: unknown fields are ignored, missing fields degrade, a bad line is skipped. Never throw out of a parser.
5. **Imports:** in `src/` and `test/`, all relative imports use the `.js` extension (NodeNext), e.g. `import { x } from './types.js'` even though the file is `types.ts`. Vitest resolves these to the `.ts` sources. The mod in `mod/` follows its own rules (Task 19).
6. **TDD:** write the test, run it and watch it fail, implement, run it and watch it pass, commit. Commit after every task with the message given. End every commit message with the line `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
7. **Types are the contract.** Task 3 defines every shared type. Later tasks import them by name and never redefine them. If a task seems to need a type change, stop and report it to the coordinator instead of improvising.
8. Commands run from the repository root: `/Users/alexiocassani/Projects/watchtower`.

## File map

```
package.json, tsconfig.json, tsconfig.build.json, vitest.config.ts, .github/workflows/ci.yml
.claude-plugin/marketplace.json  makes this repository installable with /plugin install
src/
  bin.ts                         CLI entry (shebang) -> cli.ts main()
  cli.ts                         argument parsing, command dispatch (lazy imports)
  cli-format.ts                  pure formatting for status / ls
  client.ts                      tiny HTTP client for the CLI (reads daemon.json)
  config.ts                      paths, thresholds, port
  daemon-file.ts                 daemon.json read/write (port, token)
  daemon.ts                      wires store + collector + adapters + server
  collector.ts                   event queue -> reducer -> store, snapshots
  core/types.ts                  shared types (Task 3)
  core/tool-label.ts             tool call -> short label; tool -> wait reason
  core/feature.ts                branch -> feature key
  core/reducer.ts                applyEvent, markSeen
  core/view.ts                   effectiveState, buildFloors, buildAttention
  adapters/git.ts                cwd -> Workspace (repo, worktree, branch)
  adapters/demo.ts               scripted synthetic events
  adapters/claude-code/jsonl.ts        incremental JSONL reading
  adapters/claude-code/transcript.ts   transcript line -> events
  adapters/claude-code/sessions-dir.ts sessions/*.json + process liveness
  adapters/claude-code/fs-adapter.ts   polling adapter over ~/.claude
  adapters/claude-code/hooks.ts        hook-shaped payload (as the mod sends it) -> events
  server/http.ts                 localhost API
  store/store.ts                 node:sqlite persistence
mod/                             the scranton-hq mod (a Claude Code plugin); its own runtime: no Node, no DOM
  .claude-plugin/plugin.json
  hooks/hooks.json
  hooks/register.tsx             forwards session events to the daemon; draws the band above the prompt
  types/index.d.ts               the mod's $.state contract
  tests/*.test.ts(x)             run by `claude plugin test mod`, not by vitest
test/                            mirrors src/, plus test/fixtures/
```

## Task index

- **Part A, core (pure):** 1 Scaffold · 2 Payload fixtures · 3 Shared types and config · 4 Tool labels · 5 Feature rule · 6 Reducer · 7 Views
- **Part B, adapters:** 8 JSONL reader · 9 Transcript parser · 10 Sessions dir and liveness · 11 Git workspace · 12 Filesystem adapter · 13 Payload mapper
- **Part C, daemon, CLI and mod:** 14 Store · 15 Collector · 16 HTTP API · 17 Daemon · 18 CLI status, ls, ack · 19 Claude Code mod · 20 Demo adapter · 21 README, end-to-end test, handover

---

# Part A: core

### Task 1: Scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts`, `.github/workflows/ci.yml`, `test/scaffold.test.ts`
- Modify: `.gitignore` (already ignores `node_modules/`, `dist/`, `*.db`)

**Step 1: Create `package.json`**

```json
{
  "name": "scranton-hq",
  "version": "0.1.0",
  "description": "A local office building where you watch your coding-agent sessions work.",
  "license": "Apache-2.0",
  "type": "module",
  "bin": { "scranton-hq": "dist/bin.js" },
  "files": ["dist", "README.md", "LICENSE"],
  "engines": { "node": ">=22.13" },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "typescript": "~5.8.3",
    "vitest": "~3.2.4"
  }
}
```

**Step 2: Create `tsconfig.json` (type-checks sources and tests, emits nothing)**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src", "test"]
}
```

**Step 3: Create `tsconfig.build.json` (emits `dist/` from `src/` only)**

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist", "sourceMap": true },
  "include": ["src"]
}
```

**Step 4: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['test/**/*.test.ts'], environment: 'node', testTimeout: 15000 },
});
```

**Step 5: Create `.github/workflows/ci.yml`**

```yaml
name: ci
on: [push, pull_request]
jobs:
  test:
    runs-on: ${{ matrix.os }}
    strategy:
      matrix:
        os: [ubuntu-latest, macos-latest]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
      - run: npm run build
```

**Step 6: Write the scaffold test `test/scaffold.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

describe('scaffold', () => {
  it('declares the package as scranton-hq with no runtime dependencies', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(pkg.name).toBe('scranton-hq');
    expect(pkg.dependencies).toBeUndefined();
    expect(pkg.type).toBe('module');
  });
});
```

**Step 7: Install and run**

Run: `npm install && npm run typecheck && npm test`
Expected: `package-lock.json` is created; typecheck passes; `1 passed`.

**Step 8: Commit**

```bash
git add package.json package-lock.json tsconfig.json tsconfig.build.json vitest.config.ts .github/workflows/ci.yml test/scaffold.test.ts
git commit -m "Scaffold the TypeScript package, tests and CI"
```

---

### Task 2: Payload fixtures

The mod (Task 19) sends each session's events to the daemon as small JSON objects that use the field names of Claude Code's settings hooks (`hook_event_name`, `session_id`, `cwd`, `tool_name`, `tool_input`, `tool_use_id`, `agent_id`, ...), plus `_scranton_ts`, the time the mod saw the event. These fixtures pin that format; the mapper (Task 13) and the API (Task 16) are tested against them.

The field sets come from a live check of the mod on Claude Code 2.1.296: one `claude -p` session that ran `ls` sent `UserPromptSubmit{_scranton_ts,cwd,hook_event_name,prompt,session_id}`, `PreToolUse{…,tool_input,tool_name,tool_use_id}`, `PostToolUse{…,tool_name,tool_use_id}`, `Stop{…,background_tasks}` and `SessionEnd{…,reason}`. **No `claude` command runs in this task.**

**Files:**
- Create: `test/fixtures/hooks/*.json` (11 files), `test/fixtures/hooks/README.md`

**Step 1: Create the fixtures**

Every file below uses `"session_id": "11111111-1111-4111-8111-111111111111"` and `"cwd": "/home/dev/shop/orders-api"`. Write them exactly.

`UserPromptSubmit.json`
```json
{ "_scranton_ts": 1791660000000, "session_id": "11111111-1111-4111-8111-111111111111", "cwd": "/home/dev/shop/orders-api", "hook_event_name": "UserPromptSubmit", "prompt": "Run ls with the Bash tool, then reply with the single word ok." }
```

`PreToolUse.json`
```json
{ "_scranton_ts": 1791660001000, "session_id": "11111111-1111-4111-8111-111111111111", "cwd": "/home/dev/shop/orders-api", "hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": { "command": "ls", "description": "List files in current directory" }, "tool_use_id": "toolu_01ABCDEFGHIJKLMNOPQRSTUV" }
```

`PostToolUse.json`
```json
{ "_scranton_ts": 1791660002000, "session_id": "11111111-1111-4111-8111-111111111111", "cwd": "/home/dev/shop/orders-api", "hook_event_name": "PostToolUse", "tool_name": "Bash", "tool_use_id": "toolu_01ABCDEFGHIJKLMNOPQRSTUV" }
```

`PostToolUseFailure.json`
```json
{ "_scranton_ts": 1791660002500, "session_id": "11111111-1111-4111-8111-111111111111", "cwd": "/home/dev/shop/orders-api", "hook_event_name": "PostToolUseFailure", "tool_name": "Bash", "tool_use_id": "toolu_02ABCDEFGHIJKLMNOPQRSTUV" }
```

`PreToolUse.subagent.json`
```json
{ "_scranton_ts": 1791660002700, "session_id": "11111111-1111-4111-8111-111111111111", "cwd": "/home/dev/shop/orders-api", "hook_event_name": "PreToolUse", "tool_name": "Grep", "tool_input": { "pattern": "useCart" }, "tool_use_id": "toolu_03ABCDEFGHIJKLMNOPQRSTUV", "agent_id": "a58cb74ebedcc3070" }
```

`PreToolUse.AskUserQuestion.json`
```json
{ "_scranton_ts": 1791660002800, "session_id": "11111111-1111-4111-8111-111111111111", "cwd": "/home/dev/shop/orders-api", "hook_event_name": "PreToolUse", "tool_name": "AskUserQuestion", "tool_input": { "questions": [ { "question": "Should the retry queue use Redis or Postgres?", "header": "Queue", "options": [], "multiSelect": false } ] }, "tool_use_id": "toolu_04ABCDEFGHIJKLMNOPQRSTUV" }
```

`PermissionRequest.json`
```json
{ "_scranton_ts": 1791660003000, "session_id": "11111111-1111-4111-8111-111111111111", "cwd": "/home/dev/shop/orders-api", "hook_event_name": "PermissionRequest", "tool_name": "Bash", "tool_input": { "command": "rm -rf dist && npm run build", "description": "Rebuild" } }
```

`SubagentStart.json`
```json
{ "_scranton_ts": 1791660004000, "session_id": "11111111-1111-4111-8111-111111111111", "cwd": "/home/dev/shop/orders-api", "hook_event_name": "SubagentStart", "agent_id": "a58cb74ebedcc3070", "agent_type": "Explore" }
```

`Stop.json`
```json
{ "_scranton_ts": 1791660005000, "session_id": "11111111-1111-4111-8111-111111111111", "cwd": "/home/dev/shop/orders-api", "hook_event_name": "Stop", "background_tasks": 0 }
```

`SessionEnd.json`
```json
{ "_scranton_ts": 1791660006000, "session_id": "11111111-1111-4111-8111-111111111111", "cwd": "/home/dev/shop/orders-api", "hook_event_name": "SessionEnd", "reason": "other" }
```

`batch.json`: one flush as the mod posts it, a JSON array holding, in this order, the exact objects of `UserPromptSubmit.json`, `PreToolUse.json`, `PostToolUse.json` and `Stop.json`.

**Step 2: Write `test/fixtures/hooks/README.md`**

Say, in a few lines: these files are the payloads the scranton-hq mod (`mod/hooks/register.tsx`) posts to `POST /api/hooks`; they use the settings hooks' field names so one mapper reads them; the field sets were checked against Claude Code 2.1.296; and a change to what the mod sends must change these fixtures, the mapper tests and the mod's own tests together.

**Step 3: Check the JSON and commit**

Run: `for f in test/fixtures/hooks/*.json; do node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$f" || echo "BAD $f"; done`
Expected: no `BAD` lines.

```bash
git add test/fixtures/hooks
git commit -m "Add the payload fixtures the mod and the daemon share"
```

---

### Task 3: Shared types and config

**Files:**
- Create: `src/core/types.ts`, `src/config.ts`, `test/config.test.ts`

**Step 1: Create `src/core/types.ts` exactly as follows**

```ts
/** Lifecycle states of a session. Time-based ones (idle, dormant, no_signal) are also derived at read time, see core/view.ts. */
export type SessionState =
  | 'working'
  | 'needs_you'
  | 'done'
  | 'in_meeting'
  | 'no_signal'
  | 'idle'
  | 'dormant'
  | 'ended';

export type WaitKind = 'permission' | 'question' | 'plan' | 'input';

export interface WaitReason {
  kind: WaitKind;
  /** Short text, e.g. "Bash" or "Which database?" */
  text: string;
  /** Optional detail, e.g. the command awaiting permission. */
  detail?: string;
}

export interface Workspace {
  cwd: string;
  /** Root of the main repository (not of a linked worktree). Null outside git. */
  repoRoot: string | null;
  /** Basename of repoRoot, or of cwd outside git. */
  repoName: string;
  /** True when cwd belongs to a linked worktree. */
  worktree: boolean;
  /** Current branch; 'HEAD' when detached; null when unknown. */
  branch: string | null;
}

export interface ChildAgent {
  id: string;
  type: string;
  description: string | null;
  running: boolean;
  lastAction: string | null;
  updatedAt: number;
}

export interface OpenTool {
  id: string | null;
  label: string;
  startedAt: number;
}

export interface Session {
  id: string;
  agentKind: 'claude-code';
  location: 'local' | 'cloud';
  pid: number | null;
  name: string | null;
  tmuxPane: string | null;
  transcriptPath: string | null;
  workspace: Workspace;
  state: SessionState;
  stateSince: number;
  waitReason: WaitReason | null;
  title: string | null;
  firstPrompt: string | null;
  lastPrompt: string | null;
  lastAction: string | null;
  lastActionAt: number | null;
  openTool: OpenTool | null;
  backgroundTasks: number;
  children: ChildAgent[];
  startedAt: number;
  /** ts of the last applied ordered event. */
  lastEventAt: number;
  /** seq of the last applied ordered event (tie-break for equal ts). */
  lastSeq: number;
  /** When the user marked the current 'done' as seen. */
  seenAt: number | null;
}

export type EventSourceKind = 'hook' | 'fs' | 'demo';

interface EventBase {
  sessionId: string;
  /** Wall-clock ms when the event happened (hook stamp, transcript timestamp, file time). */
  ts: number;
  /** Arrival order, assigned by the collector. */
  seq: number;
  source: EventSourceKind;
  /** Working directory, when known. Lets the collector create a session it has not seen yet. */
  cwd?: string;
}

export type CollectorEvent = EventBase &
  (
    | {
        type: 'session.seen';
        workspace: Workspace;
        pid?: number | null;
        name?: string | null;
        tmuxPane?: string | null;
        transcriptPath?: string | null;
        startedAt?: number;
      }
    | { type: 'session.started' }
    | { type: 'session.status'; status: 'busy' | 'idle' | 'waiting'; waitingFor: string | null }
    | { type: 'branch'; branch: string | null }
    | { type: 'title'; title: string }
    | { type: 'prompt'; text: string | null }
    | { type: 'tool.started'; toolId: string | null; tool: string; label: string; agentId: string | null }
    | { type: 'tool.finished'; toolId: string | null; ok: boolean; agentId: string | null }
    | { type: 'waiting'; reason: WaitReason }
    | { type: 'turn.finished'; backgroundTasks: number }
    | { type: 'agent.started'; agentId: string; agentType: string; description: string | null }
    | { type: 'agent.finished'; agentId: string }
    | { type: 'session.ended'; reason: string }
  );

export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** An event before the collector assigns `seq`. Adapters produce these. */
export type RawEvent = DistributiveOmit<CollectorEvent, 'seq'>;

export type EventOf<T extends CollectorEvent['type']> = Extract<CollectorEvent, { type: T }>;
```

**Step 2: Write the failing test `test/config.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PORT, DEFAULT_THRESHOLDS, resolvePaths } from '../src/config.js';

describe('resolvePaths', () => {
  it('prefers explicit options, then environment, then home defaults', () => {
    expect(resolvePaths({ claudeDir: '/a', dataDir: '/b' }, { CLAUDE_CONFIG_DIR: '/x', SCRANTON_HQ_HOME: '/y' })).toEqual({ claudeDir: '/a', dataDir: '/b' });
    expect(resolvePaths({}, { CLAUDE_CONFIG_DIR: '/x', SCRANTON_HQ_HOME: '/y' })).toEqual({ claudeDir: '/x', dataDir: '/y' });
    expect(resolvePaths({}, {})).toEqual({ claudeDir: join(homedir(), '.claude'), dataDir: join(homedir(), '.scranton-hq') });
  });
});

describe('defaults', () => {
  it('uses the thresholds from the design', () => {
    expect(DEFAULT_THRESHOLDS).toEqual({
      doneToIdleMs: 4 * 60 * 60 * 1000,
      idleToDormantMs: 3 * 24 * 60 * 60 * 1000,
      noSignalMs: 10 * 60 * 1000,
      childFreshMs: 90 * 1000,
    });
    expect(DEFAULT_PORT).toBe(7337);
  });
});
```

**Step 3: Run it to see it fail**

Run: `npx vitest run test/config.test.ts`
Expected: FAIL, cannot find module `../src/config.js`.

**Step 4: Create `src/config.ts`**

```ts
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Paths {
  /** Claude Code's config directory (sessions/, projects/, settings.json). */
  claudeDir: string;
  /** scranton-hq's own data directory (token, daemon.json, database). */
  dataDir: string;
}

export function resolvePaths(
  opts: { claudeDir?: string; dataDir?: string } = {},
  env: NodeJS.ProcessEnv = process.env,
): Paths {
  return {
    claudeDir: opts.claudeDir ?? env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'),
    dataDir: opts.dataDir ?? env.SCRANTON_HQ_HOME ?? join(homedir(), '.scranton-hq'),
  };
}

export interface Thresholds {
  /** An unseen 'done' becomes 'idle' after this long. */
  doneToIdleMs: number;
  /** 'idle' becomes 'dormant' after this long. */
  idleToDormantMs: number;
  /** 'working' with no activity becomes 'no_signal' after this long. */
  noSignalMs: number;
  /** A subagent transcript written within this window counts as running (filesystem fallback). */
  childFreshMs: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  doneToIdleMs: 4 * 60 * 60 * 1000,
  idleToDormantMs: 3 * 24 * 60 * 60 * 1000,
  noSignalMs: 10 * 60 * 1000,
  childFreshMs: 90 * 1000,
};

export const DEFAULT_PORT = 7337;
```

**Step 5: Run the test and typecheck**

Run: `npx vitest run test/config.test.ts && npm run typecheck`
Expected: PASS.

**Step 6: Commit**

```bash
git add src/core/types.ts src/config.ts test/config.test.ts
git commit -m "Define shared domain types, paths and thresholds"
```

---

### Task 4: Tool labels and wait reasons

Turns a tool call into the short "last action" label (`Bash: npm test`, `Edit src/a.ts`) and recognises the tools that mean the session is waiting for the user.

**Files:**
- Create: `src/core/tool-label.ts`, `test/core/tool-label.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { toolLabel, truncate, waitingFromTool } from '../../src/core/tool-label.js';

describe('truncate', () => {
  it('collapses whitespace and cuts with an ellipsis', () => {
    expect(truncate('  a\n  b  ')).toBe('a b');
    const long = 'x'.repeat(100);
    expect(truncate(long)).toHaveLength(80);
    expect(truncate(long).endsWith('…')).toBe(true);
    expect(truncate('abcdef', 4)).toBe('abc…');
  });
});

describe('toolLabel', () => {
  it('shows the first line of a Bash command', () => {
    expect(toolLabel('Bash', { command: 'npm test\necho hi' })).toBe('Bash: npm test');
  });
  it('shows file paths relative to cwd, or the last two segments outside it', () => {
    expect(toolLabel('Edit', { file_path: '/repo/src/a.ts' }, '/repo')).toBe('Edit src/a.ts');
    expect(toolLabel('Read', { file_path: '/etc/nginx/nginx.conf' }, '/repo')).toBe('Read nginx/nginx.conf');
    expect(toolLabel('Write', { file_path: '/repo/README.md' }, '/repo/')).toBe('Write README.md');
  });
  it('labels search, web, agent and skill tools', () => {
    expect(toolLabel('Grep', { pattern: 'useCart' })).toBe('Grep useCart');
    expect(toolLabel('WebFetch', { url: 'https://example.com/a?b=1' })).toBe('WebFetch example.com');
    expect(toolLabel('WebFetch', { url: 'not a url' })).toBe('WebFetch');
    expect(toolLabel('WebSearch', { query: 'node sqlite' })).toBe('WebSearch node sqlite');
    expect(toolLabel('Agent', { description: 'Find callers', subagent_type: 'Explore' })).toBe('Agent: Find callers');
    expect(toolLabel('Task', { subagent_type: 'Explore' })).toBe('Agent: Explore');
    expect(toolLabel('Skill', { skill: 'browse' })).toBe('Skill browse');
  });
  it('splits MCP tool names into server and tool', () => {
    expect(toolLabel('mcp__claude_ai_Slack__slack_send_message', {})).toBe('claude_ai_Slack: slack_send_message');
  });
  it('falls back to the tool name and survives odd input', () => {
    expect(toolLabel('Workflow', {})).toBe('Workflow');
    expect(toolLabel('SomethingNew', 'oops')).toBe('SomethingNew');
    expect(toolLabel('Bash', null)).toBe('Bash:');
  });
});

describe('waitingFromTool', () => {
  it('maps AskUserQuestion to a question with the first question text', () => {
    expect(waitingFromTool('AskUserQuestion', { questions: [{ question: 'Redis or Postgres?' }] }))
      .toEqual({ kind: 'question', text: 'Redis or Postgres?' });
    expect(waitingFromTool('AskUserQuestion', {})).toEqual({ kind: 'question', text: 'Question' });
  });
  it('maps ExitPlanMode to a plan approval', () => {
    expect(waitingFromTool('ExitPlanMode', { plan: '...' })).toEqual({ kind: 'plan', text: 'Plan approval' });
  });
  it('returns null for ordinary tools', () => {
    expect(waitingFromTool('Bash', { command: 'ls' })).toBeNull();
  });
});
```

**Step 2: Run it to see it fail**

Run: `npx vitest run test/core/tool-label.test.ts`
Expected: FAIL, module not found.

**Step 3: Implement `src/core/tool-label.ts`**

```ts
import type { WaitReason } from './types.js';

const MAX_LABEL = 80;

export function truncate(text: string, max = MAX_LABEL): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : oneLine.slice(0, max - 1) + '…';
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function shortPath(p: unknown, cwd?: string): string {
  const path = str(p);
  if (!path) return '';
  if (cwd) {
    const base = cwd.endsWith('/') ? cwd : cwd + '/';
    if (path.startsWith(base)) return path.slice(base.length);
  }
  return path.split('/').filter(Boolean).slice(-2).join('/');
}

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
}

export function toolLabel(tool: string, input: unknown, cwd?: string): string {
  const i = asRecord(input);
  if (tool.startsWith('mcp__')) {
    const [, server = '', ...rest] = tool.split('__');
    return truncate(`${server}: ${rest.join('__') || 'tool'}`);
  }
  switch (tool) {
    case 'Bash':
      return truncate(`Bash: ${str(i.command).split('\n')[0] ?? ''}`);
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
      return truncate(`${tool} ${shortPath(i.file_path, cwd)}`);
    case 'NotebookEdit':
      return truncate(`${tool} ${shortPath(i.notebook_path, cwd)}`);
    case 'Grep':
    case 'Glob':
      return truncate(`${tool} ${str(i.pattern)}`);
    case 'WebFetch': {
      let host = '';
      try {
        host = new URL(str(i.url)).host;
      } catch {
        host = '';
      }
      return truncate(`WebFetch ${host}`);
    }
    case 'WebSearch':
      return truncate(`WebSearch ${str(i.query)}`);
    case 'Agent':
    case 'Task':
      return truncate(`Agent: ${str(i.description) || str(i.subagent_type) || 'subagent'}`);
    case 'Skill':
      return truncate(`Skill ${str(i.skill)}`);
    default:
      return truncate(tool);
  }
}

/** Tools whose call means the session now waits for the user. */
export function waitingFromTool(tool: string, input: unknown): WaitReason | null {
  if (tool === 'AskUserQuestion') {
    const questions = asRecord(input).questions;
    const first = Array.isArray(questions) ? asRecord(questions[0]).question : undefined;
    return { kind: 'question', text: truncate(str(first) || 'Question', 120) };
  }
  if (tool === 'ExitPlanMode') return { kind: 'plan', text: 'Plan approval' };
  return null;
}
```

Note: `truncate` trims, which is why `toolLabel('Bash', null)` yields `'Bash:'`.

**Step 4: Run the tests**

Run: `npx vitest run test/core/tool-label.test.ts && npm run typecheck`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/core/tool-label.ts test/core/tool-label.test.ts
git commit -m "Label tool calls and detect tools that wait for the user"
```

---

### Task 5: Feature rule

Implements design §6 rules 2–4 (rule 1, manual tags, arrives with the M2 UI).

**Files:**
- Create: `src/core/feature.ts`, `test/core/feature.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { DEFAULT_FEATURE_RULES, deriveFeature } from '../../src/core/feature.js';

describe('deriveFeature', () => {
  it('returns null for missing, trunk, detached and generated branches', () => {
    for (const b of [null, undefined, '', '  ', 'main', 'master', 'Master', 'dev', 'develop', 'HEAD']) {
      expect(deriveFeature(b, 'shop')).toBeNull();
    }
    expect(deriveFeature('claude/distracted-merkle-82a816', 'shop')).toBeNull();
    expect(deriveFeature('worktree-agent-a1b2', 'shop')).toBeNull();
  });

  it('uses the last path segment, lower-cased', () => {
    expect(deriveFeature('feat/checkout-v2', 'storefront-web')).toBe('checkout-v2');
    expect(deriveFeature('feature/Prod-VPN-Access', 'infra')).toBe('prod-vpn-access');
    expect(deriveFeature('user/feat/search-ranking', 'search-svc')).toBe('search-ranking');
    expect(deriveFeature('live-demo', 'site')).toBe('live-demo');
  });

  it('strips a trailing repo-name token when the slug has three or more parts', () => {
    expect(deriveFeature('judge/r24-rubric-plugins', 'fairmind-plugins')).toBe('r24-rubric');
    expect(deriveFeature('judge/r24-rubric-telemetry', 'fm-telemetry')).toBe('r24-rubric');
    expect(deriveFeature('judge/r24-rubric-brain', 'brain')).toBe('r24-rubric');
    // two parts: never stripped, so 'search-api' stays the same key in every repo
    expect(deriveFeature('feat/search-api', 'orders-api')).toBe('search-api');
    // last part is not a repo token
    expect(deriveFeature('brain-write-quota', 'fairmind-brain')).toBe('brain-write-quota');
  });

  it('prefers a ticket id anywhere in the branch, upper-cased', () => {
    expect(deriveFeature('feature/ABC-123-login', 'web')).toBe('ABC-123');
    expect(deriveFeature('fix/cu-86cazw5uc-typo', 'web')).toBe('CU-86CAZW5UC');
    expect(deriveFeature('CU-86cazw5uc', 'api')).toBe('CU-86CAZW5UC');
  });

  it('does not treat dates or lower-case words as tickets', () => {
    expect(deriveFeature('docs/release-note-2026-09-26', 'site')).toBe('release-note-2026-09-26');
  });

  it('accepts custom rules', () => {
    const rules = { ...DEFAULT_FEATURE_RULES, trunkBranches: ['trunk'], ticketPatterns: [/\b(T\d+)\b/] };
    expect(deriveFeature('main', 'x', rules)).toBe('main');
    expect(deriveFeature('trunk', 'x', rules)).toBeNull();
    expect(deriveFeature('feat/T42-thing', 'x', rules)).toBe('T42');
  });
});
```

**Step 2: Run it to see it fail**

Run: `npx vitest run test/core/feature.test.ts`
Expected: FAIL, module not found.

**Step 3: Implement `src/core/feature.ts`**

```ts
export interface FeatureRules {
  /** Compared case-insensitively. Sessions on these branches have no feature. */
  trunkBranches: string[];
  /** Branches created by tools rather than people. */
  generatedBranches: RegExp[];
  /** First capture group is the ticket id. */
  ticketPatterns: RegExp[];
}

export const DEFAULT_FEATURE_RULES: FeatureRules = {
  trunkBranches: ['main', 'master', 'dev', 'develop', 'trunk', 'head'],
  generatedBranches: [/^claude\//i, /^worktree-agent-/i],
  ticketPatterns: [/\b([A-Z][A-Z0-9]{1,9}-\d+)\b/, /\b(CU-[a-z0-9]{4,})\b/i],
};

/** Feature key for a branch, or null when the session has no feature (trunk, detached, generated). */
export function deriveFeature(
  branch: string | null | undefined,
  repoName: string,
  rules: FeatureRules = DEFAULT_FEATURE_RULES,
): string | null {
  const b = (branch ?? '').trim();
  if (!b) return null;
  if (rules.trunkBranches.map((t) => t.toLowerCase()).includes(b.toLowerCase())) return null;
  if (rules.generatedBranches.some((re) => re.test(b))) return null;

  for (const re of rules.ticketPatterns) {
    const m = b.match(re);
    if (m?.[1]) return m[1].toUpperCase();
  }

  const last = b.split('/').filter(Boolean).pop() ?? b;
  const parts = last.toLowerCase().split('-');
  const repo = repoName.toLowerCase();
  const repoTokens = new Set([repo, ...repo.split(/[-_.]+/).filter((t) => t.length >= 3)]);
  const tail = parts[parts.length - 1];
  if (parts.length >= 3 && tail !== undefined && repoTokens.has(tail)) parts.pop();
  const slug = parts.join('-');
  return slug || null;
}
```

**Step 4: Run the tests**

Run: `npx vitest run test/core/feature.test.ts && npm run typecheck`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/core/feature.ts test/core/feature.test.ts
git commit -m "Derive a feature key from branch names"
```

---

### Task 6: Reducer

The heart of M1: `applyEvent(prev, event)` folds one event into a session. **Ordering rule:** an event changes state only if it is newer than the last applied ordered event, comparing `ts` first and `seq` second. Stale events can still fill in facts that do not depend on order (title, children, first prompt).

**Files:**
- Create: `src/core/reducer.ts`, `test/core/reducer.test.ts`, `test/helpers/events.ts`

**Step 1: Create the test helper `test/helpers/events.ts`**

```ts
import type { CollectorEvent, Workspace } from '../../src/core/types.js';

export const WS: Workspace = {
  cwd: '/home/dev/shop/orders-api',
  repoRoot: '/home/dev/shop/orders-api',
  repoName: 'orders-api',
  worktree: false,
  branch: 'feat/checkout-v2',
};

let seq = 0;
/** Builds an event with defaults; seq auto-increments unless given. */
export function ev<T extends CollectorEvent['type']>(
  type: T,
  ts: number,
  fields: Partial<Extract<CollectorEvent, { type: T }>> = {},
): Extract<CollectorEvent, { type: T }> {
  return { type, ts, seq: seq++, sessionId: 'S1', source: 'hook', ...fields } as Extract<CollectorEvent, { type: T }>;
}

export const seen = (ts = 1000) => ev('session.seen', ts, { workspace: WS, pid: 42, name: 'orders-api-a1', tmuxPane: '%7', startedAt: ts });
```

**Step 2: Write the failing test `test/core/reducer.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { applyEvent, markSeen } from '../../src/core/reducer.js';
import type { Session } from '../../src/core/types.js';
import { ev, seen, WS } from '../helpers/events.js';

function run(...events: Parameters<typeof applyEvent>[1][]): Session {
  let s: Session | undefined;
  for (const e of events) s = applyEvent(s, e);
  if (!s) throw new Error('no session');
  return s;
}

describe('applyEvent', () => {
  it('creates a session only from session.seen', () => {
    expect(applyEvent(undefined, ev('prompt', 1, { text: 'hi' }))).toBeUndefined();
    const s = run(seen(1000));
    expect(s).toMatchObject({ id: 'S1', state: 'idle', stateSince: 1000, pid: 42, name: 'orders-api-a1', tmuxPane: '%7', workspace: WS, startedAt: 1000 });
  });

  it('merges a later session.seen without changing state', () => {
    const s = run(seen(1000), ev('prompt', 1100, { text: 'go' }), ev('session.seen', 1200, { workspace: { ...WS, branch: null }, pid: null, name: 'renamed' }));
    expect(s.state).toBe('working');
    expect(s.name).toBe('renamed');
    expect(s.pid).toBe(42);
    expect(s.workspace.branch).toBe('feat/checkout-v2');
  });

  it('a prompt starts work and records first and last prompt', () => {
    const s = run(seen(), ev('prompt', 1100, { text: 'first' }), ev('prompt', 1200, { text: 'second' }));
    expect(s).toMatchObject({ state: 'working', stateSince: 1100, firstPrompt: 'first', lastPrompt: 'second' });
  });

  it('tracks the open tool and last action', () => {
    let s = run(seen(), ev('tool.started', 1100, { toolId: 't1', tool: 'Bash', label: 'Bash: npm test', agentId: null }));
    expect(s).toMatchObject({ state: 'working', lastAction: 'Bash: npm test', lastActionAt: 1100, openTool: { id: 't1', label: 'Bash: npm test', startedAt: 1100 } });
    s = applyEvent(s, ev('tool.finished', 1200, { toolId: 't1', ok: true, agentId: null }))!;
    expect(s.openTool).toBeNull();
    expect(s.state).toBe('working');
  });

  it('waits for the user, then resumes on the next activity', () => {
    let s = run(seen(), ev('tool.started', 1100, { toolId: 't1', tool: 'Bash', label: 'Bash: rm -rf dist', agentId: null }),
      ev('waiting', 1150, { reason: { kind: 'permission', text: 'Bash', detail: 'Bash: rm -rf dist' } }));
    expect(s).toMatchObject({ state: 'needs_you', stateSince: 1150, waitReason: { kind: 'permission', text: 'Bash', detail: 'Bash: rm -rf dist' } });
    s = applyEvent(s, ev('tool.finished', 1300, { toolId: 't1', ok: true, agentId: null }))!;
    expect(s).toMatchObject({ state: 'working', waitReason: null });
  });

  it('keeps a detailed wait reason when a vaguer one of the same kind follows', () => {
    const s = run(seen(), ev('waiting', 1100, { reason: { kind: 'permission', text: 'Bash', detail: 'Bash: rm -rf dist' } }),
      ev('waiting', 1101, { reason: { kind: 'permission', text: 'Claude needs your permission to use Bash' } }));
    expect(s.waitReason).toEqual({ kind: 'permission', text: 'Bash', detail: 'Bash: rm -rf dist' });
    expect(s.stateSince).toBe(1100);
  });

  it('finishes a turn as done, or in a meeting when background work runs', () => {
    expect(run(seen(), ev('prompt', 1100, { text: 'x' }), ev('turn.finished', 1200, { backgroundTasks: 0 })))
      .toMatchObject({ state: 'done', stateSince: 1200, seenAt: null, openTool: null });
    const m = run(seen(), ev('prompt', 1100, { text: 'x' }), ev('turn.finished', 1200, { backgroundTasks: 2 }));
    expect(m).toMatchObject({ state: 'in_meeting', backgroundTasks: 2 });
  });

  it('leaves the meeting when the last background agent finishes', () => {
    let s = run(seen(), ev('agent.started', 1050, { agentId: 'a1', agentType: 'Explore', description: null }),
      ev('agent.started', 1060, { agentId: 'a2', agentType: 'general-purpose', description: 'Implement' }),
      ev('turn.finished', 1100, { backgroundTasks: 2 }));
    expect(s.state).toBe('in_meeting');
    s = applyEvent(s, ev('agent.finished', 1200, { agentId: 'a1' }))!;
    expect(s.state).toBe('in_meeting');
    s = applyEvent(s, ev('agent.finished', 1300, { agentId: 'a2' }))!;
    expect(s).toMatchObject({ state: 'done', stateSince: 1300, backgroundTasks: 0 });
    expect(s.children.map((c) => [c.id, c.running])).toEqual([['a1', false], ['a2', false]]);
  });

  it('ignores stale ordered events but still learns order-free facts', () => {
    let s = run(seen(), ev('prompt', 1100, { text: 'x' }), ev('turn.finished', 2000, { backgroundTasks: 0 }));
    s = applyEvent(s, ev('tool.started', 1500, { toolId: 't9', tool: 'Bash', label: 'Bash: late', agentId: null }))!;
    expect(s).toMatchObject({ state: 'done', lastAction: null });
    s = applyEvent(s, ev('title', 1, { title: 'Fix the checkout' }))!;
    expect(s.title).toBe('Fix the checkout');
  });

  it('uses seq to order events with the same timestamp', () => {
    const a = ev('tool.started', 1100, { toolId: 't1', tool: 'Bash', label: 'Bash: a', agentId: null, seq: 10 });
    const b = ev('turn.finished', 1100, { backgroundTasks: 0, seq: 11 });
    expect(run(seen(), a, b).state).toBe('done');
    const late = ev('tool.started', 1100, { toolId: 't2', tool: 'Bash', label: 'Bash: b', agentId: null, seq: 5 });
    expect(run(seen(), a, b, late).state).toBe('done');
  });

  it('fills a missing first prompt from a stale prompt', () => {
    const s = run(seen(), ev('prompt', 2000, { text: 'recent' }), ev('prompt', 1100, { text: 'earliest' }));
    expect(s).toMatchObject({ firstPrompt: 'recent', lastPrompt: 'recent' });
    const t = run(seen(), ev('tool.started', 2000, { toolId: 't', tool: 'Read', label: 'Read a', agentId: null }), ev('prompt', 1100, { text: 'earliest' }));
    expect(t.firstPrompt).toBe('earliest');
  });

  it('routes subagent tool events to the child, not the session', () => {
    const s = run(seen(), ev('prompt', 1100, { text: 'x' }), ev('turn.finished', 1200, { backgroundTasks: 1 }),
      ev('tool.started', 1300, { toolId: 'c1', tool: 'Grep', label: 'Grep useCart', agentId: 'a1' }));
    expect(s.state).toBe('in_meeting');
    expect(s.lastAction).toBeNull();
    expect(s.children).toEqual([{ id: 'a1', type: 'agent', description: null, running: true, lastAction: 'Grep useCart', updatedAt: 1300 }]);
  });

  it('applies the filesystem status fallback', () => {
    // busy -> working
    expect(run(seen(), ev('session.status', 1100, { status: 'busy', waitingFor: null, source: 'fs' })).state).toBe('working');
    // waiting without a hook reason
    expect(run(seen(), ev('session.status', 1100, { status: 'waiting', waitingFor: 'input needed', source: 'fs' })).waitReason)
      .toEqual({ kind: 'input', text: 'input needed' });
    // waiting keeps the richer hook reason
    expect(run(seen(), ev('waiting', 1100, { reason: { kind: 'permission', text: 'Bash' } }),
      ev('session.status', 1101, { status: 'waiting', waitingFor: 'input needed', source: 'fs' })).waitReason)
      .toEqual({ kind: 'permission', text: 'Bash' });
    // idle after work -> done
    expect(run(seen(), ev('session.status', 1100, { status: 'busy', waitingFor: null, source: 'fs' }),
      ev('session.status', 1200, { status: 'idle', waitingFor: null, source: 'fs' })).state).toBe('done');
    // idle on a session we never saw working stays idle
    expect(run(seen(), ev('session.status', 1100, { status: 'idle', waitingFor: null, source: 'fs' })).state).toBe('idle');
  });

  it('session.started resets to idle (compactions are filtered out earlier, by the hook mapper)', () => {
    const s = run(seen(), ev('prompt', 1100, { text: 'x' }), ev('session.started', 1200));
    expect(s.state).toBe('idle');
  });

  it('ends and revives', () => {
    let s = run(seen(), ev('session.ended', 1100, { reason: 'prompt_input_exit' }));
    expect(s.state).toBe('ended');
    s = applyEvent(s, ev('prompt', 1200, { text: 'back' }))!;
    expect(s.state).toBe('working');
  });

  it('records branch changes', () => {
    expect(run(seen(), ev('branch', 1100, { branch: 'feat/other' })).workspace.branch).toBe('feat/other');
    expect(run(seen(), ev('branch', 1100, { branch: null })).workspace.branch).toBe('feat/checkout-v2');
  });
});

describe('markSeen', () => {
  it('marks a done session as seen and ignores other states', () => {
    const done = run(seen(), ev('prompt', 1100, { text: 'x' }), ev('turn.finished', 1200, { backgroundTasks: 0 }));
    expect(markSeen(done, 5000).seenAt).toBe(5000);
    const working = run(seen(), ev('prompt', 1100, { text: 'x' }));
    expect(markSeen(working, 5000)).toBe(working);
  });
});
```

**Step 3: Run it to see it fail**

Run: `npx vitest run test/core/reducer.test.ts`
Expected: FAIL, module not found.

**Step 4: Implement `src/core/reducer.ts`**

```ts
import type { ChildAgent, CollectorEvent, EventOf, Session, SessionState, Workspace } from './types.js';

const MAX_CHILDREN = 50;

export function newSession(id: string, ts: number, workspace: Workspace): Session {
  return {
    id,
    agentKind: 'claude-code',
    location: 'local',
    pid: null,
    name: null,
    tmuxPane: null,
    transcriptPath: null,
    workspace,
    state: 'idle',
    stateSince: ts,
    waitReason: null,
    title: null,
    firstPrompt: null,
    lastPrompt: null,
    lastAction: null,
    lastActionAt: null,
    openTool: null,
    backgroundTasks: 0,
    children: [],
    startedAt: ts,
    lastEventAt: 0,
    lastSeq: -1,
    seenAt: null,
  };
}

function isNewer(s: Session, e: CollectorEvent): boolean {
  return e.ts > s.lastEventAt || (e.ts === s.lastEventAt && e.seq > s.lastSeq);
}

function setState(s: Session, state: SessionState, ts: number): Session {
  return s.state === state ? s : { ...s, state, stateSince: ts };
}

function withChild(s: Session, id: string, patch: Partial<ChildAgent> & { updatedAt: number }): Session {
  const i = s.children.findIndex((c) => c.id === id);
  let children: ChildAgent[];
  if (i === -1) {
    const child: ChildAgent = {
      id,
      type: patch.type ?? 'agent',
      description: patch.description ?? null,
      running: patch.running ?? true,
      lastAction: patch.lastAction ?? null,
      updatedAt: patch.updatedAt,
    };
    children = [...s.children, child];
  } else {
    children = s.children.map((c, k) => (k === i ? { ...c, ...patch } : c));
  }
  if (children.length > MAX_CHILDREN) {
    const drop = children.findIndex((c) => !c.running);
    if (drop !== -1) children = children.filter((_, k) => k !== drop);
  }
  return { ...s, children };
}

/** After a child finishes during a meeting: count it off; with nothing left running, the meeting is done. */
function settleMeeting(s: Session, ts: number): Session {
  if (s.state !== 'in_meeting') return s;
  const backgroundTasks = Math.max(0, s.backgroundTasks - 1);
  if (backgroundTasks > 0 || s.children.some((c) => c.running)) return { ...s, backgroundTasks };
  return { ...setState(s, 'done', ts), backgroundTasks: 0, seenAt: null };
}

function applyStatus(s: Session, e: EventOf<'session.status'>): Session {
  switch (e.status) {
    case 'busy':
      if (s.state === 'working' || s.state === 'no_signal') return s;
      return { ...setState(s, 'working', e.ts), waitReason: null, seenAt: null };
    case 'waiting':
      if (s.state === 'needs_you') return s;
      return { ...setState(s, 'needs_you', e.ts), waitReason: { kind: 'input', text: e.waitingFor ?? 'Waiting for you' } };
    case 'idle': {
      if (!['working', 'no_signal', 'needs_you', 'in_meeting'].includes(s.state)) return s;
      const meeting = s.children.some((c) => c.running);
      return { ...setState(s, meeting ? 'in_meeting' : 'done', e.ts), waitReason: null, openTool: null, seenAt: null };
    }
  }
}

export function applyEvent(prev: Session | undefined, e: CollectorEvent): Session | undefined {
  if (!prev) {
    if (e.type !== 'session.seen') return undefined;
    prev = newSession(e.sessionId, e.ts, e.workspace);
  }
  let s = prev;

  // Order-free facts: applied whatever the event's age.
  switch (e.type) {
    case 'session.seen':
      return {
        ...s,
        workspace: { ...e.workspace, branch: e.workspace.branch ?? s.workspace.branch },
        pid: e.pid ?? s.pid,
        name: e.name ?? s.name,
        tmuxPane: e.tmuxPane ?? s.tmuxPane,
        transcriptPath: e.transcriptPath ?? s.transcriptPath,
        startedAt: Math.min(s.startedAt, e.startedAt ?? s.startedAt),
      };
    case 'title':
      return { ...s, title: e.title };
    case 'branch':
      return e.branch ? { ...s, workspace: { ...s.workspace, branch: e.branch } } : s;
    case 'agent.started':
      return withChild(s, e.agentId, { type: e.agentType, description: e.description, running: true, updatedAt: e.ts });
    case 'agent.finished':
      return settleMeeting(withChild(s, e.agentId, { running: false, updatedAt: e.ts }), e.ts);
    case 'tool.started':
      if (e.agentId) return withChild(s, e.agentId, { lastAction: e.label, running: true, updatedAt: e.ts });
      break;
    case 'tool.finished':
      if (e.agentId) return withChild(s, e.agentId, { updatedAt: e.ts });
      break;
  }

  if (!isNewer(s, e)) {
    if (e.type === 'prompt' && e.text && !s.firstPrompt) return { ...s, firstPrompt: e.text };
    return s;
  }
  s = { ...s, lastEventAt: e.ts, lastSeq: e.seq };

  switch (e.type) {
    case 'session.started':
      return { ...setState(s, 'idle', e.ts), waitReason: null, openTool: null };
    case 'prompt':
      return {
        ...setState(s, 'working', e.ts),
        waitReason: null,
        seenAt: null,
        lastPrompt: e.text ?? s.lastPrompt,
        firstPrompt: s.firstPrompt ?? e.text,
      };
    case 'tool.started':
      return {
        ...setState(s, 'working', e.ts),
        waitReason: null,
        openTool: { id: e.toolId, label: e.label, startedAt: e.ts },
        lastAction: e.label,
        lastActionAt: e.ts,
      };
    case 'tool.finished': {
      const closes = s.openTool && (e.toolId === null || s.openTool.id === e.toolId);
      return { ...setState(s, s.state === 'ended' ? 'ended' : 'working', e.ts), waitReason: null, openTool: closes ? null : s.openTool };
    }
    case 'waiting': {
      const keep = s.state === 'needs_you' && s.waitReason?.kind === e.reason.kind && s.waitReason.detail && !e.reason.detail;
      return { ...setState(s, 'needs_you', e.ts), waitReason: keep ? s.waitReason : e.reason };
    }
    case 'turn.finished': {
      const meeting = e.backgroundTasks > 0 || s.children.some((c) => c.running);
      return {
        ...setState(s, meeting ? 'in_meeting' : 'done', e.ts),
        backgroundTasks: e.backgroundTasks,
        waitReason: null,
        openTool: null,
        seenAt: null,
      };
    }
    case 'session.status':
      return applyStatus(s, e);
    case 'session.ended':
      return { ...setState(s, 'ended', e.ts), waitReason: null, openTool: null };
  }
  return s;
}

/** The user has looked at a finished session. Only 'done' sessions change. */
export function markSeen(s: Session, now: number): Session {
  return s.state === 'done' ? { ...s, seenAt: now } : s;
}
```

Note on the "keeps a detailed wait reason" test: `setState` keeps `stateSince` because the state is already `needs_you`.

**Step 5: Run the tests**

Run: `npx vitest run test/core/reducer.test.ts && npm run typecheck`
Expected: PASS. If a test fails, fix the implementation, not the test. If you believe a test is wrong, stop and report.

**Step 6: Commit**

```bash
git add src/core/reducer.ts test/core/reducer.test.ts test/helpers/events.ts
git commit -m "Fold normalized events into session state"
```

---

### Task 7: Views: effective state, floors, attention

Time-based transitions are computed at read time from `now`, never by timers. This keeps the reducer pure and survives restarts.

**Files:**
- Create: `src/core/view.ts`, `test/core/view.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { DEFAULT_THRESHOLDS as T } from '../../src/config.js';
import { newSession } from '../../src/core/reducer.js';
import type { Session, SessionState } from '../../src/core/types.js';
import { buildAttention, buildFloors, effectiveState, toView } from '../../src/core/view.js';
import { WS } from '../helpers/events.js';

const H = 60 * 60 * 1000;
function sess(id: string, state: SessionState, stateSince: number, extra: Partial<Session> = {}): Session {
  return { ...newSession(id, 0, WS), state, stateSince, lastEventAt: stateSince, ...extra };
}

describe('effectiveState', () => {
  it('turns done into idle after the threshold or once seen', () => {
    expect(effectiveState(sess('a', 'done', 0), 4 * H - 1, T)).toEqual({ state: 'done', since: 0 });
    expect(effectiveState(sess('a', 'done', 0), 4 * H, T)).toEqual({ state: 'idle', since: 4 * H });
    expect(effectiveState(sess('a', 'done', 0, { seenAt: 10 }), 20, T)).toEqual({ state: 'idle', since: 10 });
    // seen before the current done started does not count
    expect(effectiveState(sess('a', 'done', 100, { seenAt: 10 }), 200, T).state).toBe('done');
  });

  it('turns idle into dormant after three days', () => {
    expect(effectiveState(sess('a', 'idle', 0), 3 * 24 * H, T)).toEqual({ state: 'dormant', since: 3 * 24 * H });
    expect(effectiveState(sess('a', 'done', 0), 4 * H + 3 * 24 * H, T).state).toBe('dormant');
  });

  it('turns quiet work into no_signal, counting subagent activity', () => {
    expect(effectiveState(sess('a', 'working', 0), 10 * 60 * 1000, T)).toEqual({ state: 'no_signal', since: 10 * 60 * 1000 });
    const busyChild = sess('a', 'working', 0, { children: [{ id: 'c', type: 'Explore', description: null, running: true, lastAction: null, updatedAt: 9 * 60 * 1000 }] });
    expect(effectiveState(busyChild, 10 * 60 * 1000, T).state).toBe('working');
  });

  it('leaves other states alone', () => {
    for (const st of ['needs_you', 'in_meeting', 'ended'] as const) {
      expect(effectiveState(sess('a', st, 0), 999 * H, T).state).toBe(st);
    }
  });
});

describe('buildFloors', () => {
  const now = 10 * H;
  const v = (id: string, repoName: string, branch: string | null, state: SessionState, startedAt: number) =>
    toView({ ...sess(id, state, now - 1), startedAt, workspace: { ...WS, repoName, branch } }, now);

  it('groups by feature across repos and by repo for trunk work, newest floor first', () => {
    const floors = buildFloors([
      v('a', 'storefront-web', 'feat/checkout-v2', 'working', 100),
      v('b', 'orders-api', 'feat/checkout-v2', 'needs_you', 50),
      v('c', 'orders-api', 'main', 'done', 300),
      v('d', 'orders-api', 'main', 'ended', 400),
    ]);
    expect(floors.map((f) => [f.key, f.kind, f.name, f.repos])).toEqual([
      ['repo:orders-api', 'department', 'orders-api', ['orders-api']],
      ['feature:checkout-v2', 'feature', 'checkout-v2', ['orders-api', 'storefront-web']],
    ]);
    expect(floors[1]!.counts).toEqual({ working: 1, needs_you: 1 });
    expect(floors[1]!.sessions.map((s) => s.id)).toEqual(['b', 'a']);
  });

  it('marks a floor dormant only when every session on it is dormant', () => {
    const old = toView({ ...sess('x', 'idle', 0), workspace: { ...WS, branch: 'feat/docs' } }, 4 * 24 * H);
    const fresh = toView({ ...sess('y', 'working', 4 * 24 * H), workspace: { ...WS, branch: 'feat/docs' } }, 4 * 24 * H);
    expect(buildFloors([old])[0]!.dormant).toBe(true);
    expect(buildFloors([old, fresh])[0]!.dormant).toBe(false);
  });
});

describe('buildAttention', () => {
  it('lists needs_you and done, longest wait first', () => {
    const now = 10 * H;
    const views = [
      toView(sess('late', 'needs_you', 9 * H), now),
      toView(sess('early', 'needs_you', 8 * H), now),
      toView(sess('d', 'done', 9.5 * H), now),
      toView(sess('w', 'working', 9.9 * H), now),
    ];
    const a = buildAttention(views);
    expect(a.needsYou.map((s) => s.id)).toEqual(['early', 'late']);
    expect(a.done.map((s) => s.id)).toEqual(['d']);
  });
});
```

**Step 2: Run it to see it fail**

Run: `npx vitest run test/core/view.test.ts`
Expected: FAIL, module not found.

**Step 3: Implement `src/core/view.ts`**

```ts
import { DEFAULT_THRESHOLDS, type Thresholds } from '../config.js';
import { DEFAULT_FEATURE_RULES, deriveFeature, type FeatureRules } from './feature.js';
import type { Session, SessionState } from './types.js';

export interface SessionView extends Session {
  effectiveState: SessionState;
  effectiveSince: number;
  feature: string | null;
}

export function effectiveState(s: Session, now: number, t: Thresholds = DEFAULT_THRESHOLDS): { state: SessionState; since: number } {
  let state = s.state;
  let since = s.stateSince;

  if (state === 'done') {
    const seen = s.seenAt !== null && s.seenAt >= s.stateSince;
    if (seen) {
      state = 'idle';
      since = s.seenAt as number;
    } else if (now - s.stateSince >= t.doneToIdleMs) {
      state = 'idle';
      since = s.stateSince + t.doneToIdleMs;
    }
  }
  if (state === 'idle' && now - since >= t.idleToDormantMs) {
    state = 'dormant';
    since = since + t.idleToDormantMs;
  }
  if (state === 'working') {
    const lastActivity = Math.max(s.lastEventAt, s.stateSince, ...s.children.map((c) => c.updatedAt));
    if (now - lastActivity >= t.noSignalMs) {
      state = 'no_signal';
      since = lastActivity + t.noSignalMs;
    }
  }
  return { state, since };
}

export function toView(s: Session, now: number, t: Thresholds = DEFAULT_THRESHOLDS, rules: FeatureRules = DEFAULT_FEATURE_RULES): SessionView {
  const eff = effectiveState(s, now, t);
  return { ...s, effectiveState: eff.state, effectiveSince: eff.since, feature: deriveFeature(s.workspace.branch, s.workspace.repoName, rules) };
}

export interface Floor {
  key: string;
  kind: 'feature' | 'department';
  name: string;
  repos: string[];
  sessions: SessionView[];
  counts: Partial<Record<SessionState, number>>;
  /** Earliest session start on the floor; floors are ordered newest first by this. */
  openedAt: number;
  dormant: boolean;
}

export function buildFloors(views: SessionView[]): Floor[] {
  const map = new Map<string, Floor>();
  for (const v of views) {
    if (v.effectiveState === 'ended') continue;
    const key = v.feature ? `feature:${v.feature}` : `repo:${v.workspace.repoName}`;
    let f = map.get(key);
    if (!f) {
      f = { key, kind: v.feature ? 'feature' : 'department', name: v.feature ?? v.workspace.repoName, repos: [], sessions: [], counts: {}, openedAt: v.startedAt, dormant: true };
      map.set(key, f);
    }
    f.sessions.push(v);
    if (!f.repos.includes(v.workspace.repoName)) f.repos.push(v.workspace.repoName);
    f.counts[v.effectiveState] = (f.counts[v.effectiveState] ?? 0) + 1;
    f.openedAt = Math.min(f.openedAt, v.startedAt);
    if (v.effectiveState !== 'dormant') f.dormant = false;
  }
  const floors = [...map.values()];
  for (const f of floors) {
    f.repos.sort();
    f.sessions.sort((a, b) => a.workspace.repoName.localeCompare(b.workspace.repoName) || a.startedAt - b.startedAt);
  }
  return floors.sort((a, b) => b.openedAt - a.openedAt || a.key.localeCompare(b.key));
}

export interface Attention {
  needsYou: SessionView[];
  done: SessionView[];
}

export function buildAttention(views: SessionView[]): Attention {
  const pick = (st: SessionState) => views.filter((v) => v.effectiveState === st).sort((a, b) => a.effectiveSince - b.effectiveSince);
  return { needsYou: pick('needs_you'), done: pick('done') };
}
```

Check the floor-order expectation in the first floor test: the department floor's earliest start is 300, the feature floor's is 50, so the department floor comes first (newest first).

**Step 4: Run the tests**

Run: `npx vitest run test/core && npm run typecheck`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/core/view.ts test/core/view.test.ts
git commit -m "Derive time-based states, feature floors and the attention queue"
```

---

# Part B: adapters

### Task 8: JSONL reader

Reads transcripts incrementally. **The offset only ever advances past a newline**, so a line still being written is re-read on the next call, and multi-byte characters are never split. A single line longer than `maxBytes` is skipped.

**Files:**
- Create: `src/adapters/claude-code/jsonl.ts`, `test/adapters/jsonl.test.ts`

**Step 1: Write the failing test**

```ts
import { beforeAll, describe, expect, it } from 'vitest';
import { appendFile, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readHeadLines, readNewLines, readTailLines, type TailState } from '../../src/adapters/claude-code/jsonl.js';

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'shq-jsonl-'));
});
const start = (path: string): TailState => ({ path, offset: 0, skipping: false });

describe('readNewLines', () => {
  it('returns complete lines and resumes a partial one later', async () => {
    const p = join(dir, 'partial.jsonl');
    await writeFile(p, '{"a":1}\n{"b":');
    let r = await readNewLines(start(p));
    expect(r.lines).toEqual(['{"a":1}']);
    expect(r.state.offset).toBe(8);
    r = await readNewLines(r.state);
    expect(r.lines).toEqual([]);
    await appendFile(p, '2}\n');
    r = await readNewLines(r.state);
    expect(r.lines).toEqual(['{"b":2}']);
  });

  it('never splits a multi-byte character', async () => {
    const p = join(dir, 'utf8.jsonl');
    const bytes = Buffer.from('{"t":"caffè ☕"}\n');
    await writeFile(p, bytes.subarray(0, 14));
    let r = await readNewLines(start(p));
    expect(r.lines).toEqual([]);
    await appendFile(p, bytes.subarray(14));
    r = await readNewLines(r.state);
    expect(JSON.parse(r.lines[0]!).t).toBe('caffè ☕');
  });

  it('starts over when the file shrinks', async () => {
    const p = join(dir, 'shrink.jsonl');
    await writeFile(p, '{"x":1}\n{"y":2}\n');
    const r1 = await readNewLines(start(p));
    await writeFile(p, '{"z":3}\n');
    const r2 = await readNewLines(r1.state);
    expect(r2.lines).toEqual(['{"z":3}']);
  });

  it('skips a line longer than maxBytes and continues after it', async () => {
    const p = join(dir, 'giant.jsonl');
    await writeFile(p, 'A'.repeat(40) + '\n{"ok":1}\n');
    let state = start(p);
    let lines: string[] = [];
    for (let i = 0; i < 10 && lines.length === 0; i++) {
      const r = await readNewLines(state, 16);
      state = r.state;
      lines = r.lines;
    }
    expect(lines).toEqual(['{"ok":1}']);
  });

  it('returns nothing for a missing file', async () => {
    const r = await readNewLines(start(join(dir, 'missing.jsonl')));
    expect(r.lines).toEqual([]);
    expect(r.state.offset).toBe(0);
  });
});

describe('readHeadLines and readTailLines', () => {
  it('reads only complete lines at either end', async () => {
    const p = join(dir, 'ends.jsonl');
    await writeFile(p, '{"n":1}\n{"n":2}\n{"n":3}\n');
    expect(await readHeadLines(p, 12)).toEqual(['{"n":1}']);
    expect(await readTailLines(p, 12)).toEqual({ lines: ['{"n":3}'], offset: 24 });
    expect(await readTailLines(p, 1000)).toEqual({ lines: ['{"n":1}', '{"n":2}', '{"n":3}'], offset: 24 });
  });

  it('stops the tail offset before a trailing partial line', async () => {
    const p = join(dir, 'tail-partial.jsonl');
    await writeFile(p, '{"n":1}\n{"n":2');
    expect(await readTailLines(p, 1000)).toEqual({ lines: ['{"n":1}'], offset: 8 });
  });
});
```

**Step 2: Run it to see it fail**

Run: `npx vitest run test/adapters/jsonl.test.ts`
Expected: FAIL, module not found.

**Step 3: Implement `src/adapters/claude-code/jsonl.ts`**

```ts
import { open, stat } from 'node:fs/promises';

export interface TailState {
  path: string;
  /** Byte offset of the next unread line. Always just after a newline (or 0). */
  offset: number;
  /** True while skipping the rest of a line longer than maxBytes. */
  skipping: boolean;
}

const NL = 0x0a;

async function fileSize(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size;
  } catch {
    return null;
  }
}

async function readChunk(path: string, position: number, length: number): Promise<Buffer> {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, position);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

function splitLines(buf: Buffer): string[] {
  return buf.toString('utf8').split('\n').filter((l) => l.trim() !== '');
}

/** Complete lines appended since state.offset. */
export async function readNewLines(state: TailState, maxBytes = 4 * 1024 * 1024): Promise<{ lines: string[]; state: TailState }> {
  const size = await fileSize(state.path);
  if (size === null) return { lines: [], state };
  let offset = state.offset;
  let skipping = state.skipping;
  if (size < offset) {
    offset = 0;
    skipping = false;
  }
  if (size === offset) return { lines: [], state: { path: state.path, offset, skipping } };

  const buf = await readChunk(state.path, offset, Math.min(size - offset, maxBytes));
  let from = 0;
  if (skipping) {
    const nl = buf.indexOf(NL);
    if (nl === -1) return { lines: [], state: { path: state.path, offset: offset + buf.length, skipping: true } };
    from = nl + 1;
    skipping = false;
  }
  const last = buf.lastIndexOf(NL);
  if (last < from) {
    if (from === 0 && buf.length === maxBytes) {
      return { lines: [], state: { path: state.path, offset: offset + buf.length, skipping: true } };
    }
    return { lines: [], state: { path: state.path, offset: offset + from, skipping } };
  }
  return { lines: splitLines(buf.subarray(from, last)), state: { path: state.path, offset: offset + last + 1, skipping } };
}

/** Complete lines within the first `bytes` of the file. */
export async function readHeadLines(path: string, bytes = 64 * 1024): Promise<string[]> {
  const size = await fileSize(path);
  if (!size) return [];
  const buf = await readChunk(path, 0, Math.min(size, bytes));
  const last = buf.lastIndexOf(NL);
  return last === -1 ? [] : splitLines(buf.subarray(0, last));
}

/** Complete lines within the last `bytes` of the file, and the offset to keep tailing from. */
export async function readTailLines(path: string, bytes = 512 * 1024): Promise<{ lines: string[]; offset: number }> {
  const size = await fileSize(path);
  if (!size) return { lines: [], offset: 0 };
  const start = Math.max(0, size - bytes);
  const buf = await readChunk(path, start, size - start);
  let from = 0;
  if (start > 0) {
    const nl = buf.indexOf(NL);
    if (nl === -1) return { lines: [], offset: size };
    from = nl + 1;
  }
  const last = buf.lastIndexOf(NL);
  if (last < from) return { lines: [], offset: start + from };
  return { lines: splitLines(buf.subarray(from, last)), offset: start + last + 1 };
}
```

**Step 4: Run the tests**

Run: `npx vitest run test/adapters/jsonl.test.ts && npm run typecheck`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/adapters/claude-code/jsonl.ts test/adapters/jsonl.test.ts
git commit -m "Read JSONL files incrementally without splitting lines"
```

---

### Task 9: Transcript parser

One transcript line in, zero or more events out. Pure. Never throws.

**Files:**
- Create: `src/adapters/claude-code/transcript.ts`, `test/adapters/transcript.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { parseTranscriptLine, promptText } from '../../src/adapters/claude-code/transcript.js';

const S = 'S1';
const T = '2026-10-10T10:00:00.000Z';
const TS = Date.parse(T);
const line = (o: object) => JSON.stringify(o);

describe('promptText', () => {
  it('keeps typed text and drops command and system wrappers', () => {
    expect(promptText('  Add keys  ')).toBe('Add keys');
    expect(promptText([{ type: 'text', text: 'hello' }, { type: 'image' }])).toBe('hello');
    expect(promptText('<command-name>/clear</command-name>')).toBeNull();
    expect(promptText('<task-notification>done</task-notification>')).toBeNull();
    expect(promptText('<system-reminder>x</system-reminder>')).toBeNull();
    expect(promptText('')).toBeNull();
    expect(promptText(42)).toBeNull();
    expect(promptText('x'.repeat(300))).toHaveLength(200);
  });
});

describe('parseTranscriptLine', () => {
  it('reads the AI title', () => {
    expect(parseTranscriptLine(line({ type: 'ai-title', aiTitle: 'Fix checkout', sessionId: S }), S).events)
      .toEqual([{ sessionId: S, ts: 0, source: 'fs', type: 'title', title: 'Fix checkout' }]);
  });

  it('reads a typed prompt with its timestamp, branch and cwd', () => {
    const r = parseTranscriptLine(line({ type: 'user', timestamp: T, cwd: '/w/shop', gitBranch: 'feat/x', sessionId: S, message: { role: 'user', content: 'Add idempotency keys' } }), S);
    expect(r).toEqual({
      ts: TS,
      branch: 'feat/x',
      cwd: '/w/shop',
      events: [{ sessionId: S, ts: TS, source: 'fs', type: 'prompt', text: 'Add idempotency keys' }],
    });
  });

  it('skips meta and command messages', () => {
    expect(parseTranscriptLine(line({ type: 'user', timestamp: T, isMeta: true, message: { content: 'hidden' } }), S).events).toEqual([]);
    expect(parseTranscriptLine(line({ type: 'user', timestamp: T, message: { content: '<command-name>/clear</command-name>' } }), S).events).toEqual([]);
  });

  it('turns tool results into tool.finished and never into prompts', () => {
    const r = parseTranscriptLine(line({ type: 'user', timestamp: T, message: { content: [
      { type: 'tool_result', tool_use_id: 't1', content: 'ok' },
      { type: 'tool_result', tool_use_id: 't2', is_error: true, content: 'boom' },
    ] } }), S);
    expect(r.events).toEqual([
      { sessionId: S, ts: TS, source: 'fs', type: 'tool.finished', toolId: 't1', ok: true, agentId: null },
      { sessionId: S, ts: TS, source: 'fs', type: 'tool.finished', toolId: 't2', ok: false, agentId: null },
    ]);
  });

  it('turns assistant tool uses into tool.started or waiting', () => {
    const r = parseTranscriptLine(line({ type: 'assistant', timestamp: T, cwd: '/w/shop', message: { content: [
      { type: 'thinking', thinking: '...' },
      { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/w/shop/src/a.ts' } },
      { type: 'tool_use', id: 't2', name: 'AskUserQuestion', input: { questions: [{ question: 'Redis or Postgres?' }] } },
    ] } }), S);
    expect(r.events).toEqual([
      { sessionId: S, ts: TS, source: 'fs', type: 'tool.started', toolId: 't1', tool: 'Edit', label: 'Edit src/a.ts', agentId: null },
      { sessionId: S, ts: TS, source: 'fs', type: 'waiting', reason: { kind: 'question', text: 'Redis or Postgres?' } },
    ]);
  });

  it('uses the cwd hint when the line has none', () => {
    const r = parseTranscriptLine(line({ type: 'assistant', timestamp: T, message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/w/shop/README.md' } }] } }), S, '/w/shop');
    expect(r.events[0]).toMatchObject({ label: 'Read README.md' });
  });

  it('ignores sidechain entries, bad JSON and unknown entry types', () => {
    expect(parseTranscriptLine(line({ type: 'user', isSidechain: true, timestamp: T, message: { content: 'x' } }), S).events).toEqual([]);
    expect(parseTranscriptLine('{not json', S)).toEqual({ events: [] });
    expect(parseTranscriptLine('null', S)).toEqual({ events: [] });
    expect(parseTranscriptLine(line({ type: 'file-history-snapshot', snapshot: {} }), S).events).toEqual([]);
  });
});
```

**Step 2: Run it to see it fail**

Run: `npx vitest run test/adapters/transcript.test.ts`
Expected: FAIL, module not found.

**Step 3: Implement `src/adapters/claude-code/transcript.ts`**

```ts
import { toolLabel, truncate, waitingFromTool } from '../../core/tool-label.js';
import type { RawEvent } from '../../core/types.js';

export interface ParsedLine {
  events: RawEvent[];
  ts?: number;
  branch?: string;
  cwd?: string;
}

const WRAPPERS = ['<command-', '<local-command', '<task-notification', '<system-reminder', '<bash-', '<user-prompt-submit-hook'];

function cleanPrompt(text: string): string | null {
  const t = text.trim();
  if (!t || WRAPPERS.some((w) => t.startsWith(w))) return null;
  return truncate(t, 200);
}

/** The text a person typed, from a string or an array of content blocks. Null for wrappers and non-text. */
export function promptText(content: unknown): string | null {
  if (typeof content === 'string') return cleanPrompt(content);
  if (Array.isArray(content)) {
    const texts = content
      .filter((c): c is { type: 'text'; text: unknown } => !!c && typeof c === 'object' && (c as { type?: unknown }).type === 'text')
      .map((c) => (typeof c.text === 'string' ? c.text : ''));
    return texts.length ? cleanPrompt(texts.join('\n')) : null;
  }
  return null;
}

type Block = { type?: unknown; id?: unknown; name?: unknown; input?: unknown; tool_use_id?: unknown; is_error?: unknown };

export function parseTranscriptLine(line: string, sessionId: string, cwdHint?: string): ParsedLine {
  let e: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(line);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { events: [] };
    e = parsed as Record<string, unknown>;
  } catch {
    return { events: [] };
  }

  const out: ParsedLine = { events: [] };
  const ts = typeof e.timestamp === 'string' ? Date.parse(e.timestamp) : NaN;
  if (Number.isFinite(ts)) out.ts = ts;
  if (typeof e.gitBranch === 'string' && e.gitBranch) out.branch = e.gitBranch;
  if (typeof e.cwd === 'string' && e.cwd) out.cwd = e.cwd;
  const base = { sessionId, ts: Number.isFinite(ts) ? ts : 0, source: 'fs' as const };

  if (e.type === 'ai-title') {
    if (typeof e.aiTitle === 'string' && e.aiTitle.trim()) out.events.push({ ...base, type: 'title', title: truncate(e.aiTitle, 120) });
    return out;
  }
  if (e.isSidechain === true) return out;

  const message = e.message && typeof e.message === 'object' ? (e.message as { content?: unknown }) : {};
  const content = message.content;

  if (e.type === 'user') {
    if (e.isMeta === true) return out;
    const blocks: Block[] = Array.isArray(content) ? (content as Block[]) : [];
    const results = blocks.filter((b) => b && b.type === 'tool_result');
    for (const b of results) {
      out.events.push({ ...base, type: 'tool.finished', toolId: typeof b.tool_use_id === 'string' ? b.tool_use_id : null, ok: b.is_error !== true, agentId: null });
    }
    if (results.length === 0) {
      const text = promptText(content);
      if (text) out.events.push({ ...base, type: 'prompt', text });
    }
    return out;
  }

  if (e.type === 'assistant' && Array.isArray(content)) {
    for (const b of content as Block[]) {
      if (!b || b.type !== 'tool_use' || typeof b.name !== 'string') continue;
      const wait = waitingFromTool(b.name, b.input);
      if (wait) out.events.push({ ...base, type: 'waiting', reason: wait });
      else out.events.push({ ...base, type: 'tool.started', toolId: typeof b.id === 'string' ? b.id : null, tool: b.name, label: toolLabel(b.name, b.input, out.cwd ?? cwdHint), agentId: null });
    }
  }
  return out;
}
```

**Step 4: Run the tests**

Run: `npx vitest run test/adapters/transcript.test.ts && npm run typecheck`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/adapters/claude-code/transcript.ts test/adapters/transcript.test.ts
git commit -m "Parse Claude Code transcript lines into events"
```

---

### Task 10: Sessions directory and process liveness

`~/.claude/sessions/<pid>.json` lists live interactive sessions. A file can outlive its process, and pids get recycled, so a session counts as live only when its pid is running **and** that process started no later than the file's `startedAt` (plus a tolerance). Process start comes from `ps -o etime=` (elapsed time, a locale-independent format), never from parsing date strings.

**Files:**
- Create: `src/adapters/claude-code/sessions-dir.ts`, `test/adapters/sessions-dir.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isSameProcess, parseEtime, parseSessionFile, psProbe, readSessionsDir } from '../../src/adapters/claude-code/sessions-dir.js';

const SAMPLE = {
  pid: 15227,
  sessionId: '7ef904e4-9872-4cca-924f-e7ddde08fc55',
  cwd: '/w/shop/orders-api',
  startedAt: 1791569018989,
  procStart: 'Fri Oct  9 18:03:38 2026',
  version: '2.1.294',
  kind: 'interactive',
  entrypoint: 'cli',
  tmux: 'xirp-7ef904e4:@12.%12',
  name: 'orders-api-7c',
  status: 'waiting',
  statusUpdatedAt: 1791569019161,
  waitingFor: 'input needed',
  somethingNew: { ignored: true },
};

describe('parseSessionFile', () => {
  it('reads the fields we use and ignores the rest', () => {
    expect(parseSessionFile('/s/15227.json', JSON.stringify(SAMPLE))).toEqual({
      file: '/s/15227.json',
      pid: 15227,
      sessionId: SAMPLE.sessionId,
      cwd: '/w/shop/orders-api',
      startedAt: 1791569018989,
      status: 'waiting',
      statusUpdatedAt: 1791569019161,
      waitingFor: 'input needed',
      name: 'orders-api-7c',
      tmuxPane: '%12',
      kind: 'interactive',
    });
  });

  it('degrades missing or unknown optional fields', () => {
    const r = parseSessionFile('/s/1.json', JSON.stringify({ pid: 1, sessionId: 'S', cwd: '/w', status: 'thinking' }));
    expect(r).toMatchObject({ startedAt: 0, status: null, statusUpdatedAt: null, waitingFor: null, name: null, tmuxPane: null, kind: null });
  });

  it('rejects files without pid, sessionId or cwd, and bad JSON', () => {
    expect(parseSessionFile('/s/x.json', '{oops')).toBeNull();
    expect(parseSessionFile('/s/x.json', JSON.stringify({ sessionId: 'S', cwd: '/w' }))).toBeNull();
    expect(parseSessionFile('/s/x.json', JSON.stringify({ pid: 1, cwd: '/w' }))).toBeNull();
    expect(parseSessionFile('/s/x.json', JSON.stringify({ pid: 1, sessionId: 'S' }))).toBeNull();
  });
});

describe('readSessionsDir', () => {
  it('reads valid json files and skips the rest', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'shq-sessions-'));
    await writeFile(join(dir, '1.json'), JSON.stringify({ pid: 1, sessionId: 'A', cwd: '/w' }));
    await writeFile(join(dir, '2.json'), '{broken');
    await writeFile(join(dir, '1.abc.key'), 'secret');
    const files = await readSessionsDir(dir);
    expect(files.map((f) => f.sessionId)).toEqual(['A']);
    expect(await readSessionsDir(join(dir, 'missing'))).toEqual([]);
  });
});

describe('parseEtime', () => {
  it('parses [[dd-]hh:]mm:ss', () => {
    expect(parseEtime('00:08')).toBe(8);
    expect(parseEtime('12:34')).toBe(754);
    expect(parseEtime('1:02:03')).toBe(3723);
    expect(parseEtime('02-08:52:46')).toBe((2 * 24 + 8) * 3600 + 52 * 60 + 46);
    expect(parseEtime(' 05:00 ')).toBe(300);
    expect(parseEtime('nonsense')).toBeNull();
  });
});

describe('psProbe', () => {
  it('finds the start time of a running process and ignores unknown pids', async () => {
    const now = Date.now();
    const starts = await psProbe([process.pid, 999_999_999], now);
    const mine = starts.get(process.pid);
    expect(mine).toBeDefined();
    expect(mine!).toBeLessThanOrEqual(now);
    expect(mine!).toBeGreaterThan(now - 24 * 60 * 60 * 1000);
    expect(starts.has(999_999_999)).toBe(false);
    expect((await psProbe([], now)).size).toBe(0);
  });
});

describe('isSameProcess', () => {
  const file = parseSessionFile('/s/1.json', JSON.stringify({ pid: 1, sessionId: 'S', cwd: '/w', startedAt: 100_000 }))!;
  it('accepts a process that started before (or just after) the file', () => {
    expect(isSameProcess(file, 90_000)).toBe(true);
    expect(isSameProcess(file, 160_000)).toBe(true);
  });
  it('rejects a recycled pid and a missing process', () => {
    expect(isSameProcess(file, 160_001)).toBe(false);
    expect(isSameProcess(file, undefined)).toBe(false);
  });
  it('accepts any running process when the file has no startedAt', () => {
    const bare = parseSessionFile('/s/2.json', JSON.stringify({ pid: 2, sessionId: 'T', cwd: '/w' }))!;
    expect(isSameProcess(bare, 5)).toBe(true);
  });
});
```

**Step 2: Run it to see it fail**

Run: `npx vitest run test/adapters/sessions-dir.test.ts`
Expected: FAIL, module not found.

**Step 3: Implement `src/adapters/claude-code/sessions-dir.ts`**

```ts
import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export interface LiveSessionFile {
  file: string;
  pid: number;
  sessionId: string;
  cwd: string;
  /** 0 when the file does not say. */
  startedAt: number;
  status: 'busy' | 'idle' | 'waiting' | null;
  statusUpdatedAt: number | null;
  waitingFor: string | null;
  name: string | null;
  tmuxPane: string | null;
  kind: string | null;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

export function parseSessionFile(file: string, text: string): LiveSessionFile | null {
  let d: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    d = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!Number.isInteger(d.pid) || typeof d.sessionId !== 'string' || !d.sessionId || typeof d.cwd !== 'string' || !d.cwd) return null;
  const status = d.status === 'busy' || d.status === 'idle' || d.status === 'waiting' ? d.status : null;
  const tmux = str(d.tmux);
  return {
    file,
    pid: d.pid as number,
    sessionId: d.sessionId,
    cwd: d.cwd,
    startedAt: num(d.startedAt) ?? 0,
    status,
    statusUpdatedAt: num(d.statusUpdatedAt),
    waitingFor: str(d.waitingFor),
    name: str(d.name),
    tmuxPane: tmux ? (tmux.match(/%\d+$/)?.[0] ?? null) : null,
    kind: str(d.kind),
  };
}

export async function readSessionsDir(dir: string): Promise<LiveSessionFile[]> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith('.json')).sort();
  } catch {
    return [];
  }
  const out: LiveSessionFile[] = [];
  for (const n of names) {
    const path = join(dir, n);
    try {
      const s = parseSessionFile(path, await readFile(path, 'utf8'));
      if (s) out.push(s);
    } catch {
      // the file disappeared between readdir and readFile
    }
  }
  return out;
}

/** pid -> process start time in ms, for the pids that are running. */
export type ProcessProbe = (pids: number[], now: number) => Promise<Map<number, number>>;

/** Parses ps etime, "[[dd-]hh:]mm:ss", into seconds. */
export function parseEtime(etime: string): number | null {
  const m = etime.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return null;
  const [, d, h, mi, s] = m;
  return ((Number(d ?? 0) * 24 + Number(h ?? 0)) * 60 + Number(mi)) * 60 + Number(s);
}

export const psProbe: ProcessProbe = async (pids, now) => {
  const out = new Map<number, number>();
  const unique = [...new Set(pids)].filter((p) => Number.isInteger(p) && p > 0);
  if (unique.length === 0) return out;
  let stdout = '';
  try {
    ({ stdout } = await execFileP('ps', ['-o', 'pid=,etime=', '-p', unique.join(',')]));
  } catch (err) {
    // ps exits 1 when some pids are gone but still prints the ones it found
    stdout = (err as { stdout?: string }).stdout ?? '';
  }
  for (const line of stdout.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\S+)$/);
    if (!m) continue;
    const seconds = parseEtime(m[2]!);
    if (seconds !== null) out.set(Number(m[1]), now - seconds * 1000);
  }
  return out;
};

/** True when the running process is the one that wrote the file, not a later process that reused its pid. */
export function isSameProcess(file: LiveSessionFile, processStartMs: number | undefined, toleranceMs = 60_000): boolean {
  if (processStartMs === undefined) return false;
  if (!file.startedAt) return true;
  return processStartMs <= file.startedAt + toleranceMs;
}
```

**Step 4: Run the tests**

Run: `npx vitest run test/adapters/sessions-dir.test.ts && npm run typecheck`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/adapters/claude-code/sessions-dir.ts test/adapters/sessions-dir.test.ts
git commit -m "Read live session files and check process liveness"
```

---

### Task 11: Git workspace resolver

**Files:**
- Create: `src/adapters/git.ts`, `test/adapters/git.test.ts`

**Step 1: Write the failing test**

The test creates real repositories in a temp directory. `core.hooksPath=/dev/null` keeps the developer's global git hooks out of it.

```ts
import { beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { createGitResolver, resolveWorkspace, type GitRunner } from '../../src/adapters/git.js';

const execFileP = promisify(execFile);
const git = (cwd: string, ...args: string[]) =>
  execFileP('git', ['-C', cwd, '-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'core.hooksPath=/dev/null', ...args]);

let base: string;
let repo: string;
beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'shq-git-')));
  repo = join(base, 'orders-api');
  await mkdir(join(repo, 'src'), { recursive: true });
  await git(repo, 'init', '-q', '-b', 'main');
  await git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
  await git(repo, 'checkout', '-q', '-b', 'feat/checkout-v2');
  await git(repo, 'worktree', 'add', '-q', '-b', 'feat/other', join(base, 'wt-other'));
  await git(repo, 'worktree', 'add', '-q', '--detach', join(base, 'wt-detached'));
});

describe('resolveWorkspace', () => {
  it('describes a directory outside git', async () => {
    const plain = join(base, 'plain');
    await mkdir(plain);
    expect(await resolveWorkspace(plain)).toEqual({ cwd: plain, repoRoot: null, repoName: 'plain', worktree: false, branch: null });
  });

  it('describes the main checkout and its subdirectories', async () => {
    expect(await resolveWorkspace(repo)).toEqual({ cwd: repo, repoRoot: repo, repoName: 'orders-api', worktree: false, branch: 'feat/checkout-v2' });
    expect(await resolveWorkspace(join(repo, 'src'))).toMatchObject({ repoRoot: repo, repoName: 'orders-api', worktree: false });
  });

  it('maps a linked worktree to its main repository', async () => {
    const wt = join(base, 'wt-other');
    expect(await resolveWorkspace(wt)).toEqual({ cwd: wt, repoRoot: repo, repoName: 'orders-api', worktree: true, branch: 'feat/other' });
  });

  it('reports a detached HEAD', async () => {
    expect((await resolveWorkspace(join(base, 'wt-detached'))).branch).toBe('HEAD');
  });

  it('falls back to the directory name when git is unavailable', async () => {
    const failing: GitRunner = async () => null;
    expect(await resolveWorkspace('/x/y/storefront', failing)).toEqual({ cwd: '/x/y/storefront', repoRoot: null, repoName: 'storefront', worktree: false, branch: null });
  });
});

describe('createGitResolver', () => {
  it('caches per cwd within the ttl', async () => {
    let calls = 0;
    let now = 0;
    const counting: GitRunner = async () => { calls++; return null; };
    const resolve = createGitResolver(1000, counting, () => now);
    await resolve('/a');
    await resolve('/a');
    expect(calls).toBe(1);
    now = 1000;
    await resolve('/a');
    expect(calls).toBe(2);
    expect(basename((await resolve('/b')).cwd)).toBe('b');
  });
});
```

**Step 2: Run it to see it fail**

Run: `npx vitest run test/adapters/git.test.ts`
Expected: FAIL, module not found.

**Step 3: Implement `src/adapters/git.ts`**

```ts
import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { Workspace } from '../core/types.js';

const execFileP = promisify(execFile);

/** Runs git in cwd; resolves trimmed stdout, or null on any failure. */
export type GitRunner = (cwd: string, args: string[]) => Promise<string | null>;

export const runGit: GitRunner = async (cwd, args) => {
  try {
    const { stdout } = await execFileP('git', ['-C', cwd, ...args], { timeout: 3000 });
    return stdout.trim();
  } catch {
    return null;
  }
};

async function real(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return resolve(p);
  }
}

export async function resolveWorkspace(cwd: string, run: GitRunner = runGit): Promise<Workspace> {
  const out = await run(cwd, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir']);
  if (!out) return { cwd, repoRoot: null, repoName: basename(cwd) || cwd, worktree: false, branch: null };
  const [toplevel = cwd, common = ''] = out.split('\n');
  const commonDir = await real(common || resolve(toplevel, '.git'));
  const mainRoot = basename(commonDir) === '.git' ? dirname(commonDir) : commonDir;
  const branch = await run(cwd, ['symbolic-ref', '--short', '-q', 'HEAD']);
  return {
    cwd,
    repoRoot: mainRoot,
    repoName: basename(mainRoot),
    worktree: (await real(toplevel)) !== mainRoot,
    branch: branch || 'HEAD',
  };
}

export type WorkspaceResolver = (cwd: string) => Promise<Workspace>;

export function createGitResolver(ttlMs = 30_000, run: GitRunner = runGit, now: () => number = Date.now): WorkspaceResolver {
  const cache = new Map<string, { at: number; ws: Promise<Workspace> }>();
  return (cwd) => {
    const hit = cache.get(cwd);
    if (hit && now() - hit.at < ttlMs) return hit.ws;
    const ws = resolveWorkspace(cwd, run);
    cache.set(cwd, { at: now(), ws });
    return ws;
  };
}
```

**Step 4: Run the tests**

Run: `npx vitest run test/adapters/git.test.ts && npm run typecheck`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/adapters/git.ts test/adapters/git.test.ts
git commit -m "Resolve repository, worktree and branch for a working directory"
```

---

### Task 12: Filesystem adapter

Polls `~/.claude` once a second. For each live session: announce it, backfill its transcript (head for the first prompt, tail for the current state), then follow new lines, report status changes from the session file, and notice subagents. Emits `session.ended` when a session's process is gone.

**Files:**
- Create: `src/adapters/claude-code/fs-adapter.ts`, `test/adapters/fs-adapter.test.ts`

**Step 1: Write the failing test**

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeProjectDir, FsAdapter, type FsAdapterOptions } from '../../src/adapters/claude-code/fs-adapter.js';
import type { RawEvent } from '../../src/core/types.js';

const T0 = Date.parse('2026-10-10T10:00:00.000Z');
const CWD = '/w/shop/orders-api';
const SESSION = { pid: 4242, sessionId: 'S1', cwd: CWD, startedAt: T0, status: 'busy', statusUpdatedAt: T0 + 5000, tmux: 'x:@1.%7', name: 'orders-api-a1', kind: 'interactive' };
const LINES = [
  { type: 'user', timestamp: '2026-10-10T10:00:10.000Z', cwd: CWD, gitBranch: 'feat/checkout-v2', sessionId: 'S1', message: { role: 'user', content: 'Add idempotency keys' } },
  { type: 'ai-title', aiTitle: 'Idempotency keys for orders', sessionId: 'S1' },
  { type: 'assistant', timestamp: '2026-10-10T10:00:20.000Z', cwd: CWD, gitBranch: 'feat/checkout-v2', sessionId: 'S1', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }] } },
];

let root: string;
let events: RawEvent[];
let now: number;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'shq-fs-'));
  await mkdir(join(root, 'sessions'), { recursive: true });
  events = [];
  now = T0 + 60_000;
});

function adapter(overrides: Partial<FsAdapterOptions> = {}) {
  return new FsAdapter({
    claudeDir: root,
    emit: (e) => events.push(e),
    resolveWorkspace: async (cwd) => ({ cwd, repoRoot: cwd, repoName: 'orders-api', worktree: false, branch: 'feat/checkout-v2' }),
    probe: async (pids) => new Map(pids.map((p) => [p, T0 - 1000])),
    now: () => now,
    subagentScanMs: 0,
    transcriptRetryMs: 0,
    ...overrides,
  });
}
const writeSession = (data: object) => writeFile(join(root, 'sessions', '4242.json'), JSON.stringify(data));
async function writeTranscript(dirName: string, entries: object[]) {
  const dir = join(root, 'projects', dirName);
  await mkdir(dir, { recursive: true });
  const path = join(dir, 'S1.jsonl');
  await writeFile(path, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return path;
}

describe('FsAdapter', () => {
  it('encodes project directories like Claude Code', () => {
    expect(encodeProjectDir('/Users/me/Projects/fairmind.ai')).toBe('-Users-me-Projects-fairmind-ai');
  });

  it('discovers a live session and backfills its transcript', async () => {
    await writeSession(SESSION);
    const path = await writeTranscript(encodeProjectDir(CWD), LINES);
    await adapter().poll();
    expect(events.map((e) => e.type)).toEqual(['session.seen', 'prompt', 'branch', 'title', 'tool.started', 'session.status']);
    expect(events[0]).toMatchObject({ sessionId: 'S1', source: 'fs', pid: 4242, name: 'orders-api-a1', tmuxPane: '%7', transcriptPath: path, startedAt: T0, workspace: { cwd: CWD } });
    expect(events[4]).toMatchObject({ label: 'Bash: npm test', cwd: CWD });
    expect(events[5]).toMatchObject({ status: 'busy', ts: T0 + 5000 });
  });

  it('follows new lines and status changes without repeating old events', async () => {
    await writeSession(SESSION);
    const path = await writeTranscript(encodeProjectDir(CWD), LINES);
    const a = adapter();
    await a.poll();
    events.length = 0;
    await appendFile(path, JSON.stringify({ type: 'user', timestamp: '2026-10-10T10:00:30.000Z', cwd: CWD, gitBranch: 'feat/checkout-v2', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }) + '\n');
    await writeSession({ ...SESSION, status: 'idle', statusUpdatedAt: T0 + 40_000 });
    await a.poll();
    expect(events.map((e) => e.type)).toEqual(['session.status', 'tool.finished']);
    expect(events[0]).toMatchObject({ status: 'idle', ts: T0 + 40_000 });
  });

  it('ends a session once when its file goes away', async () => {
    await writeSession(SESSION);
    const a = adapter();
    await a.poll();
    events.length = 0;
    await rm(join(root, 'sessions', '4242.json'));
    await a.poll();
    await a.poll();
    expect(events).toEqual([{ type: 'session.ended', sessionId: 'S1', ts: now, source: 'fs', cwd: CWD, reason: 'process-gone' }]);
  });

  it('ignores a file whose pid now belongs to a newer process', async () => {
    await writeSession(SESSION);
    await adapter({ probe: async (pids) => new Map(pids.map((p) => [p, T0 + 10 * 60_000])) }).poll();
    expect(events).toEqual([]);
  });

  it('finds a transcript stored under a differently encoded directory', async () => {
    await writeSession(SESSION);
    const path = await writeTranscript('-w-shop-orders api (legacy)', LINES);
    await adapter().poll();
    expect(events[0]).toMatchObject({ type: 'session.seen', transcriptPath: path });
  });

  it('picks up a transcript that appears after the session', async () => {
    await writeSession(SESSION);
    const a = adapter();
    await a.poll();
    expect(events[0]).toMatchObject({ type: 'session.seen', transcriptPath: null });
    events.length = 0;
    const path = await writeTranscript(encodeProjectDir(CWD), LINES);
    await a.poll();
    expect(events.map((e) => e.type)).toEqual(['session.seen', 'prompt', 'branch', 'title', 'tool.started']);
    expect(events[0]).toMatchObject({ transcriptPath: path });
  });

  it('reports subagents that start and go quiet', async () => {
    await writeSession(SESSION);
    await writeTranscript(encodeProjectDir(CWD), LINES);
    const subDir = join(root, 'projects', encodeProjectDir(CWD), 'S1', 'subagents');
    await mkdir(subDir, { recursive: true });
    const agentFile = join(subDir, 'agent-a1.jsonl');
    await writeFile(agentFile, '{}\n');
    await writeFile(join(subDir, 'agent-a1.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'Find callers' }));
    await utimes(agentFile, now / 1000, now / 1000);
    const a = adapter();
    await a.poll();
    expect(events.find((e) => e.type === 'agent.started')).toMatchObject({ agentId: 'a1', agentType: 'Explore', description: 'Find callers' });
    events.length = 0;
    now += 120_000;
    await a.poll();
    expect(events.filter((e) => e.type.startsWith('agent.'))).toEqual([
      expect.objectContaining({ type: 'agent.finished', agentId: 'a1' }),
    ]);
  });
});
```

**Step 2: Run it to see it fail**

Run: `npx vitest run test/adapters/fs-adapter.test.ts`
Expected: FAIL, module not found.

**Step 3: Implement `src/adapters/claude-code/fs-adapter.ts`**

```ts
import { access, readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { RawEvent } from '../../core/types.js';
import type { WorkspaceResolver } from '../git.js';
import { readHeadLines, readNewLines, readTailLines, type TailState } from './jsonl.js';
import { isSameProcess, psProbe, readSessionsDir, type LiveSessionFile, type ProcessProbe } from './sessions-dir.js';
import { parseTranscriptLine } from './transcript.js';

export interface FsAdapterOptions {
  claudeDir: string;
  emit: (e: RawEvent) => void;
  resolveWorkspace: WorkspaceResolver;
  probe?: ProcessProbe;
  now?: () => number;
  /** A subagent transcript written within this window counts as running. */
  childFreshMs?: number;
  headBytes?: number;
  tailBytes?: number;
  subagentScanMs?: number;
  transcriptRetryMs?: number;
}

interface Tracked {
  file: LiveSessionFile;
  transcript: string | null;
  tail: TailState | null;
  branch: string | null;
  statusAt: number | null;
  children: Map<string, boolean>;
  metas: Map<string, { type: string; description: string | null }>;
  lastSubagentScan: number;
  lastTranscriptLookup: number;
  ended: boolean;
}

/** Claude Code names a project directory after its cwd with every non-alphanumeric character replaced by '-'. Older versions differ, so lookups fall back to a scan. */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export class FsAdapter {
  private readonly tracked = new Map<string, Tracked>();
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private readonly now: () => number;
  private readonly probe: ProcessProbe;

  constructor(private readonly o: FsAdapterOptions) {
    this.now = o.now ?? Date.now;
    this.probe = o.probe ?? psProbe;
  }

  start(intervalMs = 1000): void {
    if (this.timer) return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One scan. Overlapping calls are skipped. Never throws. */
  async poll(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.scan();
    } catch {
      // keep polling; a bad scan must not stop the adapter
    } finally {
      this.busy = false;
    }
  }

  private async scan(): Promise<void> {
    const now = this.now();
    const files = await readSessionsDir(join(this.o.claudeDir, 'sessions'));
    const starts = await this.probe(files.map((f) => f.pid), now);
    const live = new Set<string>();

    for (const f of files) {
      if (!isSameProcess(f, starts.get(f.pid)) || live.has(f.sessionId)) continue;
      live.add(f.sessionId);
      let t = this.tracked.get(f.sessionId);
      if (!t || t.ended) {
        t = await this.discover(f, now);
        this.tracked.set(f.sessionId, t);
      }
      t.file = f;
      if (f.status && f.statusUpdatedAt !== null && f.statusUpdatedAt !== t.statusAt) {
        t.statusAt = f.statusUpdatedAt;
        this.o.emit({ type: 'session.status', sessionId: f.sessionId, ts: f.statusUpdatedAt, source: 'fs', cwd: f.cwd, status: f.status, waitingFor: f.waitingFor });
      }
      await this.follow(t, now);
      await this.scanSubagents(t, now);
    }

    for (const [id, t] of this.tracked) {
      if (t.ended || live.has(id)) continue;
      t.ended = true;
      this.o.emit({ type: 'session.ended', sessionId: id, ts: now, source: 'fs', cwd: t.file.cwd, reason: 'process-gone' });
    }
  }

  private async announce(f: LiveSessionFile, transcript: string | null, now: number): Promise<void> {
    const workspace = await this.o.resolveWorkspace(f.cwd);
    this.o.emit({
      type: 'session.seen',
      sessionId: f.sessionId,
      ts: f.startedAt || now,
      source: 'fs',
      cwd: f.cwd,
      workspace,
      pid: f.pid,
      name: f.name,
      tmuxPane: f.tmuxPane,
      transcriptPath: transcript,
      startedAt: f.startedAt || now,
    });
  }

  private async discover(f: LiveSessionFile, now: number): Promise<Tracked> {
    const transcript = await this.findTranscript(f.sessionId, f.cwd);
    const t: Tracked = {
      file: f,
      transcript,
      tail: null,
      branch: null,
      statusAt: null,
      children: new Map(),
      metas: new Map(),
      lastSubagentScan: 0,
      lastTranscriptLookup: now,
      ended: false,
    };
    await this.announce(f, transcript, now);
    if (transcript) await this.backfill(t, transcript);
    return t;
  }

  private async backfill(t: Tracked, path: string): Promise<void> {
    const headBytes = this.o.headBytes ?? 64 * 1024;
    const tailBytes = this.o.tailBytes ?? 512 * 1024;
    let size: number;
    try {
      size = (await stat(path)).size;
    } catch {
      return;
    }
    if (size > headBytes + tailBytes) {
      for (const line of await readHeadLines(path, headBytes)) this.handleLine(t, line);
      const { lines, offset } = await readTailLines(path, tailBytes);
      for (const line of lines) this.handleLine(t, line);
      t.tail = { path, offset, skipping: false };
    } else {
      t.tail = { path, offset: 0, skipping: false };
      await this.drain(t);
    }
  }

  private async follow(t: Tracked, now: number): Promise<void> {
    if (t.tail) {
      await this.drain(t);
      return;
    }
    if (now - t.lastTranscriptLookup < (this.o.transcriptRetryMs ?? 5000)) return;
    t.lastTranscriptLookup = now;
    const found = await this.findTranscript(t.file.sessionId, t.file.cwd);
    if (!found) return;
    t.transcript = found;
    await this.announce(t.file, found, now);
    await this.backfill(t, found);
  }

  private async drain(t: Tracked): Promise<void> {
    for (let i = 0; i < 8 && t.tail; i++) {
      const { lines, state } = await readNewLines(t.tail);
      t.tail = state;
      for (const line of lines) this.handleLine(t, line);
      if (lines.length === 0) break;
    }
  }

  private handleLine(t: Tracked, line: string): void {
    const parsed = parseTranscriptLine(line, t.file.sessionId, t.file.cwd);
    for (const e of parsed.events) this.o.emit({ ...e, cwd: t.file.cwd });
    if (parsed.branch && parsed.branch !== t.branch) {
      t.branch = parsed.branch;
      this.o.emit({ type: 'branch', sessionId: t.file.sessionId, ts: parsed.ts ?? this.now(), source: 'fs', cwd: t.file.cwd, branch: parsed.branch });
    }
  }

  private async findTranscript(sessionId: string, cwd: string): Promise<string | null> {
    const projects = join(this.o.claudeDir, 'projects');
    const direct = join(projects, encodeProjectDir(cwd), `${sessionId}.jsonl`);
    if (await exists(direct)) return direct;
    let dirs: string[];
    try {
      dirs = await readdir(projects);
    } catch {
      return null;
    }
    for (const d of dirs) {
      const candidate = join(projects, d, `${sessionId}.jsonl`);
      if (await exists(candidate)) return candidate;
    }
    return null;
  }

  private async scanSubagents(t: Tracked, now: number): Promise<void> {
    if (!t.transcript || now - t.lastSubagentScan < (this.o.subagentScanMs ?? 3000)) return;
    t.lastSubagentScan = now;
    const dir = join(dirname(t.transcript), basename(t.transcript, '.jsonl'), 'subagents');
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    const freshMs = this.o.childFreshMs ?? 90_000;
    for (const name of names) {
      const m = name.match(/^agent-(.+)\.jsonl$/);
      if (!m) continue;
      const id = m[1]!;
      let mtime: number;
      try {
        mtime = (await stat(join(dir, name))).mtimeMs;
      } catch {
        continue;
      }
      const running = now - mtime < freshMs;
      const was = t.children.get(id) ?? false;
      if (running && !was) {
        const meta = await this.readMeta(t, dir, id);
        this.o.emit({ type: 'agent.started', sessionId: t.file.sessionId, ts: mtime, source: 'fs', cwd: t.file.cwd, agentId: id, agentType: meta.type, description: meta.description });
      } else if (!running && was) {
        this.o.emit({ type: 'agent.finished', sessionId: t.file.sessionId, ts: mtime, source: 'fs', cwd: t.file.cwd, agentId: id });
      }
      t.children.set(id, running);
    }
  }

  private async readMeta(t: Tracked, dir: string, id: string): Promise<{ type: string; description: string | null }> {
    const cached = t.metas.get(id);
    if (cached) return cached;
    let meta = { type: 'agent', description: null as string | null };
    try {
      const d = JSON.parse(await readFile(join(dir, `agent-${id}.meta.json`), 'utf8')) as Record<string, unknown>;
      meta = {
        type: typeof d.agentType === 'string' && d.agentType ? d.agentType : 'agent',
        description: typeof d.description === 'string' && d.description ? d.description : null,
      };
    } catch {
      // no meta file: keep the defaults
    }
    t.metas.set(id, meta);
    return meta;
  }
}
```

**Step 4: Run the tests**

Run: `npx vitest run test/adapters/fs-adapter.test.ts && npm run typecheck`
Expected: PASS. Note the event order in the first test: `session.seen`, then the backfilled transcript events in file order (`branch` follows the first line that names it), then the status from the session file.

**Step 5: Commit**

```bash
git add src/adapters/claude-code/fs-adapter.ts test/adapters/fs-adapter.test.ts
git commit -m "Watch Claude Code's session files, transcripts and subagents"
```

---

### Task 13: Payload mapper

Pure: one hook-shaped payload in (as the mod sends it, see Task 2), events out. The mapper also understands a few payload names the mod does not send today (`SessionStart`, `Notification`, `SubagentStop`), so another sender can use them. It is tolerant of what it does not control: a missing timestamp, an unknown event, an odd `background_tasks`.

**Files:**
- Create: `src/adapters/claude-code/hooks.ts`, `test/adapters/hooks.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { countBackgroundTasks, HOOK_EVENTS, mapHookPayload } from '../../src/adapters/claude-code/hooks.js';

const fx = (name: string): unknown => JSON.parse(readFileSync(new URL(`../fixtures/hooks/${name}.json`, import.meta.url), 'utf8'));
const NOW = 1_800_000_000_000;
const SID = '11111111-1111-4111-8111-111111111111';
const CWD = '/home/dev/shop/orders-api';
const base = (ts: number) => ({ sessionId: SID, ts, source: 'hook', cwd: CWD });

describe('HOOK_EVENTS', () => {
  it('lists the payload names the mapper understands', () => {
    expect(HOOK_EVENTS).toEqual(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'Notification', 'Stop', 'SubagentStart', 'SubagentStop', 'SessionEnd']);
  });
});

describe('mapHookPayload with the mod fixtures', () => {
  it('UserPromptSubmit becomes a prompt, timed by the mod', () => {
    expect(mapHookPayload(fx('UserPromptSubmit'), NOW)).toEqual([{ ...base(1791660000000), type: 'prompt', text: 'Run ls with the Bash tool, then reply with the single word ok.' }]);
  });

  it('PreToolUse and PostToolUse track a main-thread tool', () => {
    expect(mapHookPayload(fx('PreToolUse'), NOW)).toEqual([{ ...base(1791660001000), type: 'tool.started', toolId: 'toolu_01ABCDEFGHIJKLMNOPQRSTUV', tool: 'Bash', label: 'Bash: ls', agentId: null }]);
    expect(mapHookPayload(fx('PostToolUse'), NOW)).toEqual([{ ...base(1791660002000), type: 'tool.finished', toolId: 'toolu_01ABCDEFGHIJKLMNOPQRSTUV', ok: true, agentId: null }]);
    expect(mapHookPayload(fx('PostToolUseFailure'), NOW)).toEqual([{ ...base(1791660002500), type: 'tool.finished', toolId: 'toolu_02ABCDEFGHIJKLMNOPQRSTUV', ok: false, agentId: null }]);
  });

  it('tool events inside a subagent carry its id', () => {
    expect(mapHookPayload(fx('PreToolUse.subagent'), NOW)).toEqual([{ ...base(1791660002700), type: 'tool.started', toolId: 'toolu_03ABCDEFGHIJKLMNOPQRSTUV', tool: 'Grep', label: 'Grep useCart', agentId: 'a58cb74ebedcc3070' }]);
  });

  it('AskUserQuestion waits for an answer', () => {
    expect(mapHookPayload(fx('PreToolUse.AskUserQuestion'), NOW)).toEqual([{ ...base(1791660002800), type: 'waiting', reason: { kind: 'question', text: 'Should the retry queue use Redis or Postgres?' } }]);
  });

  it('PermissionRequest waits with the command as detail', () => {
    expect(mapHookPayload(fx('PermissionRequest'), NOW)).toEqual([{ ...base(1791660003000), type: 'waiting', reason: { kind: 'permission', text: 'Bash', detail: 'Bash: rm -rf dist && npm run build' } }]);
  });

  it('SubagentStart, Stop and SessionEnd', () => {
    expect(mapHookPayload(fx('SubagentStart'), NOW)).toEqual([{ ...base(1791660004000), type: 'agent.started', agentId: 'a58cb74ebedcc3070', agentType: 'Explore', description: null }]);
    expect(mapHookPayload(fx('Stop'), NOW)).toEqual([{ ...base(1791660005000), type: 'turn.finished', backgroundTasks: 0 }]);
    expect(mapHookPayload(fx('SessionEnd'), NOW)).toEqual([{ ...base(1791660006000), type: 'session.ended', reason: 'other' }]);
  });

  it('maps a whole batch, item by item, in order', () => {
    const batch = fx('batch') as unknown[];
    expect(batch.flatMap((p) => mapHookPayload(p, NOW)).map((e) => e.type)).toEqual(['prompt', 'tool.started', 'tool.finished', 'turn.finished']);
  });
});

describe('mapHookPayload edge cases', () => {
  const p = { session_id: 'S1', cwd: '/w/shop' };

  it('falls back to arrival time without a timestamp from the sender', () => {
    expect(mapHookPayload({ ...p, hook_event_name: 'Stop' }, NOW)[0]).toMatchObject({ ts: NOW });
  });

  it('understands the names the mod does not send today', () => {
    expect(mapHookPayload({ ...p, hook_event_name: 'SessionStart', source: 'startup' }, NOW)).toEqual([expect.objectContaining({ type: 'session.started' })]);
    expect(mapHookPayload({ ...p, hook_event_name: 'SessionStart', source: 'compact' }, NOW)).toEqual([]);
    expect(mapHookPayload({ ...p, hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' }, NOW))
      .toEqual([expect.objectContaining({ type: 'waiting', reason: { kind: 'permission', text: 'Claude needs your permission to use Bash' } })]);
    expect(mapHookPayload({ ...p, hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'Claude is waiting for your input' }, NOW)).toEqual([]);
    expect(mapHookPayload({ ...p, hook_event_name: 'SubagentStop', agent_id: 'a1' }, NOW)).toEqual([expect.objectContaining({ type: 'agent.finished', agentId: 'a1' })]);
  });

  it('ignores subagent-only lifecycle events and unknown events', () => {
    expect(mapHookPayload({ ...p, hook_event_name: 'Stop', agent_id: 'a1' }, NOW)).toEqual([]);
    expect(mapHookPayload({ ...p, hook_event_name: 'SessionEnd', agent_id: 'a1' }, NOW)).toEqual([]);
    expect(mapHookPayload({ ...p, hook_event_name: 'SubagentStart' }, NOW)).toEqual([]);
    expect(mapHookPayload({ ...p, hook_event_name: 'PreCompact' }, NOW)).toEqual([]);
  });

  it('a permission request inside a subagent still needs the user', () => {
    expect(mapHookPayload({ ...p, hook_event_name: 'PermissionRequest', agent_id: 'a1', tool_name: 'Write', tool_input: { file_path: '/w/shop/a.ts' } }, NOW))
      .toEqual([expect.objectContaining({ type: 'waiting', reason: { kind: 'permission', text: 'Write', detail: 'Write a.ts' } })]);
  });

  it('rejects payloads without a session or event name', () => {
    expect(mapHookPayload(null, NOW)).toEqual([]);
    expect(mapHookPayload('x', NOW)).toEqual([]);
    expect(mapHookPayload([], NOW)).toEqual([]);
    expect(mapHookPayload({ hook_event_name: 'Stop' }, NOW)).toEqual([]);
    expect(mapHookPayload({ session_id: 'S1' }, NOW)).toEqual([]);
  });
});

describe('countBackgroundTasks', () => {
  it('accepts a count, an array or an object', () => {
    expect(countBackgroundTasks(3)).toBe(3);
    expect(countBackgroundTasks([{}, {}])).toBe(2);
    expect(countBackgroundTasks({ a: 1 })).toBe(1);
    expect(countBackgroundTasks(-1)).toBe(0);
    expect(countBackgroundTasks('x')).toBe(0);
    expect(countBackgroundTasks(undefined)).toBe(0);
  });
});
```

**Step 2: Run it to see it fail**

Run: `npx vitest run test/adapters/hooks.test.ts`
Expected: FAIL, module not found.

**Step 3: Implement `src/adapters/claude-code/hooks.ts`**

```ts
import { toolLabel, truncate, waitingFromTool } from '../../core/tool-label.js';
import type { RawEvent } from '../../core/types.js';
import { promptText } from './transcript.js';

/** The payload names the mapper understands. The mod sends a subset (see test/mod-contract.test.ts). */
export const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Notification',
  'Stop',
  'SubagentStart',
  'SubagentStop',
  'SessionEnd',
] as const;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** background_tasks is not documented in detail: accept a count, an array or an object. */
export function countBackgroundTasks(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.max(0, Math.floor(v));
  if (Array.isArray(v)) return v.length;
  if (v && typeof v === 'object') return Object.keys(v).length;
  return 0;
}

const QUESTION_NOTIFICATIONS = new Set(['elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input']);

export function mapHookPayload(payload: unknown, receivedAt: number): RawEvent[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  const p = payload as Record<string, unknown>;
  const sessionId = str(p.session_id);
  const name = str(p.hook_event_name);
  if (!sessionId || !name) return [];

  const ts = typeof p._scranton_ts === 'number' && Number.isFinite(p._scranton_ts) ? p._scranton_ts : receivedAt;
  const cwd = str(p.cwd);
  const agentId = str(p.agent_id) || null;
  const toolName = str(p.tool_name);
  const toolId = str(p.tool_use_id) || null;
  const base = { sessionId, ts, source: 'hook' as const, ...(cwd ? { cwd } : {}) };

  switch (name) {
    case 'SessionStart':
      return agentId || p.source === 'compact' ? [] : [{ ...base, type: 'session.started' }];
    case 'UserPromptSubmit':
      return [{ ...base, type: 'prompt', text: promptText(p.prompt) }];
    case 'PreToolUse': {
      if (!toolName) return [];
      const wait = agentId ? null : waitingFromTool(toolName, p.tool_input);
      if (wait) return [{ ...base, type: 'waiting', reason: wait }];
      return [{ ...base, type: 'tool.started', toolId, tool: toolName, label: toolLabel(toolName, p.tool_input, cwd || undefined), agentId }];
    }
    case 'PostToolUse':
    case 'PostToolUseFailure':
      return [{ ...base, type: 'tool.finished', toolId, ok: name === 'PostToolUse', agentId }];
    case 'PermissionRequest':
      return [{
        ...base,
        type: 'waiting',
        reason: { kind: 'permission', text: toolName || 'Permission', ...(toolName ? { detail: toolLabel(toolName, p.tool_input, cwd || undefined) } : {}) },
      }];
    case 'Notification': {
      const type = str(p.notification_type);
      const message = str(p.message);
      if (type === 'permission_prompt') return [{ ...base, type: 'waiting', reason: { kind: 'permission', text: truncate(message || 'Permission needed', 120) } }];
      if (QUESTION_NOTIFICATIONS.has(type)) return [{ ...base, type: 'waiting', reason: { kind: 'question', text: truncate(message || 'Input needed', 120) } }];
      return [];
    }
    case 'Stop':
      return agentId ? [] : [{ ...base, type: 'turn.finished', backgroundTasks: countBackgroundTasks(p.background_tasks) }];
    case 'SubagentStart':
      return agentId ? [{ ...base, type: 'agent.started', agentId, agentType: str(p.agent_type) || 'agent', description: null }] : [];
    case 'SubagentStop':
      return agentId ? [{ ...base, type: 'agent.finished', agentId }] : [];
    case 'SessionEnd':
      return agentId ? [] : [{ ...base, type: 'session.ended', reason: str(p.reason) || 'other' }];
    default:
      return [];
  }
}
```

**Step 4: Run the tests**

Run: `npx vitest run test/adapters/hooks.test.ts && npm run typecheck`
Expected: PASS. If a fixture test fails, fix the implementation, not the fixture: the fixtures are what the mod sends.

**Step 5: Commit**

```bash
git add src/adapters/claude-code/hooks.ts test/adapters/hooks.test.ts
git commit -m "Map the payloads the mod sends to events"
```

---

# Part C: daemon, CLI and mod

### Task 14: Store

Persists sessions (so a restart keeps "seen" marks and states) and an event log (pruned after 7 days; the M4 archive builds on it). `node:sqlite` is loaded inside `Store.open`, so modules that only import the type stay free of it.

**Files:**
- Create: `src/store/store.ts`, `test/store.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newSession } from '../src/core/reducer.js';
import { Store } from '../src/store/store.js';
import { ev, WS } from './helpers/events.js';

describe('Store', () => {
  it('saves, updates and loads sessions', async () => {
    const store = await Store.open(':memory:');
    const s = newSession('S1', 1000, WS);
    store.saveSessions([s], 5);
    expect(store.loadSessions()).toEqual([s]);
    store.saveSessions([{ ...s, title: 'Fix checkout' }], 6);
    expect(store.loadSessions()).toEqual([{ ...s, title: 'Fix checkout' }]);
    store.close();
  });

  it('keeps an ordered event log and prunes old events', async () => {
    const store = await Store.open(':memory:');
    store.appendEvent(ev('prompt', 1, { text: 'a' }));
    store.appendEvent(ev('prompt', 2, { text: 'b' }));
    store.appendEvent(ev('prompt', 3, { text: 'c' }));
    expect(store.recentEvents('S1', 2).map((e) => e.ts)).toEqual([2, 3]);
    expect(store.prune(3)).toBe(2);
    expect(store.recentEvents('S1').map((e) => e.ts)).toEqual([3]);
    store.close();
  });

  it('persists to a file across reopen', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'shq-store-')), 'test.db');
    const a = await Store.open(path);
    a.saveSessions([newSession('S1', 1000, WS)], 5);
    a.close();
    const b = await Store.open(path);
    expect(b.loadSessions().map((s) => s.id)).toEqual(['S1']);
    b.close();
  });
});
```

**Step 2: Run it to see it fail**

Run: `npx vitest run test/store.test.ts`
Expected: FAIL, module not found.

**Step 3: Implement `src/store/store.ts`**

```ts
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { CollectorEvent, Session } from '../core/types.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  source TEXT NOT NULL,
  type TEXT NOT NULL,
  json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_session_ts ON events (session_id, ts);
`;

type JsonRow = { json: string };

export class Store {
  private readonly upsertSession: StatementSync;
  private readonly insertEvent: StatementSync;

  private constructor(private readonly db: DatabaseSync) {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(SCHEMA);
    this.upsertSession = db.prepare(
      'INSERT INTO sessions (id, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at',
    );
    this.insertEvent = db.prepare('INSERT INTO events (session_id, ts, seq, source, type, json) VALUES (?, ?, ?, ?, ?, ?)');
  }

  /** Opens or creates the database. Use ':memory:' for a throwaway store. */
  static async open(path: string): Promise<Store> {
    const { DatabaseSync } = await import('node:sqlite');
    return new Store(new DatabaseSync(path));
  }

  saveSessions(sessions: Session[], now: number): void {
    this.db.exec('BEGIN');
    try {
      for (const s of sessions) this.upsertSession.run(s.id, JSON.stringify(s), now);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  loadSessions(): Session[] {
    const rows = this.db.prepare('SELECT json FROM sessions ORDER BY id').all() as unknown as JsonRow[];
    const out: Session[] = [];
    for (const r of rows) {
      try {
        out.push(JSON.parse(r.json) as Session);
      } catch {
        // skip a corrupt row
      }
    }
    return out;
  }

  appendEvent(e: CollectorEvent): void {
    this.insertEvent.run(e.sessionId, e.ts, e.seq, e.source, e.type, JSON.stringify(e));
  }

  /** The latest `limit` events of a session, oldest first. */
  recentEvents(sessionId: string, limit = 50): CollectorEvent[] {
    const rows = this.db
      .prepare('SELECT json FROM events WHERE session_id = ? ORDER BY ts DESC, seq DESC LIMIT ?')
      .all(sessionId, limit) as unknown as JsonRow[];
    return rows.map((r) => JSON.parse(r.json) as CollectorEvent).reverse();
  }

  /** Deletes events older than `before`; returns how many. */
  prune(before: number): number {
    return Number(this.db.prepare('DELETE FROM events WHERE ts < ?').run(before).changes);
  }

  close(): void {
    this.db.close();
  }
}
```

**Step 4: Run the tests**

Run: `npx vitest run test/store.test.ts && npm run typecheck`
Expected: PASS. (Vitest may print one `ExperimentalWarning` for SQLite; that is expected in tests.)

**Step 5: Commit**

```bash
git add src/store/store.ts test/store.test.ts
git commit -m "Persist sessions and an event log in SQLite"
```

---

### Task 15: Collector

Owns the session map. Events go through a single promise queue, so they are applied in arrival order even when resolving a new session's git workspace takes time. Saves changed sessions to the store with a short debounce.

**Files:**
- Create: `src/collector.ts`, `test/collector.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from 'vitest';
import { basename } from 'node:path';
import type { WorkspaceResolver } from '../src/adapters/git.js';
import { Collector } from '../src/collector.js';
import type { RawEvent } from '../src/core/types.js';
import { Store } from '../src/store/store.js';

const resolver: WorkspaceResolver = async (cwd) => ({ cwd, repoRoot: cwd, repoName: basename(cwd), worktree: false, branch: 'main' });
const NOW = 1_000_000;
const hook = (e: Record<string, unknown>): RawEvent => ({ sessionId: 'S1', ts: NOW, source: 'hook', cwd: '/w/orders-api', ...e }) as RawEvent;

function collector(extra: Partial<ConstructorParameters<typeof Collector>[0]> = {}) {
  return new Collector({ resolveWorkspace: resolver, now: () => NOW + 1000, saveDelayMs: 0, ...extra });
}

describe('Collector', () => {
  it('creates an unknown session from an event that carries a cwd', async () => {
    const c = collector();
    await c.ingest(hook({ type: 'prompt', text: 'go' }));
    const snap = c.snapshot();
    expect(snap.floors.map((f) => [f.key, f.kind])).toEqual([['repo:orders-api', 'department']]);
    expect(snap.floors[0]!.sessions[0]).toMatchObject({ id: 'S1', effectiveState: 'working', lastPrompt: 'go' });
  });

  it('drops events for unknown sessions without a cwd', async () => {
    const c = collector();
    await c.ingest({ type: 'prompt', sessionId: 'X', ts: NOW, source: 'hook', text: 'x' });
    expect(c.dropped).toBe(1);
    expect(c.snapshot().floors).toEqual([]);
  });

  it('applies events in arrival order even when git is slow', async () => {
    const slow: WorkspaceResolver = (cwd) => new Promise((r) => setTimeout(() => r({ cwd, repoRoot: cwd, repoName: 'orders-api', worktree: false, branch: 'main' }), 20));
    const c = collector({ resolveWorkspace: slow });
    void c.ingest(hook({ type: 'tool.started', toolId: 't1', tool: 'Bash', label: 'Bash: ls', agentId: null }));
    void c.ingest(hook({ type: 'turn.finished', backgroundTasks: 0, ts: NOW }));
    await c.idle();
    expect(c.snapshot().attention.done.map((s) => s.id)).toEqual(['S1']);
  });

  it('ignores sources it was not asked to accept', async () => {
    const c = collector({ acceptSources: ['demo'] });
    await c.ingest(hook({ type: 'prompt', text: 'go' }));
    expect(c.snapshot().floors).toEqual([]);
  });

  it('marks finished sessions as seen', async () => {
    const c = collector();
    await c.ingest(hook({ type: 'prompt', text: 'go' }));
    expect(c.markSeen('S1')).toBe(false);
    await c.ingest(hook({ type: 'turn.finished', backgroundTasks: 0, ts: NOW + 1 }));
    expect(c.attentionSummary().done).toBe(1);
    expect(c.markSeen('S1')).toBe(true);
    expect(c.attentionSummary().done).toBe(0);
    expect(c.markSeen('S1')).toBe(false);
    expect(c.markSeen('nope')).toBe(false);
  });

  it('marks every finished session at once', async () => {
    const c = collector();
    await c.ingest(hook({ type: 'turn.finished', backgroundTasks: 0 }));
    await c.ingest(hook({ type: 'turn.finished', backgroundTasks: 0, sessionId: 'S2' }));
    expect(c.markAllSeen()).toBe(2);
  });

  it('summarises who needs attention', async () => {
    const c = collector();
    await c.ingest(hook({ type: 'waiting', reason: { kind: 'permission', text: 'Bash', detail: 'Bash: rm -rf dist' } }));
    expect(c.attentionSummary()).toEqual({
      generatedAt: NOW + 1000,
      needsYou: 1,
      done: 0,
      items: [{ id: 'S1', name: null, repo: 'orders-api', feature: null, state: 'needs_you', since: NOW, reason: { kind: 'permission', text: 'Bash', detail: 'Bash: rm -rf dist' }, title: null, tmuxPane: null }],
    });
  });

  it('notifies listeners until they unsubscribe', async () => {
    const c = collector();
    const fn = vi.fn();
    const off = c.onChange(fn);
    await c.ingest(hook({ type: 'prompt', text: 'go' }));
    expect(fn).toHaveBeenCalled();
    off();
    fn.mockClear();
    await c.ingest(hook({ type: 'prompt', text: 'again', ts: NOW + 5 }));
    expect(fn).not.toHaveBeenCalled();
  });

  it('restores sessions from the store and keeps ordering after a restart', async () => {
    const store = await Store.open(':memory:');
    const a = collector({ store });
    await a.ingest(hook({ type: 'prompt', text: 'go' }));
    await a.close();
    const b = collector({ store });
    expect(b.snapshot().floors[0]!.sessions[0]).toMatchObject({ id: 'S1', effectiveState: 'working' });
    await b.ingest(hook({ type: 'turn.finished', backgroundTasks: 0, ts: NOW }));
    expect(b.attentionSummary().done).toBe(1);
    store.close();
  });
});
```

**Step 2: Run it to see it fail**

Run: `npx vitest run test/collector.test.ts`
Expected: FAIL, module not found.

**Step 3: Implement `src/collector.ts`**

```ts
import type { WorkspaceResolver } from './adapters/git.js';
import { DEFAULT_THRESHOLDS, type Thresholds } from './config.js';
import { DEFAULT_FEATURE_RULES, type FeatureRules } from './core/feature.js';
import { applyEvent, markSeen } from './core/reducer.js';
import type { CollectorEvent, EventSourceKind, RawEvent, Session, WaitReason } from './core/types.js';
import { buildAttention, buildFloors, toView, type Attention, type Floor, type SessionView } from './core/view.js';
import type { Store } from './store/store.js';

export interface Snapshot {
  generatedAt: number;
  floors: Floor[];
  attention: Attention;
}

export interface AttentionItem {
  id: string;
  name: string | null;
  repo: string;
  feature: string | null;
  state: 'needs_you' | 'done';
  since: number;
  reason: WaitReason | null;
  title: string | null;
  tmuxPane: string | null;
}

export interface AttentionSummary {
  generatedAt: number;
  needsYou: number;
  done: number;
  items: AttentionItem[];
}

export interface CollectorOptions {
  resolveWorkspace: WorkspaceResolver;
  store?: Store | null;
  now?: () => number;
  thresholds?: Thresholds;
  featureRules?: FeatureRules;
  /** When set, events from other sources are ignored. */
  acceptSources?: EventSourceKind[];
  saveDelayMs?: number;
}

export class Collector {
  private readonly sessions = new Map<string, Session>();
  private readonly listeners = new Set<() => void>();
  private readonly dirty = new Set<string>();
  private readonly now: () => number;
  private seq = 0;
  private queue: Promise<void> = Promise.resolve();
  private saveTimer: NodeJS.Timeout | null = null;
  dropped = 0;

  constructor(private readonly o: CollectorOptions) {
    this.now = o.now ?? Date.now;
    for (const s of o.store?.loadSessions() ?? []) {
      this.sessions.set(s.id, s);
      this.seq = Math.max(this.seq, s.lastSeq + 1);
    }
  }

  ingest(raw: RawEvent): Promise<void> {
    if (this.o.acceptSources && !this.o.acceptSources.includes(raw.source)) return this.queue;
    const e = { ...raw, seq: this.seq++ } as CollectorEvent;
    this.queue = this.queue.then(() => this.apply(e)).catch(() => {
      this.dropped++;
    });
    return this.queue;
  }

  /** Resolves when every event ingested so far has been applied. */
  idle(): Promise<void> {
    return this.queue;
  }

  private async apply(e: CollectorEvent): Promise<void> {
    let prev = this.sessions.get(e.sessionId);
    let created = false;
    if (!prev && e.type !== 'session.seen') {
      if (!e.cwd) {
        this.dropped++;
        return;
      }
      const workspace = await this.o.resolveWorkspace(e.cwd);
      prev = applyEvent(undefined, { type: 'session.seen', sessionId: e.sessionId, ts: e.ts, seq: e.seq, source: e.source, cwd: e.cwd, workspace, startedAt: e.ts });
      created = true;
    }
    const next = applyEvent(prev, e);
    if (!next) {
      this.dropped++;
      return;
    }
    this.o.store?.appendEvent(e);
    if (created || next !== prev) {
      this.sessions.set(next.id, next);
      this.changed(next.id);
    }
  }

  private changed(id: string): void {
    this.dirty.add(id);
    if (!this.saveTimer) this.saveTimer = setTimeout(() => this.flush(), this.o.saveDelayMs ?? 500);
    for (const fn of this.listeners) fn();
  }

  /** Writes changed sessions to the store now. */
  flush(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const list = [...this.dirty].map((id) => this.sessions.get(id)).filter((s): s is Session => s !== undefined);
    this.dirty.clear();
    if (list.length) this.o.store?.saveSessions(list, this.now());
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  views(): SessionView[] {
    const now = this.now();
    const t = this.o.thresholds ?? DEFAULT_THRESHOLDS;
    const rules = this.o.featureRules ?? DEFAULT_FEATURE_RULES;
    return [...this.sessions.values()].map((s) => toView(s, now, t, rules));
  }

  snapshot(): Snapshot {
    const views = this.views();
    return { generatedAt: this.now(), floors: buildFloors(views), attention: buildAttention(views) };
  }

  attentionSummary(): AttentionSummary {
    const a = buildAttention(this.views());
    const item = (v: SessionView, state: 'needs_you' | 'done'): AttentionItem => ({
      id: v.id,
      name: v.name,
      repo: v.workspace.repoName,
      feature: v.feature,
      state,
      since: v.effectiveSince,
      reason: v.waitReason,
      title: v.title ?? v.lastPrompt ?? v.firstPrompt,
      tmuxPane: v.tmuxPane,
    });
    return {
      generatedAt: this.now(),
      needsYou: a.needsYou.length,
      done: a.done.length,
      items: [...a.needsYou.map((v) => item(v, 'needs_you')), ...a.done.map((v) => item(v, 'done'))],
    };
  }

  /** Marks a finished session as seen. False when the session is unknown or not 'done'. */
  markSeen(id: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    const view = toView(s, this.now(), this.o.thresholds ?? DEFAULT_THRESHOLDS, this.o.featureRules ?? DEFAULT_FEATURE_RULES);
    if (view.effectiveState !== 'done') return false;
    this.sessions.set(id, markSeen(s, this.now()));
    this.changed(id);
    return true;
  }

  markAllSeen(): number {
    let n = 0;
    for (const id of [...this.sessions.keys()]) if (this.markSeen(id)) n++;
    return n;
  }

  async close(): Promise<void> {
    await this.queue;
    this.flush();
  }
}
```

**Step 4: Run the tests**

Run: `npx vitest run test/collector.test.ts && npm run typecheck`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/collector.ts test/collector.test.ts
git commit -m "Collect events into sessions, floors and the attention queue"
```

---

### Task 16: HTTP API

Localhost only. Every request must pass three checks, in this order: `Host` is `127.0.0.1:<port>` or `localhost:<port>` (DNS rebinding), `Origin` is absent or the same host (cross-site requests from a browser), and `Authorization: Bearer <token>` matches (constant-time compare).

| Method | Path | Response |
|---|---|---|
| GET | `/api/health` | `{ ok: true, version }` |
| GET | `/api/building` | `Snapshot` |
| GET | `/api/attention` | `AttentionSummary` |
| POST | `/api/hooks` | 204; body is one payload or an array of them, as the mod sends them (max 1 MB) |
| POST | `/api/sessions/:id/seen` | 204, or 404 when there is no finished session with that id |
| POST | `/api/seen` | `{ marked: number }` |

**Files:**
- Create: `src/server/http.ts`, `test/server.test.ts`

**Step 1: Write the failing test**

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { basename } from 'node:path';
import { Collector } from '../src/collector.js';
import { createApiServer } from '../src/server/http.js';

const TOKEN = 'test-token-0123456789abcdef0123456789abcdef';
const permission = readFileSync(new URL('./fixtures/hooks/PermissionRequest.json', import.meta.url), 'utf8');
const SID = JSON.parse(permission).session_id as string;

let server: Server;
let port: number;
let collector: Collector;

beforeAll(async () => {
  collector = new Collector({ resolveWorkspace: async (cwd) => ({ cwd, repoRoot: cwd, repoName: basename(cwd), worktree: false, branch: 'main' }), saveDelayMs: 0 });
  server = createApiServer({ collector, token: TOKEN, maxBodyBytes: 4096 });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

function call(opts: { method?: string; path: string; token?: string | null; host?: string; origin?: string; body?: string }): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: opts.host ?? `127.0.0.1:${port}` };
    if (opts.token !== null) headers.authorization = `Bearer ${opts.token ?? TOKEN}`;
    if (opts.origin) headers.origin = opts.origin;
    if (opts.body !== undefined) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(Buffer.byteLength(opts.body));
    }
    const req = request({ host: '127.0.0.1', port, path: opts.path, method: opts.method ?? 'GET', headers }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, json: b ? JSON.parse(b) : null }));
    });
    req.on('error', reject);
    req.end(opts.body);
  });
}

describe('API security', () => {
  it('requires the token', async () => {
    expect((await call({ path: '/api/health', token: null })).status).toBe(401);
    expect((await call({ path: '/api/health', token: 'wrong' })).status).toBe(401);
  });
  it('rejects foreign Host and Origin headers', async () => {
    expect((await call({ path: '/api/health', host: `evil.example:${port}` })).status).toBe(403);
    expect((await call({ path: '/api/health', origin: 'https://evil.example' })).status).toBe(403);
    expect((await call({ path: '/api/health', host: `localhost:${port}`, origin: `http://localhost:${port}` })).status).toBe(200);
  });
});

describe('API routes', () => {
  it('reports health', async () => {
    const r = await call({ path: '/api/health' });
    expect(r).toEqual({ status: 200, json: { ok: true, version: '0.1.0' } });
  });

  it('accepts hook payloads and reflects them in attention', async () => {
    expect((await call({ method: 'POST', path: '/api/hooks', body: permission })).status).toBe(204);
    await collector.idle();
    const r = await call({ path: '/api/attention' });
    expect(r.json).toMatchObject({ needsYou: 1, done: 0, items: [{ id: SID, state: 'needs_you', reason: { kind: 'permission', text: 'Bash' } }] });
    const b = await call({ path: '/api/building' });
    expect(b.json.floors).toHaveLength(1);
  });

  it('rejects invalid and oversized bodies', async () => {
    expect((await call({ method: 'POST', path: '/api/hooks', body: '{oops' })).status).toBe(400);
    expect((await call({ method: 'POST', path: '/api/hooks', body: JSON.stringify({ x: 'y'.repeat(5000) }) })).status).toBe(413);
  });

  it('marks a finished session as seen', async () => {
    expect((await call({ method: 'POST', path: `/api/sessions/${SID}/seen` })).status).toBe(404);
    const stop = JSON.stringify({ hook_event_name: 'Stop', session_id: SID, cwd: '/home/dev/shop/orders-api', _scranton_ts: Date.now() + 1000 });
    expect((await call({ method: 'POST', path: '/api/hooks', body: stop })).status).toBe(204);
    await collector.idle();
    expect((await call({ path: '/api/attention' })).json.done).toBe(1);
    expect((await call({ method: 'POST', path: `/api/sessions/${encodeURIComponent(SID)}/seen` })).status).toBe(204);
    expect((await call({ path: '/api/attention' })).json.done).toBe(0);
    expect((await call({ method: 'POST', path: '/api/seen' })).json).toEqual({ marked: 0 });
  });

  it('accepts a batch of payloads, as the mod sends them', async () => {
    const batch = (JSON.parse(readFileSync(new URL('./fixtures/hooks/batch.json', import.meta.url), 'utf8')) as Record<string, unknown>[])
      .map((p) => ({ ...p, session_id: 'BATCH' }));
    expect((await call({ method: 'POST', path: '/api/hooks', body: JSON.stringify(batch) })).status).toBe(204);
    await collector.idle();
    const r = await call({ path: '/api/attention' });
    expect(r.json.items.map((i: { id: string }) => i.id)).toContain('BATCH');
  });

  it('answers 404 for unknown routes', async () => {
    expect((await call({ path: '/api/nope' })).status).toBe(404);
    expect((await call({ method: 'DELETE', path: '/api/health' })).status).toBe(404);
  });
});
```

**Step 2: Run it to see it fail**

Run: `npx vitest run test/server.test.ts`
Expected: FAIL, module not found.

**Step 3: Implement `src/server/http.ts`**

```ts
import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { mapHookPayload } from '../adapters/claude-code/hooks.js';
import type { Collector } from '../collector.js';

const VERSION = (createRequire(import.meta.url)('../../package.json') as { version: string }).version;

export interface ApiOptions {
  collector: Collector;
  token: string;
  maxBodyBytes?: number;
  now?: () => number;
}

export function createApiServer(o: ApiOptions): Server {
  return createServer((req, res) => {
    handle(o, req, res).catch(() => send(res, 500, { error: 'Internal error' }));
  });
}

function send(res: ServerResponse, status: number, body?: unknown): void {
  if (res.headersSent) return;
  if (body === undefined) {
    res.writeHead(status).end();
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(JSON.stringify(body));
}

export function allowedHost(host: string | undefined, port: number): boolean {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

export function allowedOrigin(origin: string | undefined, port: number): boolean {
  return origin === undefined || origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

function tokenMatches(header: string | undefined, token: string): boolean {
  if (!header || !header.startsWith('Bearer ')) return false;
  const given = Buffer.from(header.slice('Bearer '.length));
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Resolves the body as text, or null when it exceeds `limit` bytes. */
function readBody(req: IncomingMessage, limit: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (c: Buffer) => {
      if (over) return;
      size += c.length;
      if (size > limit) {
        over = true;
        chunks.length = 0;
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(over ? null : Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handle(o: ApiOptions, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const port = req.socket.localPort ?? 0;
  if (!allowedHost(req.headers.host, port)) return send(res, 403, { error: 'Host not allowed' });
  if (!allowedOrigin(req.headers.origin, port)) return send(res, 403, { error: 'Origin not allowed' });
  if (!tokenMatches(req.headers.authorization, o.token)) return send(res, 401, { error: 'Missing or wrong token' });

  const method = req.method ?? 'GET';
  const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;

  if (method === 'GET' && path === '/api/health') return send(res, 200, { ok: true, version: VERSION });
  if (method === 'GET' && path === '/api/building') return send(res, 200, o.collector.snapshot());
  if (method === 'GET' && path === '/api/attention') return send(res, 200, o.collector.attentionSummary());

  if (method === 'POST' && path === '/api/hooks') {
    const raw = await readBody(req, o.maxBodyBytes ?? 1_000_000);
    if (raw === null) return send(res, 413, { error: 'Payload too large' });
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      return send(res, 400, { error: 'Invalid JSON' });
    }
    const now = (o.now ?? Date.now)();
    const items = Array.isArray(payload) ? payload : [payload];
    for (const item of items) for (const e of mapHookPayload(item, now)) void o.collector.ingest(e);
    return send(res, 204);
  }

  if (method === 'POST' && path === '/api/seen') return send(res, 200, { marked: o.collector.markAllSeen() });

  const seen = path.match(/^\/api\/sessions\/([^/]+)\/seen$/);
  if (method === 'POST' && seen) {
    return o.collector.markSeen(decodeURIComponent(seen[1]!)) ? send(res, 204) : send(res, 404, { error: 'No finished session with that id' });
  }

  return send(res, 404, { error: 'Not found' });
}
```

**Step 4: Run the tests**

Run: `npx vitest run test/server.test.ts && npm run typecheck`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/server/http.ts test/server.test.ts
git commit -m "Serve a token-protected localhost API"
```

---

### Task 17: Daemon

Wires everything together and records how to reach it in `<dataDir>/daemon.json` (mode 600), which the Claude Code mod and the CLI read. The token lives in `<dataDir>/token` (mode 600) and survives restarts.

**Files:**
- Create: `src/daemon-file.ts`, `src/daemon.ts`, `test/daemon.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { mkdtemp, stat } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readDaemonFile } from '../src/daemon-file.js';
import { startDaemon } from '../src/daemon.js';

const tmp = (p: string) => mkdtemp(join(tmpdir(), p));
const quiet = () => {};

function health(port: number, token: string): Promise<number> {
  return new Promise((resolve, reject) => {
    request({ host: '127.0.0.1', port, path: '/api/health', headers: { authorization: `Bearer ${token}` } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    }).on('error', reject).end();
  });
}

describe('startDaemon', () => {
  it('writes a private daemon file, serves the API and cleans up on stop', async () => {
    const dataDir = await tmp('shq-data-');
    const d = await startDaemon({ port: 0, dataDir, claudeDir: await tmp('shq-claude-'), watchFiles: false, log: quiet });
    const info = await readDaemonFile(dataDir);
    expect(info).toMatchObject({ port: d.port, pid: process.pid });
    expect(info!.token).toMatch(/^[0-9a-f]{48}$/);
    expect((await stat(join(dataDir, 'daemon.json'))).mode & 0o077).toBe(0);
    expect((await stat(join(dataDir, 'token'))).mode & 0o077).toBe(0);
    expect(await health(d.port, info!.token)).toBe(200);
    await d.stop();
    expect(await readDaemonFile(dataDir)).toBeNull();
  });

  it('keeps the same token across restarts', async () => {
    const dataDir = await tmp('shq-data-');
    const claudeDir = await tmp('shq-claude-');
    const a = await startDaemon({ port: 0, dataDir, claudeDir, watchFiles: false, log: quiet });
    const first = (await readDaemonFile(dataDir))!.token;
    await a.stop();
    const b = await startDaemon({ port: 0, dataDir, claudeDir, watchFiles: false, log: quiet });
    expect((await readDaemonFile(dataDir))!.token).toBe(first);
    await b.stop();
  });

  it('fails clearly when the port is taken', async () => {
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r));
    const port = (blocker.address() as AddressInfo).port;
    await expect(startDaemon({ port, dataDir: await tmp('shq-data-'), claudeDir: await tmp('shq-claude-'), watchFiles: false, log: quiet }))
      .rejects.toMatchObject({ code: 'EADDRINUSE' });
    await new Promise<void>((r) => blocker.close(() => r()));
  });
});
```

**Step 2: Run it to see it fail**

Run: `npx vitest run test/daemon.test.ts`
Expected: FAIL, module not found.

**Step 3: Implement `src/daemon-file.ts`**

This module stays tiny: the CLI's `status` imports it on every tmux refresh.

```ts
import { chmod, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface DaemonFile {
  port: number;
  token: string;
  pid: number;
  startedAt: number;
}

export const daemonFilePath = (dataDir: string): string => join(dataDir, 'daemon.json');

export async function readDaemonFile(dataDir: string): Promise<DaemonFile | null> {
  try {
    const d = JSON.parse(await readFile(daemonFilePath(dataDir), 'utf8')) as Partial<DaemonFile>;
    if (typeof d.port === 'number' && typeof d.token === 'string') return d as DaemonFile;
  } catch {
    // missing or unreadable
  }
  return null;
}

export async function writeDaemonFile(dataDir: string, info: DaemonFile): Promise<void> {
  const path = daemonFilePath(dataDir);
  await writeFile(path, JSON.stringify(info), { mode: 0o600 });
  await chmod(path, 0o600);
}

/** Removes the file only if it still belongs to this process. */
export async function removeDaemonFile(dataDir: string, pid: number): Promise<void> {
  const current = await readDaemonFile(dataDir);
  if (current && current.pid === pid) await rm(daemonFilePath(dataDir), { force: true });
}
```

**Step 4: Implement `src/daemon.ts`**

```ts
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { FsAdapter } from './adapters/claude-code/fs-adapter.js';
import { createGitResolver } from './adapters/git.js';
import { Collector } from './collector.js';
import { DEFAULT_PORT, resolvePaths } from './config.js';
import { removeDaemonFile, writeDaemonFile } from './daemon-file.js';
import { createApiServer } from './server/http.js';
import { Store } from './store/store.js';

export interface DaemonOptions {
  port?: number;
  claudeDir?: string;
  dataDir?: string;
  /** Watch ~/.claude on disk (default true). Hooks work either way. */
  watchFiles?: boolean;
  log?: (line: string) => void;
}

export interface RunningDaemon {
  port: number;
  dataDir: string;
  collector: Collector;
  stop(): Promise<void>;
}

/** node:sqlite prints an ExperimentalWarning on Node 22. Hide that one, keep the others. Call before opening the store. */
export function silenceExperimentalWarnings(): void {
  process.removeAllListeners('warning');
  process.on('warning', (w) => {
    if (w.name !== 'ExperimentalWarning') process.stderr.write(`${w.name}: ${w.message}\n`);
  });
}

export async function loadOrCreateToken(dataDir: string): Promise<string> {
  const file = join(dataDir, 'token');
  try {
    const existing = (await readFile(file, 'utf8')).trim();
    if (/^[0-9a-f]{48}$/.test(existing)) return existing;
  } catch {
    // create below
  }
  const token = randomBytes(24).toString('hex');
  await writeFile(file, token + '\n', { mode: 0o600 });
  await chmod(file, 0o600);
  return token;
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

export async function startDaemon(opts: DaemonOptions = {}): Promise<RunningDaemon> {
  silenceExperimentalWarnings();
  const log = opts.log ?? ((line: string) => process.stderr.write(line + '\n'));
  const paths = resolvePaths(opts);
  await mkdir(paths.dataDir, { recursive: true, mode: 0o700 });
  const token = await loadOrCreateToken(paths.dataDir);

  const store = await Store.open(join(paths.dataDir, 'scranton.db'));
  store.prune(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const resolveWorkspace = createGitResolver();
  const collector = new Collector({ resolveWorkspace, store, acceptSources: ['hook', 'fs'] });
  const server = createApiServer({ collector, token });

  let port: number;
  try {
    port = await listen(server, opts.port ?? DEFAULT_PORT);
  } catch (err) {
    store.close();
    throw err;
  }
  await writeDaemonFile(paths.dataDir, { port, token, pid: process.pid, startedAt: Date.now() });

  const fsAdapter = opts.watchFiles === false
    ? null
    : new FsAdapter({ claudeDir: paths.claudeDir, emit: (e) => void collector.ingest(e), resolveWorkspace });
  fsAdapter?.start();
  log(`scranton-hq is listening on http://127.0.0.1:${port}`);

  return {
    port,
    dataDir: paths.dataDir,
    collector,
    stop: async () => {
      fsAdapter?.stop();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await collector.close();
      store.close();
      await removeDaemonFile(paths.dataDir, process.pid);
    },
  };
}
```

**Step 5: Run the tests**

Run: `npx vitest run test/daemon.test.ts && npm run typecheck`
Expected: PASS.

**Step 6: Commit**

```bash
git add src/daemon-file.ts src/daemon.ts test/daemon.test.ts
git commit -m "Run the daemon: store, collector, filesystem watcher and API"
```

---

### Task 18: CLI: start, status, ls, ack

`status` runs on every tmux refresh, so it must start fast and stay quiet: it imports only `node:util`, `config.js`, `client.js`, `daemon-file.js` and `cli-format.js`. Commands that need the daemon or the store import them lazily.

**Files:**
- Create: `src/client.ts`, `src/cli-format.ts`, `src/cli.ts`, `src/bin.ts`, `test/cli-format.test.ts`, `test/cli.test.ts`

**Step 1: Write the failing format test `test/cli-format.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { formatAgo, formatAttentionText, formatBuilding, formatTmux } from '../src/cli-format.js';
import type { AttentionSummary, Snapshot } from '../src/collector.js';
import { newSession } from '../src/core/reducer.js';
import { toView } from '../src/core/view.js';
import { WS } from './helpers/events.js';

const NOW = 10 * 60 * 60 * 1000;

describe('formatAgo', () => {
  it('uses the largest sensible unit', () => {
    expect([0, 59_000, 60_000, 3_600_000, 47 * 3_600_000, 48 * 3_600_000].map(formatAgo)).toEqual(['0s', '59s', '1m', '1h', '47h', '2d']);
  });
});

describe('formatTmux', () => {
  it('shows only non-zero counters', () => {
    expect(formatTmux({ needsYou: 2, done: 3 })).toBe('#[fg=colour203,bold]◉2#[default] #[fg=colour114]✓3#[default]');
    expect(formatTmux({ needsYou: 0, done: 1 })).toBe('#[fg=colour114]✓1#[default]');
    expect(formatTmux({ needsYou: 0, done: 0 })).toBe('');
  });
});

describe('formatAttentionText', () => {
  it('lists waiting sessions with reason, age and pane', () => {
    const a: AttentionSummary = {
      generatedAt: NOW, needsYou: 1, done: 1,
      items: [
        { id: 'S1', name: 'orders-api-c3', repo: 'orders-api', feature: 'checkout-v2', state: 'needs_you', since: NOW - 12 * 60_000, reason: { kind: 'permission', text: 'Bash', detail: 'Bash: rm -rf dist' }, title: null, tmuxPane: '%7' },
        { id: 'S2', name: 'storefront-web-b2', repo: 'storefront-web', feature: 'checkout-v2', state: 'done', since: NOW - 3 * 3_600_000, reason: null, title: 'Rewrite checkout copy', tmuxPane: null },
      ],
    };
    const lines = formatAttentionText(a, NOW).split('\n');
    expect(lines[0]).toMatch(/^◉ orders-api-c3\s+12m\s+Bash \(Bash: rm -rf dist\)\s+\[%7\]$/);
    expect(lines[1]).toMatch(/^✓ storefront-web-b2\s+3h\s+Rewrite checkout copy$/);
    expect(formatAttentionText({ generatedAt: NOW, needsYou: 0, done: 0, items: [] }, NOW)).toBe('Nobody is waiting for you.');
  });
});

describe('formatBuilding', () => {
  it('prints one block per floor', () => {
    const waiting = toView({ ...newSession('S1', NOW - 60_000, { ...WS, worktree: true }), state: 'needs_you', stateSince: NOW - 60_000, waitReason: { kind: 'question', text: 'Redis or Postgres?' }, tmuxPane: '%2' }, NOW);
    const working = toView({ ...newSession('S2', NOW - 120_000, { ...WS, repoName: 'storefront-web' }), state: 'working', stateSince: NOW - 5000, lastEventAt: NOW - 5000, title: 'Build the address step' }, NOW);
    const snap: Snapshot = {
      generatedAt: NOW,
      floors: [{ key: 'feature:checkout-v2', kind: 'feature', name: 'checkout-v2', repos: ['orders-api', 'storefront-web'], sessions: [waiting, working], counts: {}, openedAt: 0, dormant: false }],
      attention: { needsYou: [waiting], done: [] },
    };
    const lines = formatBuilding(snap).split('\n');
    expect(lines[0]).toBe('checkout-v2  (feature · orders-api, storefront-web)');
    expect(lines[1]).toMatch(/^ {2}◉ needs you\s+orders-api\*\s+1m\s+Redis or Postgres\?\s+\[%2\]$/);
    expect(lines[2]).toMatch(/^ {2}● working\s+storefront-web\s+5s\s+Build the address step$/);
    expect(formatBuilding({ generatedAt: NOW, floors: [], attention: { needsYou: [], done: [] } })).toBe('No sessions yet.');
  });
});
```

**Step 2: Run it to see it fail**

Run: `npx vitest run test/cli-format.test.ts`
Expected: FAIL, module not found.

**Step 3: Implement `src/cli-format.ts`**

```ts
import type { AttentionSummary, Snapshot } from './collector.js';
import { truncate } from './core/tool-label.js';
import type { SessionState, WaitReason } from './core/types.js';

export function formatAgo(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function pad(s: string, width: number): string {
  return s.length >= width ? s.slice(0, width) : s + ' '.repeat(width - s.length);
}

function reasonText(r: WaitReason | null): string {
  if (!r) return 'Needs you';
  return r.detail ? `${r.text} (${r.detail})` : r.text;
}

const pane = (p: string | null): string => (p ? `  [${p}]` : '');

export function formatTmux(a: Pick<AttentionSummary, 'needsYou' | 'done'>): string {
  const parts: string[] = [];
  if (a.needsYou > 0) parts.push(`#[fg=colour203,bold]◉${a.needsYou}#[default]`);
  if (a.done > 0) parts.push(`#[fg=colour114]✓${a.done}#[default]`);
  return parts.join(' ');
}

export function formatAttentionText(a: AttentionSummary, now: number): string {
  if (a.items.length === 0) return 'Nobody is waiting for you.';
  return a.items
    .map((i) => {
      const mark = i.state === 'needs_you' ? '◉' : '✓';
      const what = i.state === 'needs_you' ? reasonText(i.reason) : (i.title ?? 'Finished');
      return `${mark} ${pad(i.name ?? i.id.slice(0, 8), 28)} ${pad(formatAgo(now - i.since), 5)} ${truncate(what, 70)}${pane(i.tmuxPane)}`;
    })
    .join('\n');
}

const MARK: Record<SessionState, string> = {
  needs_you: '◉', done: '✓', working: '●', in_meeting: '◎', no_signal: '…', idle: '○', dormant: '·', ended: '×',
};
const LABEL: Record<SessionState, string> = {
  needs_you: 'needs you', done: 'done', working: 'working', in_meeting: 'in meeting', no_signal: 'no signal', idle: 'idle', dormant: 'dormant', ended: 'ended',
};

export function formatBuilding(s: Snapshot): string {
  if (s.floors.length === 0) return 'No sessions yet.';
  const out: string[] = [];
  for (const f of s.floors) {
    out.push(`${f.name}  (${f.kind === 'feature' ? `feature · ${f.repos.join(', ')}` : 'department'})`);
    for (const v of f.sessions) {
      const detail = v.effectiveState === 'needs_you' ? reasonText(v.waitReason) : (v.title ?? v.lastPrompt ?? v.firstPrompt ?? '');
      const repo = v.workspace.repoName + (v.workspace.worktree ? '*' : '');
      out.push(`  ${MARK[v.effectiveState]} ${pad(LABEL[v.effectiveState], 10)} ${pad(repo, 22)} ${pad(formatAgo(s.generatedAt - v.effectiveSince), 5)} ${truncate(detail, 60)}${pane(v.tmuxPane)}`);
    }
  }
  return out.join('\n');
}
```

A `*` after the repo name marks a worktree.

**Step 4: Run the format test**

Run: `npx vitest run test/cli-format.test.ts && npm run typecheck`
Expected: PASS.

**Step 5: Write the failing CLI test `test/cli.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, type Io } from '../src/cli.js';
import { startDaemon, type RunningDaemon } from '../src/daemon.js';

let d: RunningDaemon;
let dataDir: string;

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (l) => out.push(l), err: (l) => err.push(l) };
  return { io, out, err };
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'shq-cli-'));
  d = await startDaemon({ port: 0, dataDir, claudeDir: await mkdtemp(join(tmpdir(), 'shq-claude-')), watchFiles: false, log: () => {} });
  await d.collector.ingest({ type: 'waiting', sessionId: 'S1', ts: Date.now(), source: 'hook', cwd: '/w/orders-api', reason: { kind: 'permission', text: 'Bash', detail: 'Bash: rm -rf dist' } });
  await d.collector.idle();
});
afterAll(() => d.stop());

describe('cli', () => {
  it('status --format tmux prints the counters', async () => {
    const c = capture();
    expect(await main(['status', '--format', 'tmux', '--data-dir', dataDir], c.io)).toBe(0);
    expect(c.out).toEqual(['#[fg=colour203,bold]◉1#[default]']);
  });

  it('status prints text and json', async () => {
    const t = capture();
    expect(await main(['status', '--data-dir', dataDir], t.io)).toBe(0);
    expect(t.out[0]).toContain('Bash (Bash: rm -rf dist)');
    const j = capture();
    expect(await main(['status', '--format', 'json', '--data-dir', dataDir], j.io)).toBe(0);
    expect(JSON.parse(j.out[0]!)).toMatchObject({ needsYou: 1, done: 0 });
  });

  it('ls prints the building', async () => {
    const c = capture();
    expect(await main(['ls', '--data-dir', dataDir], c.io)).toBe(0);
    expect(c.out[0]).toContain('orders-api  (department)');
    expect(c.out[0]).toContain('needs you');
  });

  it('ack marks finished sessions as seen', async () => {
    await d.collector.ingest({ type: 'turn.finished', sessionId: 'S2', ts: Date.now(), source: 'hook', cwd: '/w/orders-api', backgroundTasks: 0 });
    await d.collector.ingest({ type: 'turn.finished', sessionId: 'S3', ts: Date.now(), source: 'hook', cwd: '/w/orders-api', backgroundTasks: 0 });
    await d.collector.idle();
    const one = capture();
    expect(await main(['ack', 'S2', '--data-dir', dataDir], one.io)).toBe(0);
    expect(one.out).toEqual(['Marked S2 as seen.']);
    const missing = capture();
    expect(await main(['ack', 'S2', '--data-dir', dataDir], missing.io)).toBe(1);
    expect(missing.err).toEqual(['No finished session with id S2.']);
    const all = capture();
    expect(await main(['ack', '--data-dir', dataDir], all.io)).toBe(0);
    expect(all.out).toEqual(['Marked 1 session as seen.']);
  });

  it('reports a daemon that is not running', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'shq-none-'));
    const tmux = capture();
    expect(await main(['status', '--format', 'tmux', '--data-dir', empty], tmux.io)).toBe(0);
    expect(tmux.out).toEqual(['']);
    const text = capture();
    expect(await main(['status', '--data-dir', empty], text.io)).toBe(1);
    expect(text.err[0]).toContain('not running');
  });

  it('prints help and rejects unknown commands and options', async () => {
    const h = capture();
    expect(await main(['--help'], h.io)).toBe(0);
    expect(h.out[0]).toContain('Usage');
    expect(await main(['bogus'], capture().io)).toBe(2);
    expect(await main(['status', '--bogus'], capture().io)).toBe(2);
    expect(await main(['status', '--format', 'xml'], capture().io)).toBe(2);
  });
});
```

**Step 6: Run it to see it fail**

Run: `npx vitest run test/cli.test.ts`
Expected: FAIL, module not found.

**Step 7: Implement `src/client.ts`**

```ts
import { request } from 'node:http';
import { readDaemonFile } from './daemon-file.js';

export interface ApiResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
}

/** Calls the running daemon. Resolves null when it is not running or does not answer in time. */
export async function callDaemon<T>(dataDir: string, method: 'GET' | 'POST', path: string, timeoutMs = 1500): Promise<ApiResult<T> | null> {
  const info = await readDaemonFile(dataDir);
  if (!info) return null;
  return new Promise((resolve) => {
    const req = request(
      { host: '127.0.0.1', port: info.port, path, method, timeout: timeoutMs, headers: { authorization: `Bearer ${info.token}` } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (body += c));
        res.on('end', () => {
          let data: T | null = null;
          try {
            data = body ? (JSON.parse(body) as T) : null;
          } catch {
            data = null;
          }
          resolve({ ok: (res.statusCode ?? 500) < 400, status: res.statusCode ?? 0, data });
        });
      },
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.end();
  });
}
```

**Step 8: Implement `src/cli.ts`**

```ts
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import type { AttentionSummary, Snapshot } from './collector.js';
import { resolvePaths } from './config.js';

export interface Io {
  out(line: string): void;
  err(line: string): void;
}

const stdio: Io = {
  out: (line) => void process.stdout.write(line + '\n'),
  err: (line) => void process.stderr.write(line + '\n'),
};

export const HELP = `scranton-hq: watch your coding-agent sessions work

Usage:
  scranton-hq start [--port N] [--claude-dir DIR] [--data-dir DIR] [--no-watch]
  scranton-hq status [--format text|tmux|json] [--data-dir DIR]
  scranton-hq ls [--data-dir DIR]
  scranton-hq ack [SESSION_ID] [--data-dir DIR]
  scranton-hq --version`;

class UsageError extends Error {}

function version(): string {
  return (createRequire(import.meta.url)('../package.json') as { version: string }).version;
}

function isParseError(err: unknown): boolean {
  return typeof (err as { code?: unknown })?.code === 'string' && (err as { code: string }).code.startsWith('ERR_PARSE_ARGS');
}

export async function main(argv: string[], io: Io = stdio): Promise<number> {
  const [cmd, ...args] = argv;
  try {
    switch (cmd) {
      case 'start':
        return await cmdStart(args, io);
      case 'status':
        return await cmdStatus(args, io);
      case 'ls':
        return await cmdLs(args, io);
      case 'ack':
        return await cmdAck(args, io);
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        io.out(HELP);
        return 0;
      case '--version':
      case '-v':
        io.out(version());
        return 0;
      default:
        throw new UsageError(`Unknown command: ${cmd}`);
    }
  } catch (err) {
    if (err instanceof UsageError || isParseError(err)) {
      io.err((err as Error).message);
      io.err(HELP);
      return 2;
    }
    throw err;
  }
}

const dataDirOption = { 'data-dir': { type: 'string' } } as const;

async function cmdStart(args: string[], io: Io): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { port: { type: 'string' }, 'claude-dir': { type: 'string' }, ...dataDirOption, 'no-watch': { type: 'boolean', default: false } },
  });
  const port = values.port === undefined ? undefined : Number(values.port);
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) throw new UsageError(`Invalid port: ${values.port}`);
  const { startDaemon } = await import('./daemon.js');
  let daemon;
  try {
    daemon = await startDaemon({ port, claudeDir: values['claude-dir'], dataDir: values['data-dir'], watchFiles: !values['no-watch'], log: io.err });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      io.err(`Port ${port ?? 7337} is already in use. Is scranton-hq already running? Check with: scranton-hq status`);
      return 1;
    }
    throw err;
  }
  await new Promise<void>((resolve) => {
    process.once('SIGINT', () => resolve());
    process.once('SIGTERM', () => resolve());
  });
  await daemon.stop();
  return 0;
}

async function cmdStatus(args: string[], io: Io): Promise<number> {
  const { values } = parseArgs({ args, options: { format: { type: 'string', default: 'text' }, ...dataDirOption } });
  const format = values.format;
  if (format !== 'text' && format !== 'tmux' && format !== 'json') throw new UsageError(`Unknown format: ${format}`);
  const { dataDir } = resolvePaths({ dataDir: values['data-dir'] });
  const { callDaemon } = await import('./client.js');
  const r = await callDaemon<AttentionSummary>(dataDir, 'GET', '/api/attention', 800);
  const { formatAttentionText, formatTmux } = await import('./cli-format.js');
  if (format === 'tmux') {
    io.out(r?.ok && r.data ? formatTmux(r.data) : '');
    return 0;
  }
  if (!r) {
    io.err('scranton-hq is not running. Start it with: scranton-hq start');
    return 1;
  }
  if (!r.ok || !r.data) {
    io.err(`The daemon answered with status ${r.status}.`);
    return 1;
  }
  io.out(format === 'json' ? JSON.stringify(r.data) : formatAttentionText(r.data, Date.now()));
  return 0;
}

async function cmdLs(args: string[], io: Io): Promise<number> {
  const { values } = parseArgs({ args, options: { ...dataDirOption } });
  const { dataDir } = resolvePaths({ dataDir: values['data-dir'] });
  const { callDaemon } = await import('./client.js');
  const r = await callDaemon<Snapshot>(dataDir, 'GET', '/api/building');
  if (!r) {
    io.err('scranton-hq is not running. Start it with: scranton-hq start');
    return 1;
  }
  if (!r.ok || !r.data) {
    io.err(`The daemon answered with status ${r.status}.`);
    return 1;
  }
  const { formatBuilding } = await import('./cli-format.js');
  io.out(formatBuilding(r.data));
  return 0;
}

async function cmdAck(args: string[], io: Io): Promise<number> {
  const { values, positionals } = parseArgs({ args, options: { ...dataDirOption }, allowPositionals: true });
  const { dataDir } = resolvePaths({ dataDir: values['data-dir'] });
  const { callDaemon } = await import('./client.js');
  const id = positionals[0];
  if (id) {
    const r = await callDaemon<unknown>(dataDir, 'POST', `/api/sessions/${encodeURIComponent(id)}/seen`);
    if (!r) {
      io.err('scranton-hq is not running. Start it with: scranton-hq start');
      return 1;
    }
    if (r.status === 404) {
      io.err(`No finished session with id ${id}.`);
      return 1;
    }
    io.out(`Marked ${id} as seen.`);
    return 0;
  }
  const r = await callDaemon<{ marked: number }>(dataDir, 'POST', '/api/seen');
  if (!r || !r.data) {
    io.err('scranton-hq is not running. Start it with: scranton-hq start');
    return 1;
  }
  const n = r.data.marked;
  io.out(`Marked ${n} session${n === 1 ? '' : 's'} as seen.`);
  return 0;
}
```

**Step 9: Implement `src/bin.ts`**

```ts
#!/usr/bin/env node
import { main } from './cli.js';

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  },
);
```

**Step 10: Run the tests and the built binary**

Run: `npx vitest run test/cli-format.test.ts test/cli.test.ts && npm run typecheck && npm run build && node dist/bin.js --help`
Expected: tests PASS; the help text prints.

**Step 11: Commit**

```bash
git add src/client.ts src/cli-format.ts src/cli.ts src/bin.ts test/cli-format.test.ts test/cli.test.ts
git commit -m "Add the CLI: start, status (text, tmux, json), ls and ack"
```

---

### Task 19: Claude Code mod

The mod is a Claude Code plugin made of function hooks. It does two jobs in every session where it is installed:

1. **Reports the session.** It hooks Claude Code's native events and queues one payload per event, in the format of Task 2. A timer posts the queue to the daemon every 500 ms; `session.end` posts what is left at once.

   | Native event | Payload sent |
   |---|---|
   | `prompt.submit` | `UserPromptSubmit` (`prompt`) |
   | `tool.call`, before running | `PreToolUse` (`tool_name`, `tool_input`, `tool_use_id`, `agent_id` inside a subagent) |
   | `tool.call`, after running | `PostToolUse`, or `PostToolUseFailure` when the call was refused or errored |
   | `tool.check`, when the verdict is `ask` | `PermissionRequest` (`tool_name`, `tool_input`) |
   | `agent.spawn`, once spawned | `SubagentStart` (`agent_id`, `agent_type`) |
   | `turn.complete` | `Stop` |
   | `session.end` | `SessionEnd` (`reason`) |

2. **Draws a band above the prompt** while another session needs the user or has finished: `◉ 1 waiting · orders-api-c3: Bash [Go] ✓ 1 done`. It polls `GET /api/attention` every 3 s. A session never lists itself. `Go` appears only inside tmux and runs `tmux switch-client`, `select-window` and `select-pane` on the waiting session's pane. There are no desktop notifications: with ten sessions open there would be ten of each.

Subagents that finish are not reported here: the filesystem adapter (Task 12) already marks them done when their transcript goes quiet.

**What was verified, and how.** This exact code passed `claude plugin validate`, `tsc` against the API declarations, and the seven tests below under `claude plugin test`, on Claude Code 2.1.296. One live `claude -p` session with the mod loaded posted `UserPromptSubmit`, `PreToolUse` (with `tool_input.command`), `PostToolUse`, `Stop` and `SessionEnd` to a test server, with the right `Host`, token, session id and `cwd`. The `tool.check` verdict `ask` cannot happen under `claude -p`, so `PermissionRequest` is covered by the kit test only; the filesystem adapter's `waiting` status is the fallback. Under `claude -p`, `classic.*` events (the settings hooks' own events) did not reach the mod, which is why it hooks the native events.

**Rules of the mod runtime** (the validator enforces most of them):
- No Node and no DOM. Everything outside the module goes through `$`: `$.fs`, `$.http`, `$.env`, `$.process`, `$.clock`, `$.session`, `$.ui`.
- `$` may only be passed to functions declared at the top level of the file. That is why the helpers are top-level functions and the queue is module state. Module state resets when the module reloads; that is acceptable.
- No `import()`. `$.env.get` takes string literals only.
- In a test, register every `on(...)` before the first call on `$`. Every event the mod passes on with `next` needs an answer beneath it: `session.start` answers `{ cwd }`, `session.end` answers `{ sessionId }`, `tool.call` answers `{ result }`, `prompt.submit` answers `{ text }`, `turn.complete` answers `{ text }`, `tool.check` answers `{ decision }`. Calls on `$` (`fs.read`, `http.fetch`, `process.run`, `session.id`) answer `{ value }` or `{ deny }`.
- `Text` takes no `key`. Tests find texts with `{ type: 'Text', text: /…/ }` and buttons by `key`.

**Files:**
- Create: `mod/.claude-plugin/plugin.json`, `mod/hooks/hooks.json`, `mod/types/index.d.ts`, `mod/hooks/register.tsx`, `mod/tests/forward.test.ts`, `mod/tests/band.test.tsx`, `.claude-plugin/marketplace.json`, `test/mod-contract.test.ts`
- Modify: `package.json` (one script)

**Step 1: Create the manifests and the state contract**

`mod/.claude-plugin/plugin.json`
```json
{
  "name": "scranton-hq",
  "version": "0.1.0",
  "description": "Shows above the prompt which other Claude Code sessions are waiting for you, and reports this session to the local scranton-hq daemon.",
  "author": { "name": "scranton-hq contributors" },
  "license": "Apache-2.0",
  "types": "./types/index.d.ts"
}
```

`mod/hooks/hooks.json`
```json
{ "modules": ["./register.tsx"] }
```

`mod/types/index.d.ts`
```ts
export type AttentionItem = {
  id: string
  name: string | null
  repo: string
  state: 'needs_you' | 'done'
  since: number
  reason: { kind: string; text: string; detail?: string } | null
  title: string | null
  tmuxPane: string | null
}

export type Attention = { needsYou: number; done: number; items: AttentionItem[] }

declare module 'claude-code' {
  interface PluginState {
    'scranton-hq': { attention: Attention | null }
  }
}
```

`.claude-plugin/marketplace.json` (repository root)
```json
{
  "name": "scranton-hq",
  "description": "scranton-hq for Claude Code: see which of your sessions are waiting for you.",
  "owner": { "name": "scranton-hq contributors" },
  "plugins": [
    {
      "name": "scranton-hq",
      "source": "./mod",
      "description": "Shows above the prompt which other Claude Code sessions are waiting for you, and reports this session to the local scranton-hq daemon."
    }
  ]
}
```

**Step 2: Write the failing mod tests**

`mod/tests/forward.test.ts`
```ts
import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

type Post = { url: string; body: Record<string, any>[]; auth: string | undefined }

function daemon(on: On, posts: Post[]) {
  mock.env(on, { HOME: '/home/dev' })
  on('session.start', async ($, e) => ({ cwd: e.cwd }))
  on('session.id', async () => ({ value: 'S-OWN' }))
  on('fs.read', async ($, e, next) =>
    e.path === '/home/dev/.scranton-hq/daemon.json' ? { value: JSON.stringify({ port: 7337, token: 'tok' }) } : next(e),
  )
  on('http.fetch', async ($, e) => {
    if (e.init?.method === 'POST') posts.push({ url: e.url, body: JSON.parse(e.init.body ?? '[]'), auth: e.init.headers?.authorization })
    return { value: { status: e.init?.method === 'POST' ? 204 : 200, ok: true, headers: {}, text: '{"needsYou":0,"done":0,"items":[]}' } }
  })
}

const START = { cwd: '/home/dev/shop', surface: null, isInteractive: true } as const

test('forwards a turn to the daemon as one batch, in order', async ($, on) => {
  const posts: Post[] = []
  daemon(on, posts)
  const clock = mock.clock(on)
  on('prompt.submit', async ($, e) => ({ text: e.text }))
  on('tool.call', async () => ({ result: 'file-a' }))
  on('turn.complete', async ($, e) => ({ text: e.answer }))

  await $.session.start(START)
  await $.prompt.submit({ text: 'list the files', wait: false, origin: { kind: 'composer' } })
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't1' })
  expect(posts).toEqual([])
  await clock.advance(600)

  expect(posts).toHaveLength(1)
  expect(posts[0]?.url).toBe('http://127.0.0.1:7337/api/hooks')
  expect(posts[0]?.auth).toBe('Bearer tok')
  const batch = posts[0]?.body ?? []
  expect(batch.map(b => b.hook_event_name)).toEqual(['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'])
  expect(batch[0]).toMatchObject({ session_id: 'S-OWN', cwd: '/home/dev/shop', prompt: 'list the files' })
  expect(batch[1]).toMatchObject({ tool_name: 'Bash', tool_input: { command: 'ls' } })
  expect(typeof batch[0]?._scranton_ts).toBe('number')
})

test('reports a permission prompt and a failed tool', async ($, on) => {
  const posts: Post[] = []
  daemon(on, posts)
  const clock = mock.clock(on)
  on('tool.check', async () => ({ decision: 'ask' }))
  on('tool.call', async () => ({ isError: true, result: 'boom' }))

  await $.session.start(START)
  await $.tool.check({ tool: 'Bash', input: { command: 'rm -rf dist' } })
  await $.tool.call({ tool: 'Bash', command: 'rm -rf dist' })
  await clock.advance(600)

  const batch = posts[0]?.body ?? []
  expect(batch.map(b => b.hook_event_name)).toEqual(['PermissionRequest', 'PreToolUse', 'PostToolUseFailure'])
  expect(batch[0]).toMatchObject({ tool_name: 'Bash', tool_input: { command: 'rm -rf dist' } })
})

test('sends what is queued at once when the session ends', async ($, on) => {
  const posts: Post[] = []
  daemon(on, posts)
  mock.clock(on)
  on('session.end', async ($, e) => ({ sessionId: e.sessionId }))

  await $.session.start(START)
  await $.session.end({ reason: 'other', sessionId: 'S-OWN', resume: { id: 'S-OWN' } })

  expect(posts.map(p => p.body.map(b => b.hook_event_name))).toEqual([['SessionEnd']])
  expect(posts[0]?.body[0]).toMatchObject({ reason: 'other', session_id: 'S-OWN' })
})

test('keeps working when the daemon is not running', async ($, on) => {
  mock.env(on, { HOME: '/home/dev' })
  const clock = mock.clock(on)
  on('session.start', async ($, e) => ({ cwd: e.cwd }))
  on('session.id', async () => ({ value: 'S-OWN' }))
  on('fs.read', async () => ({ deny: 'ENOENT' }))
  on('prompt.submit', async ($, e) => ({ text: e.text }))

  await $.session.start(START)
  const r = await $.prompt.submit({ text: 'still fine', wait: false, origin: { kind: 'composer' } })
  await clock.advance(5000)
  expect(r).toMatchObject({ text: 'still fine' })
})
```

`mod/tests/band.test.tsx`
```tsx
import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const ATTENTION = {
  needsYou: 2,
  done: 1,
  items: [
    { id: 'S-OWN', name: 'me', repo: 'shop', state: 'needs_you', since: 1, reason: { kind: 'question', text: 'mine' }, title: null, tmuxPane: '%1' },
    { id: 'S2', name: 'orders-api-c3', repo: 'orders-api', state: 'needs_you', since: 2, reason: { kind: 'permission', text: 'Bash' }, title: null, tmuxPane: '%7' },
    { id: 'S3', name: 'storefront-web-b2', repo: 'storefront-web', state: 'done', since: 3, reason: null, title: 'Copy', tmuxPane: null },
  ],
}
const NOBODY = { needsYou: 0, done: 0, items: [] }
const BAND = { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 100, scroll: { offset: 0, bodyRows: 5 }, view: {}, title: '', isFocused: false }
const START = { cwd: '/home/dev/shop', surface: null, isInteractive: true } as const

function daemon(on: On, attention: object, env: Record<string, string>, ran: string[][]) {
  mock.env(on, env)
  on('session.start', async ($, e) => ({ cwd: e.cwd }))
  on('session.id', async () => ({ value: 'S-OWN' }))
  on('fs.read', async () => ({ value: JSON.stringify({ port: 7337, token: 'tok' }) }))
  on('http.fetch', async () => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(attention) } }))
  on('process.run', async ($, e) => {
    ran.push([...e.argv])
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
}

test('shows who else is waiting and jumps to their tmux pane', async ($, on) => {
  const ran: string[][] = []
  daemon(on, ATTENTION, { HOME: '/home/dev', TMUX: '/tmp/tmux-501/default,1,0' }, ran)
  const clock = mock.clock(on)
  await $.session.start(START)
  await clock.advance(3100)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'scranton-hq', surface, component: 'AbovePrompt', props: BAND })
    expect((await ui.find({ type: 'Text', text: /waiting/ }))?.text).toBe('◉ 1 waiting · orders-api-c3: Bash ')
    expect((await ui.find({ type: 'Text', text: /done/ }))?.text).toBe(' ✓ 1 done')
    await ui.press({ key: 'go' })
    await ui.unmount()
  }
  expect(ran.slice(0, 3)).toEqual([
    ['tmux', 'switch-client', '-t', '%7'],
    ['tmux', 'select-window', '-t', '%7'],
    ['tmux', 'select-pane', '-t', '%7'],
  ])
})

test('offers no jump outside tmux', async ($, on) => {
  daemon(on, ATTENTION, { HOME: '/home/dev' }, [])
  const clock = mock.clock(on)
  await $.session.start(START)
  await clock.advance(3100)
  const ui = await $.ui.mount({ plugin: 'scranton-hq', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await ui.find({ key: 'go' })).toBeUndefined()
  await ui.unmount()
})

test('draws nothing when nobody else needs you', async ($, on) => {
  daemon(on, NOBODY, { HOME: '/home/dev' }, [])
  const clock = mock.clock(on)
  on('ui.render', async () => ({ type: 'Box', children: [] }))
  await $.session.start(START)
  await clock.advance(3100)
  const ui = await $.ui.mount({ plugin: 'scranton-hq', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await ui.find({ type: 'Text' })).toBeUndefined()
  await ui.unmount()
})
```

**Step 3: Run them to see them fail**

Run: `claude plugin test mod`
Expected: FAIL (the plugin has no hooks module yet).

**Step 4: Write `mod/hooks/register.tsx`**

```tsx
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Attention } from '../types'

// scranton-hq for Claude Code: forwards what the session does to the local scranton-hq daemon,
// and shows above the prompt who else is waiting for you. Payloads use the field names of
// Claude Code's settings hooks, so the daemon reads them with one mapper.

const MAX_STRING = 400
const MAX_QUEUE = 500
const FLUSH_MS = 500
const POLL_MS = 3000

const attention = atom({ plugin: 'scranton-hq', key: 'attention' } as const, null)

type Daemon = { port: number; token: string }
type Payload = Record<string, unknown>

const queue: Payload[] = []
let daemon: Daemon | null = null
let sessionCwd = ''

function slim(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return value.length > MAX_STRING ? value.slice(0, MAX_STRING) : value
  if (value === null || typeof value !== 'object' || depth > 3) return value
  if (Array.isArray(value)) return value.slice(0, 20).map(v => slim(v, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value).slice(0, 30)) out[k] = slim(v, depth + 1)
  return out
}

async function enqueue($: EngineInterface, fields: Payload) {
  const body: Payload = { _scranton_ts: await $.clock.now(), session_id: await $.session.id(), cwd: sessionCwd }
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) body[k] = slim(v)
  queue.push(body)
  if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE)
}

async function locate($: EngineInterface): Promise<Daemon | null> {
  const dir = (await $.env.get('SCRANTON_HQ_HOME')) ?? `${(await $.env.get('HOME')) ?? ''}/.scranton-hq`
  try {
    const d = JSON.parse(await $.fs.read(`${dir}/daemon.json`)) as Partial<Daemon>
    return typeof d.port === 'number' && typeof d.token === 'string' ? { port: d.port, token: d.token } : null
  } catch {
    return null
  }
}

async function call($: EngineInterface, method: string, path: string, body?: string) {
  daemon ??= await locate($)
  if (!daemon) return null
  try {
    const r = await $.http.fetch(`http://127.0.0.1:${daemon.port}${path}`, {
      method,
      headers: { authorization: `Bearer ${daemon.token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body }),
    })
    if (r.status === 401) daemon = null
    return r
  } catch {
    daemon = null
    return null
  }
}

async function flush($: EngineInterface) {
  if (queue.length === 0) return
  const batch = queue.splice(0, queue.length)
  const r = await call($, 'POST', '/api/hooks', JSON.stringify(batch))
  if (!r?.ok) queue.unshift(...batch.slice(-(MAX_QUEUE - queue.length)))
}

async function poll($: EngineInterface) {
  const r = await call($, 'GET', '/api/attention')
  let next: Attention | null = null
  if (r?.ok) {
    try {
      next = JSON.parse(r.text) as Attention
    } catch {
      next = null
    }
  }
  await update($, attention, () => next)
}

async function jump($: EngineInterface, pane: string) {
  await $.process.run(['tmux', 'switch-client', '-t', pane])
  await $.process.run(['tmux', 'select-window', '-t', pane])
  await $.process.run(['tmux', 'select-pane', '-t', pane])
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    sessionCwd = e.cwd
    $.clock.every(FLUSH_MS, () => void flush($))
    $.clock.every(POLL_MS, () => void poll($))
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    await enqueue($, { hook_event_name: 'UserPromptSubmit', prompt: e.text })
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const { tool, tool_use_id, agentId, ...input } = e as unknown as Payload & { tool: string; tool_use_id?: string; agentId?: string }
    await enqueue($, { hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, tool_use_id, agent_id: agentId })
    const result = await next(e)
    const failed = result.deny !== undefined || result.isError === true
    await enqueue($, { hook_event_name: failed ? 'PostToolUseFailure' : 'PostToolUse', tool_name: tool, tool_use_id, agent_id: agentId })
    return result
  }).catch(($, e, next) => next(e))

  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    if (verdict.decision === 'ask') {
      await enqueue($, { hook_event_name: 'PermissionRequest', tool_name: e.tool, tool_input: e.input, agent_id: e.agentId })
    }
    return verdict
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)
    if (spawned.agentId) await enqueue($, { hook_event_name: 'SubagentStart', agent_id: spawned.agentId, agent_type: e.subagentType })
    return spawned
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    await enqueue($, { hook_event_name: 'Stop', background_tasks: 0 })
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await enqueue($, { hook_event_name: 'SessionEnd', reason: e.reason })
    await flush($)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const a = await read($, attention)
    if (e.props.hasSurvey || !a) return next(e)
    const own = await $.session.id()
    const waiting = a.items.filter(i => i.state === 'needs_you' && i.id !== own)
    const done = a.items.filter(i => i.state === 'done' && i.id !== own).length
    if (waiting.length === 0 && done === 0) return next(e)
    const inTmux = (await $.env.get('TMUX')) !== undefined
    const first = waiting[0]
    const pane = first?.tmuxPane ?? null
    const { Box, Button, Text } = $.ui.resolve(e)
    return (
      <Box>
        {first ? <Text color="red">◉ {waiting.length} waiting · {first.name ?? first.repo}: {first.reason?.text ?? 'needs you'} </Text> : null}
        {pane && inTmux ? <Button key="go" label="Go" onPress={() => jump($, pane)} /> : null}
        {done > 0 ? <Text color="green"> ✓ {done} done</Text> : null}
      </Box>
    )
  })
}
```

**Step 5: Validate and run the mod tests**

Run: `claude plugin validate mod && claude plugin validate . && claude plugin test mod`
Expected: `✔ Validation passed` twice. The hooks report lists `session.start, prompt.submit, tool.call, tool.check, agent.spawn, turn.complete, session.end, ui.render{component=AbovePrompt}` and a `gating hook with .catch` line for each of `prompt.submit`, `tool.call`, `tool.check`, `agent.spawn`. Then `7 pass, 0 fail`.

A `gating hook without .catch` line is a bug: add the `.catch`. If a test fails on a shape the declarations disagree with, the declarations win: read them (next step), adapt, and report the difference to the coordinator.

**Step 6: Type-check the mod**

The coordinator passes you the path of `claude-code.d.ts` for the installed Claude Code. The `plugin-authoring` skill writes it when it loads, under `/private/tmp/claude-<uid>/bundled-skills/<version>/<hash>/plugin-authoring/types/claude-code.d.ts`. Create a tsconfig **outside the repository** (for example in your scratchpad), never inside `mod/`:

```json
{
  "compilerOptions": {
    "target": "es2023", "lib": ["es2023"], "types": [],
    "module": "esnext", "moduleResolution": "bundler",
    "strict": true, "noUncheckedIndexedAccess": true,
    "noEmit": true, "skipLibCheck": true,
    "jsx": "react", "jsxFactory": "h", "jsxFragmentFactory": "Fragment"
  },
  "include": ["<path to claude-code.d.ts>", "<repo>/mod/hooks", "<repo>/mod/types", "<repo>/mod/tests"]
}
```

Run: `npx tsc -p <that tsconfig>`
Expected: no output. If no path was given, skip this step and say so in your report.

**Step 7: Write the contract test `test/mod-contract.test.ts`**

The mod cannot import from `src/`, so this vitest reads its source as text and checks that it only sends payloads the mapper understands.

```ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { HOOK_EVENTS, mapHookPayload } from '../src/adapters/claude-code/hooks.js';

const source = readFileSync(new URL('../mod/hooks/register.tsx', import.meta.url), 'utf8');
const sent = [...new Set(
  source.split('\n')
    .filter((line) => line.includes('hook_event_name'))
    .flatMap((line) => [...line.matchAll(/'([A-Z][A-Za-z]+)'/g)].map((m) => m[1]!)),
)].sort();

describe('the mod and the daemon agree on payloads', () => {
  it('the mod sends only names the mapper understands', () => {
    expect(sent).toEqual(['PermissionRequest', 'PostToolUse', 'PostToolUseFailure', 'PreToolUse', 'SessionEnd', 'Stop', 'SubagentStart', 'UserPromptSubmit']);
    for (const name of sent) expect(HOOK_EVENTS).toContain(name);
  });

  it('every payload the mod sends maps to at least one event', () => {
    for (const name of sent) {
      const payload = JSON.parse(readFileSync(new URL(`./fixtures/hooks/${name}.json`, import.meta.url), 'utf8'));
      expect(mapHookPayload(payload, 0).length, name).toBeGreaterThan(0);
    }
  });
});
```

Run: `npx vitest run test/mod-contract.test.ts`
Expected: PASS.

**Step 8: Add the local script to `package.json`**

Add to `"scripts"`: `"test:mod": "claude plugin validate mod && claude plugin validate . && claude plugin test mod"`. It needs the `claude` CLI, so it runs locally only, not in CI. The root `tsconfig.json` (`include: ["src", "test"]`) and vitest (`test/**/*.test.ts`) already leave `mod/` out; keep it that way.

**Step 9: Commit**

```bash
git add mod .claude-plugin test/mod-contract.test.ts package.json
git commit -m "Add the Claude Code mod: live session events and the band above the prompt"
```

---

### Task 20: Demo adapter and `demo` command

Scripted synthetic sessions that flow through the real collector. Used for development, README screenshots and contributors without live sessions. The demo daemon uses its own data directory (`<dataDir>/demo`) and port (7338), keeps everything in memory, and ignores hook and filesystem events.

**Files:**
- Create: `src/adapters/demo.ts`, `test/adapters/demo.test.ts`
- Modify: `src/daemon.ts` (a `demo` option), `src/cli.ts` (a `demo` command)

**Step 1: Write the failing test**

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEMO_SESSIONS, demoScript, startDemo } from '../../src/adapters/demo.js';
import { Collector } from '../../src/collector.js';
import type { RawEvent } from '../../src/core/types.js';
import { startDaemon } from '../../src/daemon.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('demoScript', () => {
  it('opens with three floors and two sessions waiting', async () => {
    const base = 1_000_000_000;
    let now = base;
    const c = new Collector({ resolveWorkspace: async () => { throw new Error('demo events carry their workspace'); }, now: () => now, acceptSources: ['demo'] });
    const steps = demoScript();
    for (const e of steps[0]!.events(base)) await c.ingest(e);
    now = base + 100;
    const snap = c.snapshot();
    expect(snap.floors.map((f) => [f.name, f.kind, f.repos])).toEqual([
      ['checkout-v2', 'feature', ['orders-api', 'payments-svc', 'storefront-web']],
      ['search-ranking', 'feature', ['search-svc']],
      ['orders-api', 'department', ['orders-api']],
    ]);
    expect(snap.attention.needsYou.map((s) => s.id)).toEqual(['demo-oa-c3', 'demo-oa-g7']);
    expect(snap.attention.done.map((s) => s.id)).toEqual(['demo-sw-b2']);

    for (const step of steps.slice(1)) {
      now = base + step.at;
      for (const e of step.events(now)) await c.ingest(e);
    }
    now = base + 59_000;
    const end = c.snapshot().attention;
    expect(end.needsYou.map((s) => s.id)).toEqual(['demo-sw-a1']);
    expect(end.done.map((s) => s.id)).toEqual(['demo-oa-h8', 'demo-ps-d4', 'demo-oa-c3']);
    expect(DEMO_SESSIONS).toHaveLength(7);
  });
});

describe('startDemo', () => {
  it('replays the script on a loop until stopped', async () => {
    vi.useFakeTimers();
    const got: RawEvent[] = [];
    const demo = startDemo((e) => got.push(e), { now: () => 5_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(got).toHaveLength(32);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(got).toHaveLength(40);
    demo.stop();
    await vi.advanceTimersByTimeAsync(200_000);
    expect(got).toHaveLength(40);
  });
});

describe('demo daemon', () => {
  it('serves demo sessions and ignores real ones', async () => {
    const d = await startDaemon({ demo: true, port: 0, dataDir: await mkdtemp(join(tmpdir(), 'shq-demo-')), log: () => {} });
    await new Promise((r) => setTimeout(r, 50));
    await d.collector.ingest({ type: 'prompt', sessionId: 'REAL', ts: Date.now(), source: 'hook', cwd: '/w/real', text: 'x' });
    await d.collector.idle();
    const summary = d.collector.attentionSummary();
    expect(summary.needsYou).toBe(2);
    expect(d.collector.snapshot().floors.flatMap((f) => f.sessions.map((s) => s.id))).not.toContain('REAL');
    await d.stop();
  });
});
```

**Step 2: Run it to see it fail**

Run: `npx vitest run test/adapters/demo.test.ts`
Expected: FAIL, module not found.

**Step 3: Implement `src/adapters/demo.ts`**

```ts
import type { DistributiveOmit, RawEvent, Workspace } from '../core/types.js';

interface DemoSession {
  id: string;
  name: string;
  pane: string;
  workspace: Workspace;
  title: string;
  prompt: string;
}

const ws = (cwd: string, branch: string, repoRoot = cwd): Workspace => ({
  cwd,
  repoRoot,
  repoName: repoRoot.split('/').pop() ?? repoRoot,
  worktree: cwd !== repoRoot,
  branch,
});

export const DEMO_SESSIONS: DemoSession[] = [
  { id: 'demo-sw-a1', name: 'storefront-web-a1', pane: '%4', workspace: ws('/demo/storefront-web', 'feat/checkout-v2'), title: 'Build the address step of the new checkout', prompt: 'Build the address step' },
  { id: 'demo-sw-b2', name: 'storefront-web-b2', pane: '%5', workspace: ws('/demo/storefront-web', 'feat/checkout-v2'), title: 'Rewrite checkout copy and empty states', prompt: 'Rewrite the checkout copy' },
  { id: 'demo-oa-c3', name: 'orders-api-c3', pane: '%7', workspace: ws('/demo/orders-api/.worktrees/checkout-v2', 'feat/checkout-v2', '/demo/orders-api'), title: 'Add idempotency keys to POST /orders', prompt: 'Add idempotency keys' },
  { id: 'demo-ps-d4', name: 'payments-svc-d4', pane: '%9', workspace: ws('/demo/payments-svc', 'feat/checkout-v2'), title: 'Support split payments across two cards', prompt: 'Support split payments' },
  { id: 'demo-ss-e5', name: 'search-svc-e5', pane: '%11', workspace: ws('/demo/search-svc', 'feat/search-ranking'), title: 'Tune BM25 weights with click data', prompt: 'Tune the ranking weights' },
  { id: 'demo-oa-g7', name: 'orders-api-g7', pane: '%2', workspace: ws('/demo/orders-api', 'main'), title: 'Investigate duplicate confirmation emails', prompt: 'Why do customers get two emails?' },
  { id: 'demo-oa-h8', name: 'orders-api-h8', pane: '%3', workspace: ws('/demo/orders-api', 'main'), title: 'Bump dependencies and fix type errors', prompt: 'Bump dependencies' },
];

type Body = DistributiveOmit<RawEvent, 'sessionId' | 'ts' | 'source'>;
const at = (sessionId: string, ts: number, body: Body): RawEvent => ({ ...body, sessionId, ts, source: 'demo' }) as RawEvent;

export interface DemoStep {
  /** Offset in ms from the start of the loop. */
  at: number;
  events(ts: number): RawEvent[];
}

export const DEMO_LOOP_MS = 60_000;

export function demoScript(): DemoStep[] {
  return [
    {
      at: 0,
      events: (b) => [
        ...DEMO_SESSIONS.flatMap((s, i) => [
          at(s.id, b + i, { type: 'session.seen', workspace: s.workspace, pid: null, name: s.name, tmuxPane: s.pane, startedAt: b - (i + 1) * 600_000 }),
          at(s.id, b + i, { type: 'title', title: s.title }),
          at(s.id, b + i, { type: 'prompt', text: s.prompt }),
        ]),
        at('demo-sw-a1', b + 20, { type: 'tool.started', toolId: 'a1-t1', tool: 'Edit', label: 'Edit src/checkout/AddressStep.tsx', agentId: null }),
        at('demo-sw-a1', b + 21, { type: 'agent.started', agentId: 'demo-a1-explore', agentType: 'Explore', description: 'Find every caller of useCart()' }),
        at('demo-sw-b2', b + 22, { type: 'turn.finished', backgroundTasks: 0 }),
        at('demo-oa-c3', b + 23, { type: 'tool.started', toolId: 'c3-t1', tool: 'Bash', label: 'Bash: rm -rf dist && npm run build', agentId: null }),
        at('demo-oa-c3', b + 24, { type: 'waiting', reason: { kind: 'permission', text: 'Bash', detail: 'Bash: rm -rf dist && npm run build' } }),
        at('demo-ps-d4', b + 25, { type: 'agent.started', agentId: 'demo-wf-1', agentType: 'general-purpose', description: 'Implement the split ledger entries' }),
        at('demo-ps-d4', b + 26, { type: 'agent.started', agentId: 'demo-wf-2', agentType: 'general-purpose', description: 'Implement the refund path' }),
        at('demo-ps-d4', b + 27, { type: 'turn.finished', backgroundTasks: 2 }),
        at('demo-ss-e5', b + 28, { type: 'tool.started', toolId: 'e5-t1', tool: 'Bash', label: 'Bash: npm test', agentId: null }),
        at('demo-oa-g7', b + 29, { type: 'waiting', reason: { kind: 'question', text: 'Should the retry queue use Redis or Postgres?' } }),
        at('demo-oa-h8', b + 30, { type: 'tool.started', toolId: 'h8-t1', tool: 'Bash', label: 'Bash: npm run typecheck', agentId: null }),
      ],
    },
    { at: 6_000, events: (b) => [at('demo-sw-a1', b, { type: 'agent.finished', agentId: 'demo-a1-explore' })] },
    { at: 10_000, events: (b) => [at('demo-oa-c3', b, { type: 'tool.finished', toolId: 'c3-t1', ok: true, agentId: null })] },
    { at: 16_000, events: (b) => [at('demo-ps-d4', b, { type: 'agent.finished', agentId: 'demo-wf-1' })] },
    { at: 22_000, events: (b) => [at('demo-oa-h8', b, { type: 'turn.finished', backgroundTasks: 0 })] },
    { at: 28_000, events: (b) => [at('demo-ps-d4', b, { type: 'agent.finished', agentId: 'demo-wf-2' })] },
    { at: 34_000, events: (b) => [at('demo-sw-a1', b, { type: 'waiting', reason: { kind: 'question', text: 'Keep the old address form behind a flag?' } })] },
    { at: 42_000, events: (b) => [at('demo-oa-g7', b, { type: 'prompt', text: 'Use Postgres.' })] },
    { at: 50_000, events: (b) => [at('demo-oa-c3', b, { type: 'turn.finished', backgroundTasks: 0 })] },
  ];
}

export function startDemo(ingest: (e: RawEvent) => void, opts: { loopMs?: number; now?: () => number } = {}): { stop(): void } {
  const loopMs = opts.loopMs ?? DEMO_LOOP_MS;
  const now = opts.now ?? Date.now;
  let timers: NodeJS.Timeout[] = [];
  let stopped = false;
  const loop = () => {
    if (stopped) return;
    timers = [];
    const base = now();
    for (const step of demoScript()) {
      timers.push(setTimeout(() => {
        if (!stopped) for (const e of step.events(base + step.at)) ingest(e);
      }, step.at));
    }
    timers.push(setTimeout(loop, loopMs));
  };
  loop();
  return {
    stop: () => {
      stopped = true;
      for (const t of timers) clearTimeout(t);
      timers = [];
    },
  };
}
```

**Step 4: Add the `demo` option to `src/daemon.ts`**

1. Import: `import { startDemo } from './adapters/demo.js';`
2. Add to `DaemonOptions`: `/** Serve scripted demo sessions from memory; ignore hooks and files. */ demo?: boolean;`
3. Replace the store, collector, adapter lines with:

```ts
  const store = await Store.open(opts.demo ? ':memory:' : join(paths.dataDir, 'scranton.db'));
  store.prune(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const resolveWorkspace = createGitResolver();
  const collector = new Collector({ resolveWorkspace, store, acceptSources: opts.demo ? ['demo'] : ['hook', 'fs'] });
```

and

```ts
  const fsAdapter = opts.demo || opts.watchFiles === false
    ? null
    : new FsAdapter({ claudeDir: paths.claudeDir, emit: (e) => void collector.ingest(e), resolveWorkspace });
  fsAdapter?.start();
  const demo = opts.demo ? startDemo((e) => void collector.ingest(e)) : null;
```

4. In `stop`, call `demo?.stop();` right after `fsAdapter?.stop();`.

**Step 5: Add the `demo` command to `src/cli.ts`**

Add `import { join } from 'node:path';` to the imports at the top, `case 'demo': return await cmdDemo(args, io);` to the switch, the help line `scranton-hq demo [--port N] [--data-dir DIR]` after the `ack` line, and:

```ts
async function cmdDemo(args: string[], io: Io): Promise<number> {
  const { values } = parseArgs({ args, options: { port: { type: 'string', default: '7338' }, ...dataDirOption } });
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UsageError(`Invalid port: ${values.port}`);
  const dataDir = values['data-dir'] ?? join(resolvePaths().dataDir, 'demo');
  const { startDaemon } = await import('./daemon.js');
  let daemon;
  try {
    daemon = await startDaemon({ demo: true, port, dataDir, log: io.err });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      io.err(`Port ${port} is already in use. Pick another with --port.`);
      return 1;
    }
    throw err;
  }
  io.err(`Demo running. In another terminal: scranton-hq ls --data-dir ${dataDir}`);
  await new Promise<void>((resolve) => {
    process.once('SIGINT', () => resolve());
    process.once('SIGTERM', () => resolve());
  });
  await daemon.stop();
  return 0;
}
```

**Step 6: Run the tests**

Run: `npx vitest run test/adapters/demo.test.ts test/daemon.test.ts test/cli.test.ts && npm run typecheck`
Expected: PASS.

**Step 7: Commit**

```bash
git add src/adapters/demo.ts src/daemon.ts src/cli.ts test/adapters/demo.test.ts
git commit -m "Add scripted demo sessions and the demo command"
```

---

### Task 21: README, end-to-end test, handover

**Files:**
- Create: `test/e2e.test.ts`
- Modify: `README.md`

**Step 1: Write the end-to-end test `test/e2e.test.ts`**

It runs the real daemon with the filesystem watcher on a fake Claude directory. The fake session file uses the test process's own pid, so the liveness check passes.

```ts
import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { encodeProjectDir } from '../src/adapters/claude-code/fs-adapter.js';
import { main, type Io } from '../src/cli.js';
import type { Snapshot } from '../src/collector.js';
import { readDaemonFile } from '../src/daemon-file.js';
import { startDaemon } from '../src/daemon.js';

const execFileP = promisify(execFile);
const git = (cwd: string, ...args: string[]) =>
  execFileP('git', ['-C', cwd, '-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'core.hooksPath=/dev/null', ...args]);

function capture() {
  const out: string[] = [];
  const io: Io = { out: (l) => out.push(l), err: () => {} };
  return { io, out };
}

async function post(port: number, token: string, body: object): Promise<number> {
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    request({ host: '127.0.0.1', port, path: '/api/hooks', method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    }).on('error', reject).end(data);
  });
}

async function waitFor<T>(fn: () => T | undefined, ms = 6000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('end to end', () => {
  it('sees a live session from disk, takes hooks, and drives the tmux counter', async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), 'shq-e2e-')));
    const repo = join(base, 'orders-api');
    await mkdir(repo);
    await git(repo, 'init', '-q', '-b', 'main');
    await git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
    await git(repo, 'checkout', '-q', '-b', 'feat/e2e-flow');

    const claudeDir = join(base, 'claude');
    await mkdir(join(claudeDir, 'sessions'), { recursive: true });
    await writeFile(join(claudeDir, 'sessions', `${process.pid}.json`), JSON.stringify({
      pid: process.pid, sessionId: 'E2E', cwd: repo, startedAt: Date.now(), status: 'busy', statusUpdatedAt: Date.now(), name: 'orders-api-e2e', tmux: 'x:@1.%9',
    }));
    const projectDir = join(claudeDir, 'projects', encodeProjectDir(repo));
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, 'E2E.jsonl'), [
      { type: 'user', timestamp: new Date().toISOString(), cwd: repo, gitBranch: 'feat/e2e-flow', message: { content: 'Ship the e2e flow' } },
      { type: 'ai-title', aiTitle: 'End-to-end flow' },
    ].map((l) => JSON.stringify(l)).join('\n') + '\n');

    const dataDir = join(base, 'data');
    const d = await startDaemon({ port: 0, claudeDir, dataDir, log: () => {} });
    try {
      const floor = await waitFor(() => d.collector.snapshot().floors.find((f) => f.name === 'e2e-flow'));
      expect(floor.kind).toBe('feature');
      expect(floor.sessions[0]).toMatchObject({ id: 'E2E', title: 'End-to-end flow', effectiveState: 'working', tmuxPane: '%9' });

      const { token, port } = (await readDaemonFile(dataDir))!;
      expect(await post(port, token, { hook_event_name: 'PermissionRequest', session_id: 'E2E', cwd: repo, tool_name: 'Bash', tool_input: { command: 'npm publish' }, _scranton_ts: Date.now() + 1000 })).toBe(204);
      await d.collector.idle();
      const tmux = capture();
      await main(['status', '--format', 'tmux', '--data-dir', dataDir], tmux.io);
      expect(tmux.out).toEqual(['#[fg=colour203,bold]◉1#[default]']);

      expect(await post(port, token, { hook_event_name: 'Stop', session_id: 'E2E', cwd: repo, _scranton_ts: Date.now() + 2000 })).toBe(204);
      await d.collector.idle();
      const ls = capture();
      await main(['ls', '--data-dir', dataDir], ls.io);
      expect(ls.out[0]).toContain('e2e-flow  (feature · orders-api)');
      expect(ls.out[0]).toContain('done');
      await main(['ack', '--data-dir', dataDir], capture().io);
      const after = capture();
      await main(['status', '--format', 'tmux', '--data-dir', dataDir], after.io);
      expect(after.out).toEqual(['']);
    } finally {
      await d.stop();
    }
  });
});

export type { Snapshot };
```

Note: `_scranton_ts` is set slightly in the future so the hook events are newer than the session file's `statusUpdatedAt`, which the filesystem watcher keeps re-reporting as `busy` with an older timestamp.

**Step 2: Run the whole suite**

Run: `npm run typecheck && npm test && npm run build`
Expected: everything passes; `dist/` contains `bin.js`, `hook.js`, `cli.js`.

**Step 3: Rewrite `README.md`**

Keep the existing "A note on the name" and "License" sections word for word. Replace the rest with these sections, in this order. Write plain, short sentences.

1. **Title and one-line description** (as now).
2. **Status:** "Early. The collector, the CLI and the tmux counter work. The 3D building UI is next." Link the design document.
3. **What it does:** three bullets, one per problem: which sessions work on the same feature (grouped by branch across repos); which sessions are waiting for you, and why; a record of finished sessions (coming).
4. **Install:** `npm install -g scranton-hq` (Node 22.13 or later). From a clone: `npm install && npm run build && npm link`.
5. **Quick start:** `scranton-hq start` in its own tmux window or terminal, then `scranton-hq ls`. Say that this already works from the files Claude Code writes, without the mod.
6. **tmux:**
   ```tmux
   set -g status-right '#(scranton-hq status --format tmux) %H:%M'
   set -g status-interval 5
   ```
   `◉` is sessions waiting for you, `✓` is finished sessions you have not looked at. `scranton-hq ack` clears the `✓`.
7. **The Claude Code mod (recommended):** it reports each session as things happen, with the exact reason a session waits, and shows above the prompt of every session who else is waiting for you, with a `Go` button that jumps to that tmux pane. Install: `/plugin install scranton-hq --marketplace <owner>/<repo>` (keep `<owner>/<repo>` as a placeholder until the repository is published). Try it from a clone for one session: `claude --plugin-dir /path/to/scranton-hq/mod`. Without the mod, scranton-hq still works from the files Claude Code writes, with up to a second of delay and less detail about why a session waits.
8. **Commands:** a table of `start`, `status`, `ls`, `ack`, `demo`.
9. **How it works:** two sources (the mod, and Claude Code's own files under `~/.claude`), one collector, a localhost API. The files under `~/.claude` are internal to Claude Code and can change between versions; scranton-hq reads them defensively and never writes there. The mod uses Claude Code's plugin API, which is in early access.
10. **Privacy and security:** listens on 127.0.0.1 only; every request needs a token stored in `~/.scranton-hq/token` (mode 600); no telemetry; nothing leaves your machine.
11. **Development:** `npm test`, `npm run typecheck`, `npm run test:mod` (needs the `claude` CLI; not run in CI), `scranton-hq demo` (or `node dist/bin.js demo`) for synthetic sessions, then `scranton-hq ls --data-dir ~/.scranton-hq/demo`.

**Step 4: Commit**

```bash
git add README.md test/e2e.test.ts
git commit -m "Document install and usage; add an end-to-end test"
```

---

## Final verification (Opus, before handing back to the user)

Dispatch an Opus reviewer (`model: "opus"`) over the whole branch with this checklist. Every item needs evidence (command output or file and line), not a yes.

1. `npm ci && npm run typecheck && npm test && npm run build` pass from a clean checkout.
2. `grep -rn "\.claude" src/ | grep -v "join(homedir(), '.claude')"` shows no hard-coded paths into the real home, and `git grep -n "homedir()" test/` is empty.
3. `node dist/bin.js status --format tmux --data-dir "$(mktemp -d)"` prints an empty line, exits 0, and prints nothing on stderr. Time it: under 300 ms.
4. `npm run test:mod` passes (`claude plugin validate mod`, `claude plugin validate .`, `claude plugin test mod`: 7 pass), and the mod type-checks as in Task 19 Step 6.
5. Every gating hook in `mod/hooks/register.tsx` has a `.catch`, every hook returns `next(e)`'s result, and the mod has no `$.ui.notify`.
6. `node dist/bin.js demo --data-dir "$(mktemp -d)"` starts; in another shell `node dist/bin.js ls --data-dir <same dir>` shows three floors; Ctrl-C stops it and removes `daemon.json`.
7. Types are defined once: `src/core/types.ts` is the only place that declares `Session`, `CollectorEvent`, `Workspace`.
8. Every test was seen failing before its implementation existed (the task logs show the failing run).
9. No runtime dependencies in `package.json`.

## Handover: manual steps for the user (do not run these during implementation)

These touch the user's real setup. The coordinator stops here and asks the user before each one.

1. Build and link: `npm run build && npm link` (puts `scranton-hq` on the PATH).
2. Start the daemon in its own tmux window: `scranton-hq start`. Check: `scranton-hq ls` lists the running sessions (this already works from Claude Code's own files).
3. Try the mod in one new session: `claude --plugin-dir /Users/alexiocassani/Projects/watchtower/mod`. The band shows up there when another session waits or finishes.
4. To have it in every session: publish the repository, then in any Claude Code session `/plugin install scranton-hq --marketplace <owner>/<repo>`. Before publishing, install from the local clone; check the exact command with `claude plugin --help` (`claude plugin marketplace add <repo path>`, then install `scranton-hq` from that marketplace).
5. Add the tmux lines from the README to `~/.tmux.conf` and reload with `tmux source-file ~/.tmux.conf`.

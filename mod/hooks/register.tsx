import { atom, read, update } from 'claude-code'
import type { EngineInterface, ProcessRunResult, Register } from 'claude-code'

import type { Attention } from '../types'

// hopper-hq for Claude Code: forwards what the session does to the local hopper-hq daemon,
// and shows above the prompt who else is waiting for you. Payloads use the field names of
// Claude Code's settings hooks, so the daemon reads them with one mapper.

const MAX_STRING = 400
// The main loop's final reply goes up to this many UTF-16 code units, past MAX_STRING: the daemon's summary line reads it.
const MAX_ANSWER = 2000
const MAX_QUEUE = 500
const FLUSH_MS = 500
const POLL_MS = 3000
// `hopper-hq up` returns once the building is open: in at most about 20 seconds, when the daemon is slow to start.
const UP_TIMEOUT_MS = 30_000
// A run that fails this close to the timeout was cut off by it: the binary did start.
const TIMEOUT_MARGIN_MS = 1000
const NOT_INSTALLED = 'hopper-hq is not installed, or not on your PATH'
// C0 and C1 control characters, except tab and line feed.
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g

const attention = atom({ plugin: 'hopper-hq', key: 'attention' } as const, null)

type Daemon = { port: number; token: string }
type Payload = Record<string, unknown>

const queue: Payload[] = []
let daemon: Daemon | null = null
let sessionCwd = ''
// Set in the environment of the summarizer's own `claude -p` runs: such a session forwards nothing and shows no band.
let summarizer = false
// One request of each kind at a time: a daemon that accepts and never answers holds one, not one per tick.
let flushing = false
let polling = false

function slim(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return value.length > MAX_STRING ? value.slice(0, MAX_STRING) : value
  if (value === null || typeof value !== 'object') return value
  if (depth > 3) return '[…]'
  if (Array.isArray(value)) return value.slice(0, 20).map(v => slim(v, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value).slice(0, 30)) out[k] = slim(v, depth + 1)
  return out
}

async function enqueue($: EngineInterface, fields: Payload) {
  if (summarizer) return
  const body: Payload = { _hopper_ts: await $.clock.now(), session_id: await $.session.id(), cwd: sessionCwd }
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue
    body[k] = k === 'last_assistant_message' && typeof v === 'string' ? v.slice(0, MAX_ANSWER) : slim(v)
  }
  queue.push(body)
  if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE)
}

async function locate($: EngineInterface): Promise<Daemon | null> {
  const dir = (await $.env.get('HOPPER_HQ_HOME')) ?? `${(await $.env.get('HOME')) ?? ''}/.hopper-hq`
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

async function send($: EngineInterface) {
  // The summarizer's session never posts, even what it queued before it read its environment.
  if (summarizer || queue.length === 0) return
  const batch = queue.splice(0, queue.length)
  const r = await call($, 'POST', '/api/hooks', JSON.stringify(batch))
  // Retry only what can succeed later: no daemon, a stale token, a server error. A refused batch is dropped.
  const room = MAX_QUEUE - queue.length
  if ((!r || r.status === 401 || r.status >= 500) && room > 0) queue.unshift(...batch.slice(-room))
}

async function flush($: EngineInterface) {
  if (flushing) return
  flushing = true
  try {
    await send($)
  } finally {
    flushing = false
  }
}

async function poll($: EngineInterface) {
  if (polling) return
  polling = true
  try {
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
  } finally {
    polling = false
  }
}

// A pane id is unique only on its own tmux server: another server can have the same %N. When the daemon knows the pane's
// tmux session, Go switches only to a pane of this server that is in it, as the daemon's own focus does.
async function jump($: EngineInterface, pane: string, session: string | null) {
  if (session !== null && !(await inSession($, pane, session))) {
    $.ui.toast('The pane is on another tmux server or session')
    return
  }
  await $.process.run(['tmux', 'switch-client', '-t', pane])
  await $.process.run(['tmux', 'select-window', '-t', pane])
  await $.process.run(['tmux', 'select-pane', '-t', pane])
}

// Xirp runs each agent in its own tmux session, `xirp-<id>`, one client per app tab: a tmux switch from a tab would
// move that tab onto the other session. Its sessions are focused through the app's deep link instead.
const XIRP_SESSION = /^xirp-([0-9a-f-]{36})$/
const XIRP_SCHEMES: Record<string, string> = { external: 'xirp', internal: 'xirp-internal' }

// The deep link that focuses the Xirp session `tmuxSession` names, or null when the edition or the name is not known.
function xirpLink(edition: string | undefined, tmuxSession: string | null): string | null {
  const scheme = edition === undefined ? undefined : XIRP_SCHEMES[edition]
  const id = tmuxSession === null ? undefined : XIRP_SESSION.exec(tmuxSession)?.[1]
  return scheme && id ? `${scheme}://launch?action=open-session&sessionId=${id}` : null
}

async function openLink($: EngineInterface, link: string) {
  try {
    const r = await $.process.run(['open', link], { timeoutMs: 5000 })
    if (r.exitCode === 0) return
  } catch {
    // Falls through to the toast.
  }
  $.ui.toast('Could not open the session in Xirp')
}

// Whether this tmux server has `pane` in `session`. A tmux that fails, or does not answer in time, says no.
async function inSession($: EngineInterface, pane: string, session: string): Promise<boolean> {
  try {
    const r = await $.process.run(['tmux', 'display-message', '-p', '-t', pane, '#{session_name}'], { timeoutMs: 2000 })
    return r.exitCode === 0 && r.stdout.replace(/\n$/, '') === session
  } catch {
    return false
  }
}

// Opens the building in the browser with `hopper-hq up`, which starts the daemon in the background when it is not
// running. Resolves what to tell the person, or null when hopper-hq could not start. Never the sign-in link up prints:
// a command's output is in the transcript, and the transcript reaches the model.
async function openBuilding($: EngineInterface): Promise<string | null> {
  let r: ProcessRunResult
  const startedAt = await $.clock.now()
  try {
    r = await $.process.run(['hopper-hq', 'up'], { timeoutMs: UP_TIMEOUT_MS })
  } catch {
    // The run rejects both when the binary cannot start and when it is still running at the timeout.
    return (await $.clock.now()) - startedAt >= UP_TIMEOUT_MS - TIMEOUT_MARGIN_MS ? `hopper-hq up did not finish in ${UP_TIMEOUT_MS / 1000} seconds.` : null
  }
  if (r.exitCode === 0) return 'Opened the building in your browser.'
  const why = r.stderr.replace(CONTROL, '').trim().slice(0, 2000)
  return why ? `hopper-hq could not open the building:\n${why}` : 'hopper-hq could not open the building.'
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    sessionCwd = e.cwd
    // Read once, as the session starts: the summarizer's own runs never post, never poll and draw nothing.
    summarizer = await $.env.get('HOPPER_HQ_SUMMARIZER').then(v => v !== undefined, () => false)
    if (!summarizer) {
      $.clock.every(FLUSH_MS, () => void flush($))
      $.clock.every(POLL_MS, () => void poll($))
    }
    try {
      await $.command.register({
        name: 'hopper-hq',
        description: 'Open the hopper-hq building in your browser, starting its daemon if needed',
        immediate: true,
      })
    } catch {
      // A host with no commands still gets the rest.
    }
    return next(e)
  })

  // /hopper-hq answers itself: no model turn, and nothing it could refuse.
  on('command.run', { command: 'hopper-hq' }, async $ => {
    const said = await openBuilding($)
    if (said === null) $.ui.toast(NOT_INSTALLED)
    return { text: said ?? `${NOT_INSTALLED}.` }
  }).catch(() => ({ text: 'hopper-hq could not open the building.' }))

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
    // A workflow script's agent names its run: the daemon seats it in that run's room.
    if (spawned.agentId) {
      await enqueue($, { hook_event_name: 'SubagentStart', agent_id: spawned.agentId, agent_type: e.subagentType, description: e.description, workflow_run_id: e.workflow?.runId || undefined })
    }
    return spawned
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    // A subagent's turn end names it; the main loop's carries its final reply.
    await enqueue($, { hook_event_name: 'Stop', background_tasks: 0, agent_id: e.agentId, last_assistant_message: e.agentId ? undefined : e.answer })
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await enqueue($, { hook_event_name: 'SessionEnd', reason: e.reason })
    // Not behind a batch still in flight: the exit's time is short, and the daemon orders events by their own time.
    await send($)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const a = await read($, attention)
    if (summarizer || e.props.hasSurvey || !a) return next(e)
    const own = await $.session.id()
    const waiting = a.items.filter(i => i.state === 'needs_you' && i.id !== own)
    const done = a.items.filter(i => i.state === 'done' && i.id !== own).length
    if (waiting.length === 0 && done === 0) return next(e)
    const inTmux = (await $.env.get('TMUX')) !== undefined
    // Inside Xirp, Go is the app's focus; a tmux switch there would take over this session's tab.
    const inXirp = (await $.env.get('CHIRP_SESSION_ID')) !== undefined
    const edition = await $.env.get('CHIRP_EDITION')
    const first = waiting[0]
    const pane = first?.tmuxPane ?? null
    const session = first?.tmuxSession ?? null
    const link = inXirp ? xirpLink(edition, session) : null
    const canJump = inXirp ? link !== null : pane !== null && inTmux
    const { Box, Button, Text } = $.ui.resolve(e)
    return (
      <Box>
        {first ? <Text color="red">◉ {waiting.length} waiting · {first.name ?? first.repo}: {first.reason?.text ?? 'needs you'} </Text> : null}
        {canJump ? <Button key="go" label="Go" onPress={() => (link ? openLink($, link) : jump($, pane!, session))} /> : null}
        {done > 0 ? <Text color="green"> ✓ {done} done</Text> : null}
        <Button key="building" label="Open building" onPress={async () => $.ui.toast((await openBuilding($)) ?? NOT_INSTALLED)} />
      </Box>
    )
  })
}

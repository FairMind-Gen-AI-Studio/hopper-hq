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
  if (value === null || typeof value !== 'object') return value
  if (depth > 3) return '[…]'
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
  // Retry only what can succeed later: no daemon, a stale token, a server error. A refused batch is dropped.
  if (!r || r.status === 401 || r.status >= 500) queue.unshift(...batch.slice(-(MAX_QUEUE - queue.length)))
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

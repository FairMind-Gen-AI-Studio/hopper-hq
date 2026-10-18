import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

type Post = { url: string; body: Record<string, any>[]; auth: string | undefined }

function daemon(on: On, posts: Post[]) {
  mock.env(on, { HOME: '/home/dev' })
  on('session.start', async ($, e) => ({ cwd: e.cwd }))
  on('session.id', async () => ({ value: 'S-OWN' }))
  on('fs.read', async ($, e, next) =>
    e.path === '/home/dev/.hopper-hq/daemon.json' ? { value: JSON.stringify({ port: 7337, token: 'tok' }) } : next(e),
  )
  on('http.fetch', async ($, e) => {
    if (e.init?.method === 'POST') posts.push({ url: e.url, body: JSON.parse(e.init.body ?? '[]'), auth: e.init.headers?.authorization })
    return { value: { status: e.init?.method === 'POST' ? 204 : 200, ok: true, headers: {}, text: '{"needsYou":0,"done":0,"items":[]}' } }
  })
}

const START = { cwd: '/home/dev/shop', surface: null, isInteractive: true } as const
const SPAWN = {
  tool_use_id: 'toolu_05ABCDEFGHIJKLMNOPQRSTUV',
  prompt: 'Find every caller of useCart.',
  description: 'Find callers',
  subagentType: 'Explore',
  provider: { plugin: 'engine', tier: 'core' },
  parentModel: 'claude-opus-5-5',
  background: true,
  fork: false,
} as const
const BAND = { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 100, scroll: { offset: 0, bodyRows: 5 }, view: {}, title: '', isFocused: false }
const TYPED = { command: 'hopper-hq', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as const

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
  expect(typeof batch[0]?._hopper_ts).toBe('number')
})

test("forwards nothing and draws no band in the summarizer's own session, and still answers /hopper-hq", async ($, on) => {
  const fetched: string[] = []
  const ran: string[][] = []
  mock.env(on, { HOME: '/home/dev', HOPPER_HQ_SUMMARIZER: '1' })
  const clock = mock.clock(on)
  on('session.start', async ($, e) => ({ cwd: e.cwd }))
  on('session.id', async () => ({ value: 'S-OWN' }))
  on('fs.read', async () => ({ value: JSON.stringify({ port: 7337, token: 'tok' }) }))
  on('http.fetch', async ($, e) => {
    fetched.push(`${e.init?.method ?? 'GET'} ${e.url}`)
    return { value: { status: 200, ok: true, headers: {}, text: '{"needsYou":1,"done":0,"items":[{"id":"S2","name":"orders-api-c3","repo":"orders-api","state":"needs_you","since":2,"reason":{"kind":"permission","text":"Bash"},"title":null,"tmuxPane":null}]}' } }
  })
  on('process.run', async ($, e) => {
    ran.push([...e.argv])
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('command.register', async ($, e) => ({ value: { command: e.name } }))
  on('prompt.submit', async ($, e) => ({ text: e.text }))
  on('tool.call', async () => ({ result: 'file-a' }))
  on('turn.complete', async ($, e) => ({ text: e.answer }))
  on('session.end', async ($, e) => ({ sessionId: e.sessionId }))
  on('ui.render', async () => ({ type: 'Box', children: [] }))

  await $.session.start(START)
  await $.prompt.submit({ text: 'Write one status line', wait: false, origin: { kind: 'composer' } })
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await $.turn.complete({ reason: 'answer', answer: 'Tests pass; ready to merge.', durationMs: 800, isAborted: false, turnId: 't1' })
  await clock.advance(5000)
  const ui = await $.ui.mount({ plugin: 'hopper-hq', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await ui.find({ type: 'Text' })).toBeUndefined()
  await ui.unmount()
  expect(await $.command.run(TYPED)).toEqual({ text: 'Opened the building in your browser.' })
  await $.session.end({ reason: 'other', sessionId: 'S-OWN', resume: { id: 'S-OWN' } })

  expect(fetched).toEqual([])
  expect(ran).toEqual([['hopper-hq', 'up']])
})

test("posts nothing from the summarizer's own session, even what it queued before it knew", async ($, on) => {
  const fetched: string[] = []
  let release!: () => void
  const known = new Promise<void>(resolve => (release = resolve))
  // The session starts reading its environment; a prompt comes before the answer does.
  on('env.get', async ($, e) => {
    if (e.name === 'HOPPER_HQ_SUMMARIZER') await known
    return { value: ({ HOME: '/home/dev', HOPPER_HQ_SUMMARIZER: '1' } as Record<string, string>)[e.name] }
  })
  mock.clock(on)
  on('session.start', async ($, e) => ({ cwd: e.cwd }))
  on('session.id', async () => ({ value: 'S-OWN' }))
  on('fs.read', async () => ({ value: JSON.stringify({ port: 7337, token: 'tok' }) }))
  on('http.fetch', async ($, e) => {
    fetched.push(`${e.init?.method ?? 'GET'} ${e.url}`)
    return { value: { status: 204, ok: true, headers: {}, text: '' } }
  })
  on('prompt.submit', async ($, e) => ({ text: e.text }))
  on('session.end', async ($, e) => ({ sessionId: e.sessionId }))

  const started = $.session.start(START)
  await $.prompt.submit({ text: 'Write one status line', wait: false, origin: { kind: 'composer' } })
  release()
  await started
  await $.session.end({ reason: 'other', sessionId: 'S-OWN', resume: { id: 'S-OWN' } })

  expect(fetched).toEqual([])
})

test('forwards what a spawn says of its task, and the workflow run of a script agent', async ($, on) => {
  const posts: Post[] = []
  daemon(on, posts)
  const clock = mock.clock(on)
  on('agent.spawn', async ($, e) => ({ model: 'haiku', agentId: e.workflow ? `a7c41e09b2d35f68${e.workflow.agentIndex}` : 'a58cb74ebedcc3070' }))

  await $.session.start(START)
  await $.agent.spawn(SPAWN)
  await $.agent.spawn({ ...SPAWN, description: 'plan:orders-api', subagentType: 'workflow-subagent', workflow: { runId: 'wf_0000aaaa-001', agentIndex: 1 } })
  await $.agent.spawn({ ...SPAWN, description: 'outside a run', subagentType: 'workflow-subagent', workflow: { runId: '', agentIndex: 2 } })
  await clock.advance(600)

  const batch = posts[0]?.body ?? []
  expect(batch.map(b => b.hook_event_name)).toEqual(['SubagentStart', 'SubagentStart', 'SubagentStart'])
  expect(batch[0]).toMatchObject({ agent_id: 'a58cb74ebedcc3070', agent_type: 'Explore', description: 'Find callers' })
  expect(batch[1]).toMatchObject({ agent_id: 'a7c41e09b2d35f681', agent_type: 'workflow-subagent', description: 'plan:orders-api', workflow_run_id: 'wf_0000aaaa-001' })
  expect(['workflow_run_id' in (batch[0] ?? {}), 'workflow_run_id' in (batch[2] ?? {})]).toEqual([false, false])
})

test("sends the main loop's final reply up to 2000 code units, while every other text stays cut at 400", async ($, on) => {
  const posts: Post[] = []
  daemon(on, posts)
  const clock = mock.clock(on)
  on('prompt.submit', async ($, e) => ({ text: e.text }))
  on('turn.complete', async ($, e) => ({ text: e.answer }))

  await $.session.start(START)
  await $.prompt.submit({ text: 'p'.repeat(1000), wait: false, origin: { kind: 'composer' } })
  await $.turn.complete({ reason: 'answer', answer: 'r'.repeat(1500), durationMs: 900, isAborted: false, turnId: 't2', agentId: 'a58cb74ebedcc3070' })
  await $.turn.complete({ reason: 'answer', answer: 'a'.repeat(2500), durationMs: 1000, isAborted: false, turnId: 't1' })
  await clock.advance(600)

  const batch = posts[0]?.body ?? []
  expect(batch.map(b => b.hook_event_name)).toEqual(['UserPromptSubmit', 'Stop', 'Stop'])
  expect(batch[0]?.prompt).toBe('p'.repeat(400))
  expect('last_assistant_message' in (batch[1] ?? {})).toBe(false)
  expect(batch[2]?.last_assistant_message).toBe('a'.repeat(2000))
})

test('tells the end of a subagent turn from the end of the session turn', async ($, on) => {
  const posts: Post[] = []
  daemon(on, posts)
  const clock = mock.clock(on)
  on('turn.complete', async ($, e) => ({ text: e.answer }))

  await $.session.start(START)
  await $.turn.complete({ reason: 'answer', answer: 'found 3 callers', durationMs: 900, isAborted: false, turnId: 't2', agentId: 'a58cb74ebedcc3070' })
  await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't1' })
  await clock.advance(600)

  const batch = posts[0]?.body ?? []
  expect(batch.map(b => b.hook_event_name)).toEqual(['Stop', 'Stop'])
  expect(batch[0]).toMatchObject({ agent_id: 'a58cb74ebedcc3070', background_tasks: 0 })
  expect('agent_id' in (batch[1] ?? {})).toBe(false)
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

test('drops a batch the daemon refuses instead of resending it forever', async ($, on) => {
  mock.env(on, { HOME: '/home/dev' })
  const clock = mock.clock(on)
  let posts = 0
  on('session.start', async ($, e) => ({ cwd: e.cwd }))
  on('session.id', async () => ({ value: 'S-OWN' }))
  on('fs.read', async () => ({ value: JSON.stringify({ port: 7337, token: 'tok' }) }))
  on('http.fetch', async ($, e) => {
    if (e.init?.method === 'POST') posts += 1
    return { value: { status: e.init?.method === 'POST' ? 413 : 200, ok: e.init?.method !== 'POST', headers: {}, text: '{"needsYou":0,"done":0,"items":[]}' } }
  })
  on('prompt.submit', async ($, e) => ({ text: e.text }))

  await $.session.start(START)
  await $.prompt.submit({ text: 'x'.repeat(10), wait: false, origin: { kind: 'composer' } })
  await clock.advance(600)
  await clock.advance(2000)
  expect(posts).toBe(1)
})

test('keeps one request of each kind in flight while the daemon does not answer', async ($, on) => {
  mock.env(on, { HOME: '/home/dev' })
  const clock = mock.clock(on)
  const open: Record<string, number> = {}
  const most: Record<string, number> = {}
  const held: (() => void)[] = []
  const prompts: unknown[][] = []
  on('session.start', async ($, e) => ({ cwd: e.cwd }))
  on('session.id', async () => ({ value: 'S-OWN' }))
  on('fs.read', async () => ({ value: JSON.stringify({ port: 7337, token: 'tok' }) }))
  on('http.fetch', async ($, e) => {
    const path = e.url.slice(e.url.indexOf('/api/'))
    if (e.init?.method === 'POST') prompts.push(JSON.parse(e.init.body ?? '[]').map((b: Record<string, unknown>) => b.prompt))
    open[path] = (open[path] ?? 0) + 1
    most[path] = Math.max(most[path] ?? 0, open[path] ?? 0)
    await new Promise<void>(resolve => held.push(resolve))
    open[path] = (open[path] ?? 1) - 1
    return { value: { status: e.init?.method === 'POST' ? 204 : 200, ok: true, headers: {}, text: '{"needsYou":0,"done":0,"items":[]}' } }
  })
  on('prompt.submit', async ($, e) => ({ text: e.text }))

  await $.session.start(START)
  for (let i = 1; i <= 30; i++) {
    await $.prompt.submit({ text: `p${i}`, wait: false, origin: { kind: 'composer' } })
    await clock.advance(1000)
  }
  expect(most).toEqual({ '/api/hooks': 1, '/api/attention': 1 })
  expect(prompts).toEqual([['p1']])

  for (const release of held.splice(0)) release()
  await clock.advance(600)
  expect(prompts).toEqual([['p1'], Array.from({ length: 29 }, (_, i) => `p${i + 2}`)])
  for (const release of held.splice(0)) release()
})

test('sends the rest at session end without waiting for a batch still in flight', async ($, on) => {
  mock.env(on, { HOME: '/home/dev' })
  const clock = mock.clock(on)
  const held: (() => void)[] = []
  const posted: unknown[][] = []
  on('session.start', async ($, e) => ({ cwd: e.cwd }))
  on('session.id', async () => ({ value: 'S-OWN' }))
  on('fs.read', async () => ({ value: JSON.stringify({ port: 7337, token: 'tok' }) }))
  on('http.fetch', async ($, e) => {
    if (e.init?.method === 'POST') {
      posted.push(JSON.parse(e.init.body ?? '[]').map((b: Record<string, unknown>) => b.hook_event_name))
      if (posted.length === 1) await new Promise<void>(resolve => held.push(resolve))
    }
    return { value: { status: e.init?.method === 'POST' ? 204 : 200, ok: true, headers: {}, text: '{"needsYou":0,"done":0,"items":[]}' } }
  })
  on('prompt.submit', async ($, e) => ({ text: e.text }))
  on('session.end', async ($, e) => ({ sessionId: e.sessionId }))

  await $.session.start(START)
  await $.prompt.submit({ text: 'one', wait: false, origin: { kind: 'composer' } })
  await clock.advance(600)
  await $.prompt.submit({ text: 'two', wait: false, origin: { kind: 'composer' } })
  await clock.advance(600)
  await $.session.end({ reason: 'other', sessionId: 'S-OWN', resume: { id: 'S-OWN' } })

  expect(posted).toEqual([['UserPromptSubmit'], ['UserPromptSubmit', 'SessionEnd']])
  for (const release of held.splice(0)) release()
})

test('keeps the queue bounded when a batch fails after a long wait', async ($, on) => {
  mock.env(on, { HOME: '/home/dev' })
  const clock = mock.clock(on)
  const held: (() => void)[] = []
  const sizes: number[] = []
  on('session.start', async ($, e) => ({ cwd: e.cwd }))
  on('session.id', async () => ({ value: 'S-OWN' }))
  on('fs.read', async () => ({ value: JSON.stringify({ port: 7337, token: 'tok' }) }))
  on('http.fetch', async ($, e) => {
    if (e.init?.method !== 'POST') return { value: { status: 200, ok: true, headers: {}, text: '{"needsYou":0,"done":0,"items":[]}' } }
    sizes.push(JSON.parse(e.init.body ?? '[]').length)
    if (sizes.length === 1) await new Promise<void>(resolve => held.push(resolve))
    return { value: { status: 503, ok: false, headers: {}, text: '' } }
  })
  on('prompt.submit', async ($, e) => ({ text: e.text }))

  await $.session.start(START)
  await $.prompt.submit({ text: 'first', wait: false, origin: { kind: 'composer' } })
  await clock.advance(600)
  for (let i = 0; i < 500; i++) await $.prompt.submit({ text: `p${i}`, wait: false, origin: { kind: 'composer' } })
  for (const release of held.splice(0)) release()
  await clock.advance(600)

  expect(sizes).toEqual([1, 500])
})

test('locates the Windows daemon through USERPROFILE when HOME is absent', async ($, on) => {
  const posts: Post[] = []
  on('env.get', async ($, e) => ({ value: e.name === 'USERPROFILE' ? 'C:\\Users\\Dev' : undefined }))
  on('session.start', async ($, e) => ({ cwd: e.cwd }))
  on('session.id', async () => ({ value: 'windows-own' }))
  on('fs.read', async ($, e, next) => e.path.endsWith('C:\\Users\\Dev/.hopper-hq/daemon.json') ? { value: JSON.stringify({ port: 7337, token: 'tok' }) } : next(e))
  on('http.fetch', async ($, e) => {
    if (e.init?.method === 'POST') posts.push({ url: e.url, body: JSON.parse(e.init.body ?? '[]'), auth: e.init.headers?.authorization })
    return { value: { status: 204, ok: true, headers: {}, text: '' } }
  })
  on('prompt.submit', async ($, e) => ({ text: e.text }))
  const clock = mock.clock(on)
  await $.session.start({ ...START, cwd: 'C:\\work\\api' })
  await $.prompt.submit({ text: 'hello', wait: false, origin: { kind: 'composer' } })
  await clock.advance(600)
  expect(posts).toHaveLength(1)
  expect(posts[0]?.body[0]).toMatchObject({ session_id: 'windows-own', prompt: 'hello' })
})

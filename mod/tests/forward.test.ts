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

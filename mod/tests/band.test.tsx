import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const ATTENTION = {
  needsYou: 2,
  done: 1,
  items: [
    { id: 'S-OWN', name: 'me', repo: 'shop', state: 'needs_you', since: 1, reason: { kind: 'question', text: 'mine' }, title: null, tmuxPane: '%1' },
    { id: 'S2', name: 'orders-api-c3', repo: 'orders-api', state: 'needs_you', since: 2, reason: { kind: 'permission', text: 'Bash' }, title: null, tmuxPane: '%7', tmuxSession: 'work' },
    { id: 'S3', name: 'storefront-web-b2', repo: 'storefront-web', state: 'done', since: 3, reason: null, title: 'Copy', tmuxPane: null },
  ],
}
const NOBODY = { needsYou: 0, done: 0, items: [] }
const BAND = { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 100, scroll: { offset: 0, bodyRows: 5 }, view: {}, title: '', isFocused: false }
const START = { cwd: '/home/dev/shop', surface: null, isInteractive: true } as const
const IN_TMUX = { HOME: '/home/dev', TMUX: '/tmp/tmux-501/default,1,0' }
const ASK = ['tmux', 'display-message', '-p', '-t', '%7', '#{session_name}']
const OTHER = 'The pane is on another tmux server or session'

// `tmux.owner`: the tmux session this server's %7 is in; null when this server has no %7.
function daemon(on: On, attention: object, env: Record<string, string>, ran: string[][], tmux: { owner: string | null } = { owner: 'work' }, upFails?: () => Promise<void>) {
  mock.env(on, env)
  on('session.start', async ($, e) => ({ cwd: e.cwd }))
  on('session.id', async () => ({ value: 'S-OWN' }))
  on('fs.read', async () => ({ value: JSON.stringify({ port: 7337, token: 'tok' }) }))
  on('http.fetch', async () => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(attention) } }))
  on('process.run', async ($, e) => {
    ran.push([...e.argv])
    if (upFails && e.argv[1] === 'up') {
      await upFails()
      throw new Error('timed out')
    }
    const asked = e.argv[1] === 'display-message'
    const out = !asked ? { exitCode: 0, stdout: '' } : tmux.owner === null ? { exitCode: 1, stdout: '' } : { exitCode: 0, stdout: `${tmux.owner}\n` }
    return { value: { ...out, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
}

test('shows who else is waiting and jumps to their tmux pane', async ($, on) => {
  const ran: string[][] = []
  daemon(on, ATTENTION, IN_TMUX, ran)
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
  expect(ran.slice(0, 4)).toEqual([
    ASK,
    ['tmux', 'switch-client', '-t', '%7'],
    ['tmux', 'select-window', '-t', '%7'],
    ['tmux', 'select-pane', '-t', '%7'],
  ])
})

test('stays put, and says so, when that pane is in another tmux session or not on this server', async ($, on) => {
  const ran: string[][] = []
  const toasts: string[] = []
  const tmux = { owner: 'other' as string | null }
  daemon(on, ATTENTION, IN_TMUX, ran, tmux)
  on('ui.toast', async ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  const clock = mock.clock(on)
  await $.session.start(START)
  await clock.advance(3100)
  const ui = await $.ui.mount({ plugin: 'scranton-hq', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  await ui.press({ key: 'go' })
  tmux.owner = null
  await ui.press({ key: 'go' })
  await ui.unmount()
  expect(ran).toEqual([ASK, ASK])
  expect(toasts).toEqual([OTHER, OTHER])
})

test('jumps without asking tmux when the daemon does not say which tmux session the pane is in', async ($, on) => {
  const ran: string[][] = []
  const older = { ...ATTENTION, items: ATTENTION.items.map(({ tmuxSession, ...item }) => item) }
  daemon(on, older, IN_TMUX, ran)
  const clock = mock.clock(on)
  await $.session.start(START)
  await clock.advance(3100)
  const ui = await $.ui.mount({ plugin: 'scranton-hq', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  await ui.press({ key: 'go' })
  await ui.unmount()
  expect(ran).toEqual([
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

test('opens the building from the band, in tmux or not, and says how it went', async ($, on) => {
  const ran: string[][] = []
  const toasts: string[] = []
  daemon(on, ATTENTION, { HOME: '/home/dev' }, ran)
  on('ui.toast', async ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  const clock = mock.clock(on)
  await $.session.start(START)
  await clock.advance(3100)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'scranton-hq', surface, component: 'AbovePrompt', props: BAND })
    await ui.press({ key: 'building' })
    await ui.unmount()
  }
  expect(ran).toEqual([['scranton-hq', 'up'], ['scranton-hq', 'up']])
  expect(toasts).toEqual(['Opened the building in your browser.', 'Opened the building in your browser.'])
})

test('says up did not finish when the band\'s button waited out the timeout', async ($, on) => {
  const toasts: string[] = []
  let clock!: ReturnType<typeof mock.clock>
  daemon(on, ATTENTION, { HOME: '/home/dev' }, [], { owner: 'work' }, () => clock.advance(30000))
  on('ui.toast', async ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  clock = mock.clock(on)
  await $.session.start(START)
  await clock.advance(3100)
  const ui = await $.ui.mount({ plugin: 'scranton-hq', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  await ui.press({ key: 'building' })
  await ui.unmount()
  expect(toasts).toEqual(['scranton-hq up did not finish in 30 seconds.'])
})

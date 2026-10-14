import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const START = { cwd: '/home/dev/shop', surface: null, isInteractive: true } as const
const NOT_INSTALLED = 'hopper-hq is not installed, or not on your PATH'
const LINK = `http://127.0.0.1:7337/ui/login?code=${'a'.repeat(48)}`
const OPENED = { exitCode: 0, stdout: `${LINK}\n`, stderr: 'This link signs your browser in. It works once, within 1 minute:\n' }
// The person types /hopper-hq and presses Enter.
const TYPED = { command: 'hopper-hq', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as const

type Up = { exitCode: number; stdout: string; stderr: string }

// The host as the command meets it. Nothing runs for real: `hopper-hq up` answers `up`, or cannot start when it is null.
function host(on: On, up: Up | null, failAfterMs = 0) {
  const ran: { argv: string[]; timeoutMs?: number }[] = []
  const toasts: string[] = []
  const specs: unknown[] = []
  mock.env(on, { HOME: '/home/dev' })
  const clock = mock.clock(on)
  on('session.start', async ($, e) => ({ cwd: e.cwd }))
  on('command.register', async ($, e) => {
    specs.push(e)
    return { value: { command: e.name } }
  })
  on('ui.toast', async ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('process.run', async ($, e) => {
    ran.push({ argv: [...e.argv], timeoutMs: e.init?.timeoutMs })
    if (!up) {
      await clock.advance(failAfterMs)
      throw new Error(failAfterMs > 0 ? 'timed out' : 'spawn hopper-hq ENOENT')
    }
    return { value: { ...up, isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return { ran, toasts, specs }
}

test('registers /hopper-hq when the session starts, to run even while a turn does', async ($, on) => {
  const h = host(on, OPENED)
  await $.session.start(START)
  expect(h.specs).toEqual([{ name: 'hopper-hq', description: 'Open the hopper-hq building in your browser, starting its daemon if needed', immediate: true }])
  expect(h.ran).toEqual([])
})

test('opens the building with hopper-hq up, and keeps the sign-in link out of the transcript', async ($, on) => {
  const h = host(on, OPENED)
  await $.session.start(START)
  const r = await $.command.run(TYPED)
  expect(r).toEqual({ text: 'Opened the building in your browser.' })
  expect(h.ran).toEqual([{ argv: ['hopper-hq', 'up'], timeoutMs: 30000 }])
  expect(h.toasts).toEqual([])
})

test('says why when up could not open it', async ($, on) => {
  const stderr = 'hopper-hq stopped while starting.\n  Port 7337 is already in use.\u001b[31m\nIts log is /home/dev/.hopper-hq/daemon.log\n'
  const h = host(on, { exitCode: 1, stdout: '', stderr })
  await $.session.start(START)
  const r = await $.command.run(TYPED)
  expect(r.text).toBe('hopper-hq could not open the building:\nhopper-hq stopped while starting.\n  Port 7337 is already in use.[31m\nIts log is /home/dev/.hopper-hq/daemon.log')
  expect(h.toasts).toEqual([])
})

test('says so, in a toast too, when hopper-hq cannot run', async ($, on) => {
  const h = host(on, null)
  await $.session.start(START)
  const r = await $.command.run(TYPED)
  expect(r.text).toBe(`${NOT_INSTALLED}.`)
  expect(h.toasts).toEqual([NOT_INSTALLED])
})

test('says up did not finish, not that hopper-hq is missing, when it was still running at the timeout', async ($, on) => {
  const h = host(on, null, 30000)
  await $.session.start(START)
  const r = await $.command.run(TYPED)
  expect(r.text).toBe('hopper-hq up did not finish in 30 seconds.')
  expect(h.toasts).toEqual([])
})

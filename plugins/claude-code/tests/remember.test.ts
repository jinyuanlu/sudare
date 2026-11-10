import { expect, test } from 'claude-code/testing'

const BAND = {
  plugin: 'sudare', component: 'AbovePrompt', requestId: 'band',
  props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 12, bodyColumns: 80, scroll: { offset: 0, bodyRows: 12 }, view: {} },
} as const
const KEPT = { secret: 'sds_kept', expires: 4_000_000_000_000, server: 'https://sudare.test' }

const engine = (on: Parameters<Parameters<typeof test>[2]>[1], seen: { deleted: number; bearer: string[] }) => {
  on('command.register', () => ({ value: { command: 'sudare' } }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 1_000 }))
  on('ui.status', () => ({ value: undefined }))
  on('store.get', () => ({ value: KEPT }))
  on('store.delete', () => {
    seen.deleted += 1
    return { value: undefined }
  })
  on('http.fetch', (_, e) => {
    seen.bearer.push(JSON.stringify(e))
    return { value: { status: 200, ok: true, headers: {}, text: '[]' } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
}

test('remember off (the default): a kept sign-in is deleted, never used', { options: { server: 'https://sudare.test', humanSession: 'on', rememberSignIn: 'off' } }, async ($, on) => {
  const seen = { deleted: 0, bearer: [] as string[] }
  engine(on, seen)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(seen.deleted).toBeGreaterThan(0)
  expect(seen.bearer.some((b) => b.includes('sds_kept'))).toBe(false)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ key: 'signin' })).toBeDefined()
  await ui.unmount()
})

test('remember on: the kept sign-in is picked up at start, for this server only', { options: { server: 'https://sudare.test', humanSession: 'on', rememberSignIn: 'on' } }, async ($, on) => {
  const seen = { deleted: 0, bearer: [] as string[] }
  engine(on, seen)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(seen.bearer.some((b) => b.includes('Bearer sds_kept'))).toBe(true)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ key: 'signin' })).toBeUndefined()
  await ui.unmount()
})

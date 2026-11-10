import { expect, test } from 'claude-code/testing'

const OPTIONS = { options: { server: 'https://sudare.test', humanSession: 'on' } }
const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const

const BAND = { plugin: 'sudare', component: 'AbovePrompt', requestId: 'band', props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 12, bodyColumns: 80, scroll: { offset: 0, bodyRows: 12 }, view: {} } } as const
const PANE = {
  plugin: 'sudare', component: 'Pane', requestId: 'sudare',
  props: { title: 'Sudare', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

const STATE: Record<string, unknown> = {
  isSignedIn: true,
  current: 'c1',
  link: null,
  notice: null,
  snapshot: {
    convs: [{ id: 'c1', topic: 'Cache plan', unread: 2, pending: 1, round: 'r1' }],
    inbox: [{ msg: 'm1', conv: 'c1', topic: 'Cache plan', from: 'fox', text: 'what TTL?', state: 'unread' }],
    drafts: [{ id: 'f1', topic: 'Cache plan', kind: 'message', text: 'Five minutes.', device: 'laptop', status: 'pending' }],
    invites: [{ id: 'i1', topic: 'Lunch', by: 'owl', members: 3 }],
    seats: [{ round: 'r1', conv: 'c1', topic: 'Cache plan', goal: 'Agree on a TTL', isSeated: false }],
    at: 1,
  },
  target: 'fox',
  timeline: {
    conv: 'c1', topic: 'Cache plan', me: 'ann', others: [{ handle: 'fox', alias: 'a1', isHere: true }, { handle: 'owl', alias: 'a2', isHere: false }],
    lines: [
      { id: 'e1', from: 'fox', text: 'what TTL?', via: 'human', isMine: false },
      { id: 'e2', from: 'ann', text: 'Five minutes.', via: 'delegate', isMine: true },
    ],
  },
}

test('signed out: the band offers one button, on every surface', OPTIONS, async ($) => {
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ key: 'signin' })).toBeDefined()
    await ui.unmount()
  }
})

test('signed in: the band shows what is waiting and the panel shows the conversation', OPTIONS, async ($, on) => {
  on('state.get', (_, e) => ({ value: { value: STATE[e.key], version: 1 } }))
  for (const surface of SURFACES) {
    const band = await $.ui.mount({ ...BAND, surface })
    for (const key of ['reply', 'agent', 'approve', 'reject', 'join', 'seat']) expect(await band.find({ key })).toBeDefined()
    await band.unmount()

    const pane = await $.ui.mount({ ...PANE, surface })
    expect((await pane.find({ type: 'Text', text: /what TTL\?/ }))).toBeDefined()
    expect((await pane.find({ type: 'Text', text: /via agent/ }))).toBeDefined()
    for (const key of ['invite', 'refresh', 'web', 'signout', 'to-all', 'to-fox', 'to-owl', 'private']) expect(await pane.find({ key })).toBeDefined()
    await pane.unmount()
  }
})

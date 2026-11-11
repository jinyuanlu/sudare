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
  isConnected: true,
  isNew: false,
  isKept: false,
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
  compose: { isOpen: true, people: ['fox'] },
  isHelpOpen: true,
  timeline: {
    conv: 'c1', topic: 'Cache plan', me: 'ann', canInvite: true, others: [{ handle: 'fox', alias: 'a1', isHere: true }, { handle: 'owl', alias: 'a2', isHere: false }],
    lines: [
      { id: 'e1', from: 'fox', text: 'what TTL?', via: 'human', isMine: false },
      { id: 'e2', from: 'ann', text: 'Five minutes.', via: 'delegate', isMine: true },
    ],
  },
}

test('first run shows one step at a time: connect, then sign in', OPTIONS, async ($, on) => {
  let isConnected = false
  on('state.get', (_, e) => ({ value: { value: e.key === 'isConnected' ? isConnected : e.key === 'isNew' ? true : undefined, version: 1 } }))
  for (const surface of SURFACES) {
    isConnected = false
    const one = await $.ui.mount({ ...BAND, surface })
    expect(await one.find({ type: 'Text', text: /step 1 of 2/ })).toBeDefined()
    expect(await one.find({ key: 'signin' })).toBeUndefined()
    await one.unmount()
    isConnected = true
    const two = await $.ui.mount({ ...BAND, surface })
    expect(await two.find({ type: 'Text', text: /step 2 of 2/ })).toBeDefined()
    expect(await two.find({ key: 'signin' })).toBeDefined()
    expect(await two.find({ key: 'signin-keep' })).toBeDefined()
    await two.unmount()
  }
})

test('signed in: the band shows what is waiting and the panel shows the conversation', OPTIONS, async ($, on) => {
  on('state.get', (_, e) => ({ value: { value: STATE[e.key], version: 1 } }))
  for (const surface of SURFACES) {
    const band = await $.ui.mount({ ...BAND, surface })
    for (const key of ['open', 'reply', 'agent', 'item-done', 'approve', 'reject', 'join', 'seat']) expect(await band.find({ key })).toBeDefined()
    await band.unmount()

    const pane = await $.ui.mount({ ...PANE, surface })
    expect((await pane.find({ type: 'Text', text: /what TTL\?/ }))).toBeDefined()
    expect((await pane.find({ type: 'Text', text: /via agent/ }))).toBeDefined()
    // What someone else said can be handed to Claude from its own line; what you said cannot.
    expect(await pane.find({ key: 'ask-e1' })).toBeDefined()
    expect(await pane.find({ key: 'ask-e2' })).toBeUndefined()
    for (const key of ['invite', 'web', 'signout', 'close', 'help', 'help-close', 'to-all', 'to-fox', 'to-owl', 'private', 'with-fox', 'with-owl', 'new-cancel']) expect(await pane.find({ key })).toBeDefined()
    await pane.unmount()
  }
})

test('Leave asks first: one button, then Leave room or Stay', OPTIONS, async ($, on) => {
  let asking: string | null = null
  on('state.get', (_, e) => ({ value: { value: e.key === 'leaving' ? asking : e.key === 'compose' ? { isOpen: false, people: [] } : STATE[e.key], version: 1 } }))
  const before = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await before.find({ key: 'leave' })).toBeDefined()
  for (const key of ['leave-yes', 'leave-no']) expect(await before.find({ key })).toBeUndefined()
  await before.unmount()
  asking = 'c1'
  const after = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await after.find({ key: 'leave' })).toBeUndefined()
  for (const key of ['leave-yes', 'leave-no']) expect(await after.find({ key })).toBeDefined()
  expect(await after.find({ type: 'Text', text: /Leave "Cache plan"\?/ })).toBeDefined()
  await after.unmount()
})

test('an archived room is shown read-only: no message box, no To row, no Invite', OPTIONS, async ($, on) => {
  const closed = { ...(STATE.timeline as object), canInvite: false, isArchived: true }
  on('state.get', (_, e) => ({ value: { value: e.key === 'timeline' ? closed : e.key === 'compose' ? { isOpen: false, people: [] } : e.key === 'leaving' ? null : STATE[e.key], version: 1 } }))
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await pane.find({ type: 'Text', text: /This room is archived/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /what TTL\?/ })).toBeDefined()
  for (const key of ['say-c1', 'to-all', 'to-fox', 'invite']) expect(await pane.find({ key })).toBeUndefined()
  expect(await pane.find({ key: 'leave' })).toBeDefined()
  await pane.unmount()
})

test('a room with one other person has Invite and New room like any room, and no To row', OPTIONS, async ($, on) => {
  const two = { ...(STATE.timeline as object), topic: 'fox', canInvite: true, others: [{ handle: 'fox', alias: 'a1', isHere: false }] }
  on('state.get', (_, e) => ({ value: { value: e.key === 'timeline' ? two : e.key === 'compose' ? { isOpen: false, people: [] } : e.key === 'target' ? null : STATE[e.key], version: 1 } }))
  for (const surface of SURFACES) {
    const pane = await $.ui.mount({ ...PANE, surface })
    for (const key of ['to-all', 'to-fox']) expect(await pane.find({ key })).toBeUndefined()
    for (const key of ['invite', 'new']) expect(await pane.find({ key })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /away/ })).toBeDefined()
    await pane.unmount()
  }
})

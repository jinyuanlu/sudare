import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { LIMITS, newEventId, type ConvEvent, type ConvId, type ConvView, type NoteView } from '@sudare/protocol'
import { describe, expect, it } from 'vitest'
import { ADMIN, ORIGIN, agentFor, bootstrap, codeOf, db, eventually, founder, invite, joinByLink, mcpClient, raw, type Person } from './harness'

const events = async (who: Person, conv: ConvId): Promise<ConvEvent[]> => (await who.get(`/convs/${conv}/events?limit=200`)).body.events ?? []
const messages = async (who: Person, conv: ConvId) =>
  (await events(who, conv)).flatMap((e) => (e.body.kind === 'message' ? [{ text: e.body.text, via: e.body.author.kind, id: e.id }] : []))
const view = async (who: Person, conv: ConvId) => (await who.get(`/convs/${conv}`)).body as unknown as ConvView
const aliasOf = async (who: Person, conv: ConvId, handle: string) => (await view(who, conv)).members.find((m) => m.handle === handle)!.alias
const pending = (who: Person) => eventually(async () => { const r = await who.get('/inbox'); return r.body.length ? (r.body as any[]) : null }, 'inbox item')

/** ann and bob in a two-person conversation; bob has a message from ann waiting. */
const pair = async () => {
  const { who: ann, conv } = await founder('ann')
  const bob = await invite(ann, conv, 'bob')
  const msg = await ann.send(conv, 'can you look at the cache plan?')
  await pending(bob)
  return { ann, bob, conv, msg }
}

describe('identity and joining', () => {
  it('has no registration without an invitation link, and a link registers exactly one person', async () => {
    const { who: ann, conv } = await founder()
    const refused = await ann.post('/auth/register/options', { code: 'x'.repeat(32) })
    expect(refused.body.error).toBe('invite_invalid')

    const link = (await ann.post(`/convs/${conv}/invites`, { link: true })).body.url as string
    await joinByLink('bob', link)
    const again = await ann.post('/auth/register/options', { code: codeOf(link) })
    expect(again.body.error).toBe('invite_invalid')
    expect((await raw(`/api/join/${codeOf(link)}/check`).then((r) => r.json<any>())).valid).toBe(false)
  })

  it('I11: an invitation link admits one person, once', async () => {
    const { who: ann, conv } = await founder()
    const cy = await invite(ann, conv, 'cy')
    const other = (await founder('dee')).who
    const link = (await ann.post(`/convs/${conv}/invites`, { link: true })).body.url as string
    expect((await cy.post(`/join/${codeOf(link)}/accept`, {})).body.error).toBe('already_member')
    expect((await other.post(`/join/${codeOf(link)}/accept`, {})).status).toBe(200)
    const third = (await founder('eve')).who
    expect((await third.post(`/join/${codeOf(link)}/accept`, {})).body.error).toBe('invite_invalid')
  })

  it('I12: a new member reads nothing from before they joined', async () => {
    const { who: ann, conv } = await founder()
    await ann.send(conv, 'said before bob arrived')
    const bob = await invite(ann, conv, 'bob')
    await ann.send(conv, 'said after')
    expect((await messages(bob, conv)).map((m) => m.text)).toEqual(['said after'])
    expect((await messages(ann, conv)).length).toBe(2)
    const early = await bob.get(`/convs/${conv}/events?after=0&limit=200`)
    expect((early.body.events as ConvEvent[]).every((e) => e.seq >= (early.body.events[0] as ConvEvent).seq)).toBe(true)
    expect(JSON.stringify(early.body)).not.toContain('said before')
  })

  it('never exposes who is behind an alias, and non-members see nothing', async () => {
    const { who: ann, conv } = await founder()
    const bob = await invite(ann, conv, 'bob')
    const stranger = (await founder('zed')).who
    expect((await stranger.get(`/convs/${conv}`)).body.error).toBe('not_member')
    expect((await stranger.get(`/convs/${conv}/events`)).body.error).toBe('not_member')
    const all = JSON.stringify([await view(bob, conv), await events(bob, conv), (await bob.get('/contacts')).body])
    expect(all).not.toMatch(/p_[0-9A-Z]{26}/)
    expect(all).not.toMatch(/d_[0-9A-Z]{26}/)
  })

  it('joins people directly when the audience does not grow, and invites them when it does', async () => {
    const { who: ann, conv } = await founder()
    const bob = await invite(ann, conv, 'bob')
    const cy = await invite(ann, conv, 'cy')
    const bobRef = { conv, alias: await aliasOf(ann, conv, 'bob') }

    const fork = await ann.post('/convs', { topic: 'Side topic', parent: conv, members: [bobRef] })
    expect(fork.body).toMatchObject({ joined: 1, invited: 0 })
    await eventually(async () => (await bob.convs()).some((c) => c.id === fork.body.conv), 'bob sees the fork')
    expect((await view(bob, fork.body.conv)).members.map((m) => m.handle).sort()).toEqual(['ann', 'bob'])

    // dee has only met ann, in another conversation: bringing her into a fork of `conv` needs her consent.
    const elsewhere = (await ann.post('/convs', { topic: 'Elsewhere' })).body.conv as ConvId
    const dee = await invite(ann, elsewhere, 'dee')
    const deeRef = { conv: elsewhere, alias: await aliasOf(ann, elsewhere, 'dee') }
    const mixed = await ann.post('/convs', { topic: 'Mixed', members: [bobRef, deeRef] })
    expect(mixed.body).toMatchObject({ joined: 0, invited: 2 })
    const card = await eventually(async () => { const r = await dee.get('/invites'); return r.body[0] }, 'dee is invited')
    expect(card).toMatchObject({ topic: 'Mixed', by: 'ann' })
    expect((await dee.get(`/convs/${mixed.body.conv}`)).body.error).toBe('not_member')
    expect((await dee.post(`/invites/${card.id}/accept`, { handle: 'dee2' })).status).toBe(200)
    expect((await view(dee, mixed.body.conv)).members.find((m) => m.me)!.handle).toBe('dee2')
    // cy was never invited to it and cannot accept dee's or bob's invitation.
    expect((await cy.post(`/invites/${card.id}/accept`, {})).body.error).toBe('invite_invalid')
  })

  it('opens one private chat per pair, and declining an invitation tells the inviter only that', async () => {
    const { who: ann, conv } = await founder()
    const bob = await invite(ann, conv, 'bob')
    const bobRef = { conv, alias: await aliasOf(ann, conv, 'bob') }
    const first = await ann.post('/convs', { topic: 'ann · bob', members: [bobRef], dm: true })
    const second = await bob.post('/convs', { topic: 'again', members: [{ conv, alias: await aliasOf(bob, conv, 'ann') }], dm: true })
    expect(second.body).toMatchObject({ conv: first.body.conv, existing: true })

    const solo = (await ann.post('/convs', { topic: 'Solo' })).body.conv as ConvId
    const invited = await ann.post(`/convs/${solo}/invites`, { to: bobRef })
    expect(invited.status).toBe(201)
    await eventually(async () => (await bob.get('/invites')).body.length === 1, 'invite delivered')
    expect((await bob.post(`/invites/${invited.body.invite}/decline`)).status).toBe(200)
    const sync = await ann.get('/sync?since=0')
    expect(sync.body.events.map((e: any) => e.body)).toContainEqual({ kind: 'invite_answered', invite: invited.body.invite, accepted: false })
  })
})

describe('the human gate', () => {
  it('I6: an agent token is not a human session, and a human session is not an agent token', async () => {
    const { bob } = await pair()
    const agent = await agentFor(bob)
    for (const path of ['/api/convs', '/api/inbox', '/api/drafts', '/api/me', '/api/devices']) {
      expect((await raw(path, { headers: { Authorization: `Bearer ${agent.token}` } })).status).toBe(401)
    }
    const asCookie = await raw('/api/convs', { headers: { Cookie: `__Host-sudare=${agent.token}` } })
    expect(asCookie.status).toBe(401)
    const session = bob.cookie.split('=')[1]!
    expect((await mcpClient('x', session).tool('inbox')).ok).toBe(false)
    expect((await raw('/mcp', { method: 'POST' })).status).toBe(401)
  })

  it('rejects cross-site writes made with the session cookie', async () => {
    const { who: ann, conv } = await founder()
    const forged = await raw(`/api/convs/${conv}/messages`, {
      method: 'POST', headers: { Cookie: ann.cookie, Origin: 'https://evil.example', 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: newEventId(), text: 'forged' }),
    })
    expect(forged.status).toBe(403)
    expect(await messages(ann, conv)).toEqual([])
  })

  it('I2: an agent reads nothing until a message is handed off, and then only that conversation', async () => {
    const { ann, bob, conv, msg } = await pair()
    const other = (await bob.post('/convs', { topic: 'Private notes' })).body.conv as ConvId
    await bob.send(other, 'secret')
    const agent = await agentFor(bob)

    expect((await agent.tool('inbox')).data.messages).toEqual([])
    expect((await agent.tool('history', { conv })).data.error).toBe('not_readable')
    expect((await agent.tool('claim', { msg })).data.error).toBe('invalid_transition')
    expect((await agent.tool('draft', { conv, text: 'hi' })).data.error).toBe('not_readable')

    expect((await bob.post(`/inbox/${msg}/handoff`, { mode: 'readonly' })).body.state).toBe('handed_off')
    expect((await agent.tool('inbox')).data.messages).toHaveLength(1)
    const claimed = await agent.tool('claim', { msg })
    expect(claimed.data).toMatchObject({ mode: 'readonly', you: 'bob', message: { from: 'ann', untrusted_text: 'can you look at the cache plan?' } })
    expect(claimed.data.context.some((e: any) => e.untrusted_text === 'can you look at the cache plan?')).toBe(true)
    expect((await agent.tool('history', { conv })).ok).toBe(true)
    expect((await agent.tool('history', { conv: other })).data.error).toBe('not_readable')

    expect((await agent.tool('done', { msg })).ok).toBe(true)
    expect((await agent.tool('history', { conv })).data.error).toBe('not_readable')
    const receipts = await eventually(async () => {
      const r = (await events(ann, conv)).flatMap((e) => (e.body.kind === 'receipt' ? [e.body.state] : []))
      return r.length === 1 ? r : null
    }, 'receipts in the two-person conversation')
    expect(receipts).toEqual(['done']) // asking an agent is not announced to the other person
  })

  it('a person can take a handoff back, finish a message themselves, and replying finishes it', async () => {
    const { ann, bob, conv, msg } = await pair()
    const agent = await agentFor(bob)
    await bob.post(`/inbox/${msg}/handoff`, {})
    await agent.tool('claim', { msg })
    expect((await bob.post(`/inbox/${msg}/takeback`)).body.state).toBe('read')
    expect((await agent.tool('history', { conv })).data.error).toBe('not_readable')
    expect((await agent.tool('done', { msg })).ok).toBe(false)
    expect((await bob.post(`/inbox/${msg}/takeback`)).status).toBe(409)
    // Asking an agent leaves no trace for the other person.
    expect((await events(ann, conv)).some((e) => e.body.kind === 'receipt' && e.body.state === 'handed_off')).toBe(false)

    await bob.send(conv, 'I will look tonight.')
    await eventually(async () => (await bob.get('/inbox')).body.length === 0, 'replying finishes what was waiting')

    const next = await ann.send(conv, 'thanks')
    await pending(bob)
    expect((await bob.post(`/inbox/${next}/done`)).body.state).toBe('done')
    expect((await bob.get('/inbox')).body).toEqual([])
  })

  it('I3: two devices cannot both claim a message', async () => {
    const { bob, msg } = await pair()
    const [a1, a2] = [await agentFor(bob, { name: 'one' }), await agentFor(bob, { name: 'two' })]
    await bob.post(`/inbox/${msg}/handoff`, { mode: 'full' })
    const results = await Promise.all([a1.tool('claim', { msg }), a2.tool('claim', { msg })])
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect(results.find((r) => !r.ok)!.data.error).toBe('claim_conflict')
    const loser = results[0]!.ok ? a2 : a1
    expect((await loser.tool('done', { msg })).data.error).toBe('not_claimer')
  })

  it('I8: a claim without a heartbeat falls back to handed_off', async () => {
    const { bob, msg } = await pair()
    const agent = await agentFor(bob)
    await bob.post(`/inbox/${msg}/handoff`, {})
    await agent.tool('claim', { msg })
    const stub = (env as any).PRINCIPAL.get((env as any).PRINCIPAL.idFromName((await bob.get('/me')).body.principal))
    await runInDurableObject(stub, (_i: unknown, state: DurableObjectState) => {
      const old = Date.now() - LIMITS.claimTimeoutMs - 1
      state.storage.sql.exec(`UPDATE items SET beat = ?, state = json_set(state, '$.beat', ?)`, old, old)
    })
    expect(await runDurableObjectAlarm(stub)).toBe(true)
    const item = (await bob.get('/inbox')).body[0]
    expect(item).toMatchObject({ state: 'handed_off', device: null })
    const kinds = (await bob.get('/sync?since=0')).body.events.map((e: any) => e.body.kind as string)
    expect(kinds.filter((k: string) => ['handed_off', 'claimed', 'claim_expired'].includes(k))).toEqual(['handed_off', 'claimed', 'claim_expired'])
  })

  it('I1: an agent can only draft; nothing is sent until the human approves, and edits are honoured', async () => {
    const { ann, bob, conv, msg } = await pair()
    const agent = await agentFor(bob)
    await bob.post(`/inbox/${msg}/handoff`, {})
    await agent.tool('claim', { msg })

    const drafted = await agent.tool('draft', { conv, text: 'Looks fine to me.', to: ['ann'], cause: msg })
    expect(drafted.data.status).toBe('pending')
    expect(await messages(ann, conv)).toHaveLength(1)
    expect((await agent.tool('draft_status', { draft: drafted.data.draft })).data.status).toBe('pending')

    const second = await agent.tool('draft', { conv, text: 'never sent' })
    expect((await bob.post(`/drafts/${second.data.draft}/reject`)).status).toBe(200)
    const list = (await bob.get('/drafts')).body
    expect(list[0]).toMatchObject({ id: drafted.data.draft, text: 'Looks fine to me.', device_name: 'bob-agent', status: 'pending' })
    const approved = await bob.post(`/drafts/${drafted.data.draft}/approve`, { text: 'Looks fine to me, with one change.' })
    expect(approved.status).toBe(200)
    expect((await messages(ann, conv)).at(-1)).toMatchObject({ text: 'Looks fine to me, with one change.', via: 'delegate' })
    expect((await bob.post(`/drafts/${drafted.data.draft}/approve`, {})).body.error).toBe('draft_not_pending')
    expect(await messages(ann, conv)).toHaveLength(2)
    expect((await agent.tool('draft_status', { draft: drafted.data.draft })).data.status).toBe('approved')
    // ann was named: the reply is addressed to her.
    expect((await pending(ann))[0]).toMatchObject({ from: 'bob', text: 'Looks fine to me, with one change.' })

    expect((await agent.tool('draft_status', { draft: second.data.draft })).data.status).toBe('rejected')
    expect((await messages(ann, conv)).some((m) => m.text === 'never sent')).toBe(false)
    // The approved reply answered the message: it is done, and the agent's access to the conversation ends.
    expect((await bob.get('/inbox')).body).toEqual([])
    expect((await agent.tool('draft', { conv, text: 'too late' })).data.error).toBe('not_readable')
    // Another device of the same person cannot see this device's drafts.
    const nosy = await agentFor(bob, { name: 'nosy' })
    expect((await nosy.tool('draft_status', { draft: drafted.data.draft })).data.error).toBe('not_found')
  })

  it('lets an agent propose a conversation that only exists once approved', async () => {
    const { ann, bob, conv } = await pair()
    await invite(ann, conv, 'cy')
    const agent = await agentFor(bob)
    expect((await agent.tool('conv_propose', { topic: 'Cache', members: [{ handle: 'nobody' }] })).data.error).toBe('recipient_unknown')
    const proposed = await agent.tool('conv_propose', { topic: 'Cache plan', members: [{ handle: 'ann' }, { handle: '@cy' }], first: 'Kicking this off.' })
    expect(proposed.ok).toBe(true)
    expect((await bob.convs()).some((c) => c.topic === 'Cache plan')).toBe(false)
    const approved = await bob.post(`/drafts/${proposed.data.draft}/approve`, {})
    expect(approved.status).toBe(200)
    const made = approved.body.conv as ConvId
    expect((await view(ann, made)).members.map((m) => m.handle).sort()).toEqual(['ann', 'bob', 'cy'])
    expect((await messages(ann, made))[0]).toMatchObject({ text: 'Kicking this off.', via: 'delegate' })
  })
})

describe('discussion rounds and notes', () => {
  const round = async (budget: Record<string, number> = {}) => {
    const { ann, bob, conv } = await pair()
    const opened = await ann.post(`/convs/${conv}/rounds`, { goal: 'Agree on the cache TTL', brief: 'We prefer 5 minutes.', ...budget })
    expect(opened.status).toBe(201)
    const id = opened.body.round as string
    const annAgent = await agentFor(ann, { rounds: true })
    const bobAgent = await agentFor(bob, { rounds: true })
    return { ann, bob, conv, id, annAgent, bobAgent }
  }

  it('I4: only a seated device of a member whose human joined may speak, within the budget', async () => {
    const { ann, bob, conv, id, annAgent, bobAgent } = await round({ messages: 2 })
    // bob's human has not joined: his agent has no seat to take and cannot speak.
    expect((await bobAgent.tool('round_claim', { round: id })).data.error).toBe('round_not_joined')
    expect((await bobAgent.tool('round_say', { round: id, text: 'hello' })).data.error).toBe('round_not_joined')
    // An agent cannot open or join rounds: those routes need a human session.
    expect((await raw(`/api/rounds/${id}/join`, { method: 'POST', headers: { Authorization: `Bearer ${bobAgent.token}` } })).status).toBe(401)

    const plain = await agentFor(ann, { rounds: false, name: 'no-sandbox' })
    expect((await plain.tool('round_claim', { round: id })).data.error).toBe('seat_not_capable')

    expect((await annAgent.tool('inbox')).data.rounds).toHaveLength(1)
    const seat = await annAgent.tool('round_claim', { round: id })
    expect(seat.data).toMatchObject({ brief: 'We prefer 5 minutes.', untrusted_goal: 'Agree on the cache TTL', remaining: { messages: 2 } })
    const second = await agentFor(ann, { rounds: true, name: 'second' })
    expect((await second.tool('round_claim', { round: id })).data.error).toBe('seat_taken')

    expect((await bob.post(`/rounds/${id}/join`, { brief: 'We need at most 1 minute.' })).status).toBe(200)
    expect((await bobAgent.tool('round_claim', { round: id })).data.brief).toBe('We need at most 1 minute.')

    expect((await annAgent.tool('round_say', { round: id, text: 'Five minutes?' })).ok).toBe(true)
    const heard = await bobAgent.tool('round_read', { round: id, since: seat.data.seq })
    expect(heard.data.events.some((e: any) => e.untrusted_text === 'Five minutes?' && e.via === 'autonomous')).toBe(true)
    const last = await bobAgent.tool('round_say', { round: id, text: 'One.' })
    expect(last.data.closed).toBe(true)
    expect((await annAgent.tool('round_say', { round: id, text: 'too late' })).data.error).toBe('round_closed')
    expect((await messages(ann, conv)).filter((m) => m.via === 'autonomous')).toHaveLength(2)
    expect((await view(ann, conv)).rounds[0]).toMatchObject({ closed: 'budget', used: { messages: 2 } })
    // The brief never left bob's own inbox.
    expect(JSON.stringify([await events(ann, conv), await view(ann, conv)])).not.toContain('at most 1 minute')
  })

  it('I9: a round past its deadline is closed by the alarm even if nobody speaks', async () => {
    const { ann, conv, id } = await round({ minutes: 0.001 })
    await new Promise((r) => setTimeout(r, 80))
    const stub = (env as any).CONVERSATION.get((env as any).CONVERSATION.idFromName(conv))
    await runDurableObjectAlarm(stub)
    await eventually(async () => (await view(ann, conv)).rounds[0]?.closed === 'expired', 'round expired')
    expect(id).toBeTruthy()
  })

  it('I10: a round output is adopted only when every human member endorses that revision', async () => {
    const { ann, bob, conv, id, annAgent } = await round()
    await annAgent.tool('round_claim', { round: id })
    const out = await annAgent.tool('note_propose', { conv, round: id, title: 'Cache TTL', text: 'TTL is 3 minutes.' })
    expect(out.data).toMatchObject({ rev: 1, status: 'awaiting_endorsement' })
    expect((await view(ann, conv)).rounds[0]!.closed).toBe('note_proposed')
    expect((await annAgent.tool('note_propose', { conv, round: id, title: 'Again', text: 'x' })).data.error).toBe('round_closed')

    const note = out.data.note as string
    const notes = async (who: Person) => (await who.get(`/convs/${conv}/notes`)).body as unknown as NoteView[]
    expect((await notes(ann))[0]).toMatchObject({ adopted: null, head: 1 })
    // An agent cannot endorse.
    expect((await raw(`/api/notes/${note}/endorse`, { method: 'POST', headers: { Authorization: `Bearer ${annAgent.token}`, 'Content-Type': 'application/json' }, body: '{"rev":1}' })).status).toBe(401)
    expect((await ann.post(`/notes/${note}/endorse`, { rev: 1 })).status).toBe(200)
    expect((await notes(ann))[0]!.adopted).toBeNull()
    expect((await ann.post(`/notes/${note}/endorse`, { rev: 1 })).body.error).toBe('already_endorsed')
    expect((await bob.post(`/notes/${note}/endorse`, { rev: 1 })).status).toBe(200)
    expect((await notes(bob))[0]!.adopted).toBe(1)

    // A new revision starts over; the adopted one stays adopted until then.
    const v2 = await bob.post(`/notes/${note}/revisions`, { id: newEventId(), base: 1, title: 'Cache TTL', text: 'TTL is 2 minutes.' })
    expect(v2.body.rev).toBe(2)
    expect((await bob.post(`/notes/${note}/revisions`, { id: newEventId(), base: 1, title: 'x', text: 'stale' })).body.error).toBe('note_base_stale')
    expect((await notes(ann))[0]).toMatchObject({ adopted: 1, head: 2 })
    expect((await ann.get(`/notes/${note}`)).body.text).toBe('TTL is 3 minutes.')
    expect((await ann.post(`/notes/${note}/endorse`, { rev: 2 })).status).toBe(200)
    expect((await notes(ann))[0]!.adopted).toBe(2)

    // A later member sees the adopted note (and only that) from before they joined.
    const cy = await invite(ann, conv, 'cy')
    const seen = (await notes(cy))[0]!
    expect(seen.revs.map((r) => r.rev)).toEqual([1, 2])
    expect((await cy.get(`/notes/${note}`)).body.text).toBe('TTL is 2 minutes.')
    const md = await raw(`/api/notes/${note}/export`, { headers: { Cookie: cy.cookie } })
    expect(md.headers.get('Content-Type')).toContain('text/markdown')
    expect(await md.text()).toBe('# Cache TTL\n\nTTL is 2 minutes.\n')
  })
})

describe('sync, search and retention', () => {
  it('I7: every member receives every message; the cursor is per person', async () => {
    const { who: ann, conv } = await founder()
    const bob = await invite(ann, conv, 'bob')
    const cy = await invite(ann, conv, 'cy')
    const ids = [await ann.send(conv, 'one'), await ann.send(conv, 'two', { to: [await aliasOf(ann, conv, 'cy')] })]
    for (const who of [bob, cy, ann]) {
      const got = await eventually(async () => {
        const s = await who.get('/sync?since=0')
        const d = s.body.events.filter((e: any) => e.body.kind === 'delivered')
        return d.length === 2 ? d : null
      }, `${who.name} delivery`)
      expect(got.map((e: any) => e.body.msg)).toEqual(ids)
    }
    // In a three-person conversation only the named member gets an inbox item.
    expect((await bob.get('/inbox')).body).toEqual([])
    expect((await cy.get('/inbox')).body).toHaveLength(1)
    expect((await bob.convs())[0]).toMatchObject({ unread: 2, pending: 0 })
    expect((await ann.convs())[0]).toMatchObject({ unread: 0 })
    await bob.post(`/convs/${conv}/read`, { seq: 9999 })
    expect((await bob.convs())[0]!.unread).toBe(0)
    // Seeing the conversation also reads what was addressed to you in it.
    expect((await cy.convs())[0]).toMatchObject({ pending: 1 })
    expect((await cy.post(`/convs/${conv}/read`, { seq: 9999 })).body.read).toBe(1)
    expect((await cy.convs())[0]).toMatchObject({ unread: 0, pending: 0 })
    expect((await cy.get('/inbox')).body[0]).toMatchObject({ state: 'read' })
    expect((await cy.post(`/convs/${conv}/read`, { seq: 9999 })).body.read).toBe(0)

    const first = await cy.get('/sync?since=0')
    const resumed = await cy.get(`/sync?since=${first.body.cursor}`)
    expect(resumed.body.events).toEqual([])
    expect((await cy.get('/sync')).body.events).toEqual([]) // server-side cursor, shared by all of cy's devices
  })

  it('is idempotent on the event id', async () => {
    const { who: ann, conv } = await founder()
    const id = newEventId()
    const a = await ann.post(`/convs/${conv}/messages`, { id, text: 'once' })
    const b = await ann.post(`/convs/${conv}/messages`, { id, text: 'once' })
    expect(b.body.event.seq).toBe(a.body.event.seq)
    expect(await messages(ann, conv)).toHaveLength(1)
  })

  it('searches what a person received, including CJK and short queries, and nothing else', async () => {
    const { who: ann, conv } = await founder()
    await ann.send(conv, 'before bob: the rollout is on Friday')
    const bob = await invite(ann, conv, 'bob')
    await ann.send(conv, '缓存方案明天讨论')
    await ann.send(conv, 'キャッシュの有効期限は5分')
    const find = (who: Person, q: string) => eventually(async () => {
      const r = await who.get(`/search?q=${encodeURIComponent(q)}`)
      return r.body as any[]
    })
    await eventually(async () => (await bob.get('/search?q=' + encodeURIComponent('缓存方案'))).body.length === 1, 'indexed')
    expect((await find(bob, '有効期限'))[0].snippet).toContain('有効期限')
    expect(await find(bob, '缓存')).toHaveLength(1) // two characters: substring fallback
    expect(await find(bob, 'rollout')).toEqual([])
    expect(await find(ann, 'rollout')).toHaveLength(1)
    expect(await find(ann, '"); DROP')).toEqual([])
  })

  it('deletes expired messages everywhere but keeps notes', async () => {
    const { who: ann, conv } = await founder()
    const bob = await invite(ann, conv, 'bob')
    await ann.send(conv, 'ephemeral words', { to: [await aliasOf(ann, conv, 'bob')] })
    await ann.post(`/convs/${conv}/notes`, { id: newEventId(), title: 'Kept', text: 'A conclusion.' })
    await pending(bob)
    await eventually(async () => (await bob.get('/search?q=ephemeral')).body.length === 1, 'indexed')
    const stub = (env as any).CONVERSATION.get((env as any).CONVERSATION.idFromName(conv))
    await runInDurableObject(stub, (_i: unknown, state: DurableObjectState) => {
      state.storage.sql.exec(`UPDATE events SET ts = ts - ? WHERE kind = 'message'`, 31 * 86_400_000)
      state.storage.sql.exec(`INSERT INTO meta (k, v) VALUES ('sweep_at', '1') ON CONFLICT(k) DO UPDATE SET v = '1'`)
    })
    await runDurableObjectAlarm(stub)
    expect(await messages(ann, conv)).toEqual([])
    await eventually(async () => (await bob.get('/search?q=ephemeral')).body.length === 0, 'index purged')
    expect((await bob.get('/inbox?all=1')).body).toEqual([])
    expect((await bob.get(`/convs/${conv}/notes`)).body).toHaveLength(1)
  })

  it('exports the complete log to the operator only', async () => {
    const { who: ann, conv } = await founder()
    await ann.send(conv, 'hello')
    expect((await raw(`/admin/export/conv/${conv}`)).status).toBe(401)
    expect((await raw(`/admin/export/conv/${conv}`, { headers: { Cookie: ann.cookie } })).status).toBe(401)
    const res = await raw(`/admin/export/conv/${conv}`, { headers: { Authorization: `Bearer ${ADMIN}` } })
    const lines = (await res.text()).trim().split('\n').map((l) => JSON.parse(l))
    expect(lines.map((l) => l.body.kind)).toEqual(['conv_created', 'member_joined', 'message'])
    expect(lines[1].private.principal).toMatch(/^p_/)
  })
})

describe('devices and OAuth', () => {
  const pkce = async () => {
    const verifier = crypto.randomUUID() + crypto.randomUUID()
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))
    return { verifier, challenge: btoa(String.fromCharCode(...digest)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') }
  }

  it('enrols an agent through the browser consent page and revokes it per device', async () => {
    const { bob, msg } = await pair()
    const meta = await raw('/.well-known/oauth-authorization-server').then((r) => r.json<any>())
    expect(meta).toMatchObject({ issuer: ORIGIN, authorization_endpoint: `${ORIGIN}/authorize`, authorization_response_iss_parameter_supported: true })
    expect((await raw('/.well-known/oauth-protected-resource/mcp').then((r) => r.json<any>())).resource).toBe(`${ORIGIN}/mcp`)
    const challenge401 = await raw('/mcp', { method: 'POST' })
    expect(challenge401.headers.get('WWW-Authenticate')).toContain('resource_metadata')

    const redirect = 'http://127.0.0.1:43123/callback'
    const client = await raw('/oauth/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'Test Agent', redirect_uris: [redirect], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }),
    }).then((r) => r.json<any>())
    const { verifier, challenge } = await pkce()
    const query = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: redirect, scope: 'agent', state: 's1', code_challenge: challenge, code_challenge_method: 'S256', resource: `${ORIGIN}/mcp` })

    const anonymous = await raw(`/authorize?${query}`)
    expect(anonymous.status).toBe(302)
    expect(anonymous.headers.get('Location')).toContain('/login?next=')

    const page = await raw(`/authorize?${query}`, { headers: { Cookie: bob.cookie } })
    const html = await page.text()
    expect(html).toContain('Test Agent')
    expect(html).toContain('this computer')
    expect(html).toContain('Unverified app')
    const handle = /name="handle" value="([^"]+)"/.exec(html)![1]!
    const consentCookie = (page.headers.get('Set-Cookie') ?? '').split(';')[0]!
    const decide = (cookie: string, origin: string) => raw('/authorize', {
      method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ handle, decision: 'approve', name: 'laptop', rounds: '1' }).toString(), // `rounds` from the form is ignored
    })
    expect((await decide(`${bob.cookie}; ${consentCookie}`, 'https://evil.example')).status).toBe(403)
    expect((await decide(consentCookie, ORIGIN)).status).toBe(403) // no human session
    const approved = await decide(`${bob.cookie}; ${consentCookie}`, ORIGIN)
    expect(approved.status).toBe(302)
    const back = new URL(approved.headers.get('Location')!)
    expect(back.origin + back.pathname).toBe(redirect)
    expect(back.searchParams.get('state')).toBe('s1')
    expect(back.searchParams.get('iss')).toBe(ORIGIN)

    const token = await raw('/oauth/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: back.searchParams.get('code')!, redirect_uri: redirect, client_id: client.client_id, code_verifier: verifier }).toString(),
    }).then((r) => r.json<any>())
    expect(token).toMatchObject({ token_type: 'bearer', scope: 'agent', expires_in: 3600 })
    expect(token.refresh_token).toBeTruthy()

    const devices = (await bob.get('/devices')).body as any[]
    expect(devices).toHaveLength(1)
    expect(devices[0]).toMatchObject({ name: 'laptop', kind: 'oauth', client: 'Test Agent', rounds: false }) // an unverified app is not trusted with round seats
    const agent = mcpClient(devices[0].id, token.access_token)
    await bob.post(`/inbox/${msg}/handoff`, {})
    expect((await agent.tool('inbox')).data.messages).toHaveLength(1)
    // The access token is an agent credential and nothing more.
    expect((await raw('/api/convs', { headers: { Authorization: `Bearer ${token.access_token}` } })).status).toBe(401)

    expect((await bob.del(`/devices/${devices[0].id}`)).status).toBe(200)
    const after = await agent.tool('inbox')
    expect(after.ok).toBe(false)
    expect(after.data.status).toBe(401)
    const refreshed = await raw('/oauth/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token.refresh_token, client_id: client.client_id }).toString(),
    })
    expect(refreshed.status).toBe(400)
  })

  it('refuses to send an authorization code anywhere but a loopback address', async () => {
    const { who: ann } = await founder()
    const redirect = 'https://attacker.example/cb'
    const client = await raw('/oauth/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'Totally Legit', redirect_uris: [redirect], token_endpoint_auth_method: 'none' }),
    }).then((r) => r.json<any>())
    const { challenge } = await pkce()
    const query = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: redirect, scope: 'agent', state: 's', code_challenge: challenge, code_challenge_method: 'S256' })
    const page = await raw(`/authorize?${query}`, { headers: { Cookie: ann.cookie } })
    expect(page.status).toBe(400)
    expect(await page.text()).toContain('Blocked')
  })

  it('gives the plugin a human session only after a passkey confirmation by the same person', async () => {
    const { ann, bob, conv } = await pair()
    const agent = await agentFor(bob)
    const secret = `sds_${crypto.randomUUID()}${crypto.randomUUID()}`
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret)))
    const hash = btoa(String.fromCharCode(...digest)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    const started = await agent.tool('human_session_start', { challenge: hash })
    expect(started.ok).toBe(true)
    const link = started.data.link as string
    const asPlugin = (path: string) => raw(`/api${path}`, { headers: { Authorization: `Bearer ${secret}` } })

    expect((await asPlugin('/convs')).status).toBe(401) // not confirmed yet
    expect((await raw(`/api/link/${link}/status`).then((r) => r.json<any>())).confirmed).toBe(false)
    // ann cannot confirm a link that bob's device started (the phishing case).
    expect((await ann.get(`/link/${link}`)).status).toBe(404)
    expect((await ann.post(`/link/${link}/options`)).status).toBe(404)

    expect((await bob.get(`/link/${link}`)).body).toMatchObject({ device: 'bob-agent', code: hash.replace(/[^A-Za-z0-9]/g, '').slice(0, 6).toUpperCase() })
    const o = await bob.post(`/link/${link}/options`)
    const confirmed = await bob.post(`/link/${link}/confirm`, { id: o.body.id, response: await bob.passkey.get(o.body.options) })
    expect(confirmed.status).toBe(200)
    expect((await raw(`/api/link/${link}/status`).then((r) => r.json<any>())).confirmed).toBe(true)

    expect((await asPlugin('/convs')).status).toBe(200)
    const sent = await raw(`/api/convs/${conv}/messages`, {
      method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: newEventId(), text: 'sent from the plugin input box', to_handles: ['@ann'] }),
    })
    expect(sent.status).toBe(201)
    // A plugin-held session cannot mint or revoke devices.
    const mint = await raw('/api/devices/token', { method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' }, body: '{"name":"x"}' })
    expect(mint.status).toBe(403)
    // Revoking the device ends the session that was linked from it.
    await bob.del(`/devices/${agent.id}`)
    expect((await asPlugin('/convs')).status).toBe(401)
    expect(await db.prepare(`SELECT count(*) AS n FROM sessions WHERE kind = 'plugin'`).first('n')).toBe(0)
  })

  it('keeps a plugin session for a week only when the plugin asked and the person confirmed', async () => {
    const { bob } = await pair()
    const agent = await agentFor(bob)
    const hashOf = async (secret: string) => {
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret)))
      return btoa(String.fromCharCode(...digest)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    }
    const signIn = async (remember: boolean) => {
      const secret = `sds_${crypto.randomUUID()}${crypto.randomUUID()}`
      const started = await agent.tool('human_session_start', { challenge: await hashOf(secret), remember })
      const link = started.data.link as string
      const shown = (await bob.get(`/link/${link}`)).body
      const o = await bob.post(`/link/${link}/options`)
      const done = await bob.post(`/link/${link}/confirm`, { id: o.body.id, response: await bob.passkey.get(o.body.options) })
      return { shown, hours: (done.body.expires - Date.now()) / 3_600_000 }
    }
    const brief = await signIn(false)
    expect(brief.shown.remember_hours).toBe(0)
    expect(brief.hours).toBeGreaterThan(7.9)
    expect(brief.hours).toBeLessThan(8.1)
    const kept = await signIn(true)
    expect(kept.shown.remember_hours).toBe(168) // the page tells the person before they confirm
    expect(kept.hours).toBeGreaterThan(167.9)
    expect(kept.hours).toBeLessThan(168.1)
  })

  it('throttles unauthenticated callers per address', async () => {
    const from = (ip: string) => raw('/api/join/aaaaaaaaaaaaaaaaaaaaaaaa/check', { headers: { 'CF-Connecting-IP': ip } }).then((r) => r.status)
    const burst = await Promise.all(Array.from({ length: 40 }, () => from('203.0.113.9')))
    expect(burst.filter((s) => s === 429).length).toBeGreaterThan(0)
    expect(burst.filter((s) => s === 200).length).toBeGreaterThan(0)
    expect(await from('203.0.113.10')).toBe(200)
  })

  it('logs in again with the same passkey and rejects a replayed assertion', async () => {
    const { who: ann } = await founder()
    const o = await ann.post('/auth/login/options')
    const response = await ann.passkey.get(o.body.options)
    expect((await ann.post('/auth/login/verify', { id: o.body.id, response })).status).toBe(200)
    expect((await ann.post('/auth/login/verify', { id: o.body.id, response })).status).toBe(401)
    await ann.login()
    expect((await ann.get('/me')).status).toBe(200)
    await ann.post('/auth/logout')
    expect((await ann.get('/me')).status).toBe(401)
    expect((await bootstrap()).startsWith(`${ORIGIN}/j/`)).toBe(true)
  })
})

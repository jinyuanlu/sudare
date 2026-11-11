import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import type { ConvId } from '@sudare/protocol'
import { describe, expect, it } from 'vitest'
import { validPushEndpoint } from '../src/push'
import { ADMIN, ORIGIN, agentFor, db, eventually, founder, invite, joinByLink, raw, type Person } from './harness'

const convStub = (conv: ConvId) => (env as any).CONVERSATION.get((env as any).CONVERSATION.idFromName(conv))
const texts = async (who: Person, conv: ConvId) =>
  ((await who.get(`/convs/${conv}/events?limit=200`)).body.events ?? []).flatMap((e: any) => (e.body.kind === 'message' ? [e.body.text] : []))

describe('membership over time', () => {
  it('leaving ends access at once; coming back starts a new window', async () => {
    const { who: ann, conv } = await founder()
    const bob = await invite(ann, conv, 'bob')
    await ann.send(conv, 'while bob is here')
    expect((await bob.post(`/convs/${conv}/leave`)).status).toBe(200)
    await eventually(async () => (await bob.convs()).length === 0, 'conversation leaves the list')
    expect((await bob.get(`/convs/${conv}/events`)).body.error).toBe('not_member')
    expect((await bob.post(`/convs/${conv}/messages`, { id: '01ARZ3NDEKTSV4RRFFQ69G5FAV', text: 'x' })).body.error).toBe('not_member')
    await ann.send(conv, 'while bob is away')

    const link = (await ann.post(`/convs/${conv}/invites`, { link: true })).body.url as string
    expect((await bob.post(`/join/${link.split('/j/')[1]}/accept`, { handle: 'bob' })).status).toBe(200)
    await ann.send(conv, 'after bob came back')
    expect(await texts(bob, conv)).toEqual(['after bob came back'])
    // The directory never shows a departed alias as a contact.
    const contacts = (await ann.get('/contacts')).body as any[]
    expect(contacts.filter((c) => c.handle === 'bob')).toHaveLength(1)
  })

  it('when everyone has left, the conversation is closed for good and nobody can come back', async () => {
    const { who: ann, conv } = await founder()
    const bob = await invite(ann, conv, 'bob')
    const link = (await ann.post(`/convs/${conv}/invites`, { link: true })).body.url as string
    expect((await ann.post(`/convs/${conv}/leave`)).status).toBe(200)
    expect((await bob.post(`/convs/${conv}/leave`)).status).toBe(200)
    await eventually(async () => (await bob.convs()).length === 0, 'gone from the list')
    // A link made while people were still inside no longer admits anyone.
    const late = (await founder('zed')).who
    expect((await late.post(`/join/${link.split('/j/')[1]}/accept`, {})).body.error).toBe('conv_archived')
    expect((await ann.get(`/convs/${conv}`)).body.error).toBe('not_member')
  })

  it('an archived conversation is read-only and is deleted whole after its retention', async () => {
    const { who: ann, conv } = await founder()
    const bob = await invite(ann, conv, 'bob')
    await ann.send(conv, 'last words')
    expect((await bob.post(`/convs/${conv}/archive`)).body.error).toBe('forbidden_scope') // creator only
    expect((await ann.post(`/convs/${conv}/archive`)).status).toBe(200)
    expect((await ann.post(`/convs/${conv}/messages`, { id: '01ARZ3NDEKTSV4RRFFQ69G5FAV', text: 'x' })).body.error).toBe('conv_archived')
    expect((await ann.post(`/convs/${conv}/invites`, { link: true })).body.error).toBe('conv_archived')
    expect(await texts(bob, conv)).toEqual(['last words'])

    await runInDurableObject(convStub(conv), (_i: unknown, state: DurableObjectState) => {
      state.storage.sql.exec(`UPDATE events SET ts = ts - ?`, 31 * 86_400_000)
      state.storage.sql.exec(`INSERT INTO meta (k, v) VALUES ('sweep_at', '1') ON CONFLICT(k) DO UPDATE SET v = '1'`)
    })
    await runDurableObjectAlarm(convStub(conv))
    expect((await ann.get(`/convs/${conv}`)).body.error).toBe('conv_missing')
    expect(await ann.convs()).toEqual([])
    expect(await bob.convs()).toEqual([])
    expect(await db.prepare(`SELECT count(*) AS n FROM aliases WHERE conv = ?`).bind(conv).first('n')).toBe(0)
  })

  it('cannot fork from, or name people in, a conversation one is not in', async () => {
    const { who: ann, conv } = await founder()
    await invite(ann, conv, 'bob')
    const alias = ((await ann.get(`/convs/${conv}`)).body.members as any[]).find((m) => m.handle === 'bob').alias
    const eve = (await founder('eve')).who
    expect((await eve.post('/convs', { topic: 'x', parent: conv })).body.error).toBe('not_member')
    expect((await eve.post('/convs', { topic: 'x', members: [{ conv, alias }] })).body.error).toBe('not_member')
    expect((await eve.post(`/convs/${conv}/invites`, { link: true })).body.error).toBe('not_member')
  })

  it('shows unanswered invitations to members, lets the sender withdraw one, and lists a person once', async () => {
    const { who: ann, conv } = await founder()
    const bob = await invite(ann, conv, 'bob')
    const side = (await ann.post('/convs', { topic: 'Side', parent: conv, members: [{ conv, alias: ((await ann.get(`/convs/${conv}`)).body.members as any[]).find((m) => m.handle === 'bob').alias }] })).body.conv as ConvId
    const contacts = (await ann.get('/contacts')).body as any[]
    expect(contacts.filter((c) => c.handle === 'bob')).toHaveLength(2) // met in two rooms
    expect(new Set(contacts.filter((c) => c.handle === 'bob').map((c) => c.person)).size).toBe(1) // one person
    expect(JSON.stringify(contacts)).not.toMatch(/p_[0-9A-Z]{26}/)

    const solo = (await ann.post('/convs', { topic: 'Solo' })).body.conv as ConvId
    const sent = await ann.post(`/convs/${solo}/invites`, { to: { conv, alias: contacts.find((c) => c.handle === 'bob' && c.conv === conv).alias } })
    await ann.post(`/convs/${solo}/invites`, { link: true })
    const pending = (await ann.get(`/convs/${solo}/invites`)).body as any[]
    expect(pending.map((p) => [p.kind, p.name, p.mine])).toEqual([['direct', 'bob', true], ['link', null, true]])
    expect((await bob.get(`/convs/${solo}/invites`)).body.error).toBe('not_member')
    expect((await bob.del(`/convs/${solo}/invites/${sent.body.invite}`)).body.error).toBe('invite_invalid')
    expect((await ann.del(`/convs/${solo}/invites/${sent.body.invite}`)).status).toBe(200)
    expect((await bob.post(`/invites/${sent.body.invite}/accept`, {})).body.error).toBe('invite_invalid')
    await eventually(async () => (await bob.get('/invites')).body.length === 0, 'withdrawn invitation disappears')
    expect(side).toBeTruthy()
  })

  it('a room link lets several people in until it is turned off', async () => {
    const { who: ann, conv } = await founder()
    const made = await ann.post(`/convs/${conv}/invites`, { room: true })
    expect(made.status).toBe(201)
    const again = await ann.post(`/convs/${conv}/invites`, { room: true })
    expect(again.body.url).toBe(made.body.url) // the same link each time it is asked for
    const url = made.body.url as string

    const { who: bob } = await joinByLink('bob', url)
    const { who: cy } = await joinByLink('cy', url)
    expect(((await ann.get(`/convs/${conv}`)).body.members as any[]).map((m) => m.handle).sort()).toEqual(['ann', 'bob', 'cy'])
    expect((await bob.post(`/join/${url.split('/j/')[1]}/accept`, {})).body.error).toBe('already_member')
    // Someone who already has an account can use it too.
    const dee = (await founder('dee')).who
    expect((await dee.post(`/join/${url.split('/j/')[1]}/accept`, { handle: 'dee' })).status).toBe(200)

    const pending = (await cy.get(`/convs/${conv}/invites`)).body as any[]
    expect(pending.filter((p) => p.kind === 'room')).toHaveLength(1)
    expect((await cy.del(`/convs/${conv}/invites/${made.body.id}`)).body.error).toBe('invite_invalid') // only its maker turns it off
    expect((await ann.del(`/convs/${conv}/invites/${made.body.id}`)).status).toBe(200)
    expect((await raw(`/api/join/${url.split('/j/')[1]}/check`).then((r) => r.json<any>())).valid).toBe(false)
    const late = (await founder('eve')).who
    expect((await late.post(`/join/${url.split('/j/')[1]}/accept`, { handle: 'eve' })).body.error).toBe('invite_invalid')
    // A new one can be made afterwards, and it is a different link.
    expect((await ann.post(`/convs/${conv}/invites`, { room: true })).body.url).not.toBe(url)
  })

  it('respects a creator-only invitation policy', async () => {
    const { who: ann, conv } = await founder()
    const bob = await invite(ann, conv, 'bob')
    const alias = ((await ann.get(`/convs/${conv}`)).body.members as any[]).find((m) => m.handle === 'bob').alias
    const closed = (await ann.post('/convs', { topic: 'Closed', parent: conv, members: [{ conv, alias }], invite: 'creator' })).body.conv as ConvId
    expect((await bob.post(`/convs/${closed}/invites`, { link: true })).body.error).toBe('invite_forbidden')
    expect((await ann.post(`/convs/${closed}/invites`, { link: true })).status).toBe(201)
  })
})

describe('live updates and push', () => {
  it('announces inbox progress on the websocket, to the same origin only', async () => {
    const { who: ann, conv } = await founder()
    const bob = await invite(ann, conv, 'bob')
    const upgrade = (headers: Record<string, string>) => raw('/api/ws', { headers: { Upgrade: 'websocket', Cookie: bob.cookie, ...headers } })
    expect((await upgrade({ Origin: 'https://evil.example' })).status).toBe(403)
    expect((await raw('/api/ws', { headers: { Upgrade: 'websocket', Origin: ORIGIN } })).status).toBe(401)

    const res = await upgrade({ Origin: ORIGIN })
    expect(res.status).toBe(101)
    const ws = res.webSocket!
    const seen: number[] = []
    ws.accept()
    ws.addEventListener('message', (m) => seen.push(JSON.parse(m.data as string).seq))
    await eventually(async () => seen.length >= 1, 'hello frame')
    const before = seen[seen.length - 1]!
    await ann.send(conv, 'ping bob')
    await eventually(async () => seen[seen.length - 1]! > before, 'a seq bump after the message')
    ws.close()
  })

  it('shows the people one shares a conversation with whether they are here now', async () => {
    const { who: ann, conv } = await founder()
    const bob = await invite(ann, conv, 'bob')
    const here = async (who: Person) => Object.fromEntries(((await who.get(`/convs/${conv}`)).body.members as any[]).map((m) => [m.handle, m.active]))
    await eventually(async () => (await here(ann)).bob === true, 'bob seen')
    expect(await here(bob)).toMatchObject({ ann: true, bob: true })
    await db.prepare(`UPDATE principals SET last_seen = ? WHERE id = ?`).bind(Date.now() - 10 * 60_000, (await bob.get('/me')).body.principal).run()
    // Reading as ann does not make bob look present; bob is still present to himself.
    expect((await here(ann)).bob).toBe(false)
  })

  it('accepts only real push services as push endpoints', async () => {
    const { who: ann } = await founder()
    expect(validPushEndpoint('https://fcm.googleapis.com/fcm/send/abc')).toBe(true)
    expect(validPushEndpoint('https://web.push.apple.com/abc')).toBe(true)
    expect(validPushEndpoint('https://wns2-par02p.notify.windows.com/w/?token=abc')).toBe(true)
    for (const bad of ['http://fcm.googleapis.com/x', 'https://169.254.169.254/latest', 'https://fcm.googleapis.com.evil.example/x', 'https://evil.example/fcm.googleapis.com']) {
      expect(validPushEndpoint(bad)).toBe(false)
      expect((await ann.post('/push/subscribe', { endpoint: bad })).status).toBe(400)
    }
    expect((await ann.post('/push/subscribe', { endpoint: 'https://fcm.googleapis.com/fcm/send/abc' })).status).toBe(200)
  })
})

describe('devices', () => {
  it('a revoked or expired pasted token stops working, and one person cannot touch another\'s devices', async () => {
    const { who: ann, conv } = await founder()
    const bob = await invite(ann, conv, 'bob')
    const agent = await agentFor(bob)
    expect((await agent.tool('inbox')).ok).toBe(true)
    expect((await ann.del(`/devices/${agent.id}`)).status).toBe(404)
    expect((await ann.patch(`/devices/${agent.id}`, { name: 'x', rounds: true })).status).toBe(404)
    expect((await agent.tool('inbox')).ok).toBe(true)

    await db.prepare(`UPDATE devices SET expires_at = ? WHERE id = ?`).bind(Date.now() - 1, agent.id).run()
    expect((await agent.tool('inbox')).data).toMatchObject({ status: 401, error: 'token_expired' })
    await db.prepare(`UPDATE devices SET expires_at = ? WHERE id = ?`).bind(Date.now() + 60_000, agent.id).run()
    expect((await bob.del(`/devices/${agent.id}`)).status).toBe(200)
    expect((await agent.tool('inbox')).data).toMatchObject({ status: 401, error: 'token_revoked' })
    expect((await bob.get('/devices')).body).toEqual([])
  })

  it('lists exactly the tools an agent is meant to have', async () => {
    const { who: ann } = await founder()
    const agent = await agentFor(ann)
    const res = await raw('/mcp', {
      method: 'POST', headers: { Authorization: `Bearer ${agent.token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    }).then((r) => r.json<any>())
    const names = res.result.tools.map((t: any) => t.name).sort()
    expect(names).toEqual(['claim', 'conv_propose', 'done', 'draft', 'draft_status', 'history', 'human_session_start', 'inbox', 'note_list', 'note_propose', 'note_read', 'round_claim', 'round_read', 'round_say'])
    // Nothing that sends outside a round, approves, hands off, endorses or joins.
    expect(names.some((n: string) => /send|approve|handoff|endorse|join|invite|open/.test(n))).toBe(false)
    const init = await raw('/mcp', {
      method: 'POST', headers: { Authorization: `Bearer ${agent.token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } }),
    }).then((r) => r.json<any>())
    expect(init.result.serverInfo.name).toBe('sudare')
  })
})

describe('a public demo server', () => {
  const anon = (path: string, body: unknown = {}) =>
    raw(`/api${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN, 'CF-Connecting-IP': '203.0.113.9' }, body: JSON.stringify(body) })
  const withSignup = async <T>(vars: Record<string, string>, f: () => Promise<T>): Promise<T> => {
    const e = env as any
    const before = { OPEN_SIGNUP: e.OPEN_SIGNUP, SIGNUP_DAILY_LIMIT: e.SIGNUP_DAILY_LIMIT, SITE_NOTICE: e.SITE_NOTICE }
    Object.assign(e, vars)
    try { return await f() } finally { Object.assign(e, before) }
  }

  it('has no sign-up unless the operator turned it on', async () => {
    expect((await anon('/signup')).status).toBe(404)
    expect(await raw('/api/site').then((r) => r.json())).toEqual({ signup: false, notice: '' })
  })

  it('with sign-up on, a stranger gets an account and a room of their own, up to the daily limit', async () => {
    const already = (await db.prepare(`SELECT count(*) AS n FROM principals`).first<{ n: number }>())!.n
    await withSignup({ OPEN_SIGNUP: 'on', SIGNUP_DAILY_LIMIT: String(already + 2), SITE_NOTICE: 'Demo server.' }, async () => {
      expect(await raw('/api/site').then((r) => r.json())).toEqual({ signup: true, notice: 'Demo server.' })
      const offer = await anon('/signup')
      expect(offer.status).toBe(201)
      const { code } = await offer.json<{ code: string }>()
      const { who, conv } = await joinByLink('zoe', `${ORIGIN}/j/${code}`)
      const rooms = await who.convs()
      expect(rooms.map((c) => [c.id, c.topic, c.members])).toEqual([[conv, 'My first room', 1]])
      // The offer is an ordinary single-use invitation: it registers nobody else.
      expect((await anon('/auth/register/options', { code })).status).not.toBe(200)
      // Without Origin it is refused like every other public write.
      expect((await raw('/api/signup', { method: 'POST' })).status).toBe(403)
      await joinByLink('yan', `${ORIGIN}/j/${(await (await anon('/signup')).json<{ code: string }>()).code}`)
      expect((await anon('/signup')).status).toBe(429)
    })
  })

  it('can be erased whole by the operator, and only by the operator', async () => {
    const { who: ann, conv } = await founder()
    const bob = await invite(ann, conv, 'bob')
    await ann.send(conv, 'hello')
    await agentFor(bob)
    const wipe = (auth: string, body: unknown) =>
      raw('/admin/wipe', { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    expect((await wipe('Bearer nope', { confirm: 'erase everything' })).status).toBe(401)
    expect((await wipe(`Bearer ${ADMIN}`, {})).status).toBe(400)
    let left: unknown = 'start'
    for (let i = 0; i < 20 && left !== 0; i++) left = (await (await wipe(`Bearer ${ADMIN}`, { confirm: 'erase everything' })).json<{ left: unknown }>()).left
    expect(left).toBe(0)
    expect((await ann.get('/me')).status).toBe(401)
    for (const t of ['principals', 'credentials', 'sessions', 'devices', 'convs', 'aliases', 'invites']) {
      expect((await db.prepare(`SELECT count(*) AS n FROM ${t}`).first<{ n: number }>())?.n, t).toBe(0)
    }
    expect(await runInDurableObject(convStub(conv), (_o: unknown, state: DurableObjectState) => state.storage.sql.exec(`SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'events'`).one().n)).toBe(0)
    // And the server works afterwards.
    const { who: cat } = await founder('cat')
    expect((await cat.convs()).length).toBe(1)
  })
})

describe('changing your name in a room', () => {
  it('relabels the member everywhere, rewrites no message, and cannot take a name in use', async () => {
    const { who: ann, conv } = await founder()
    const bob = await invite(ann, conv, 'bob')
    const said = await ann.send(conv, 'hello', { to_handles: ['bob'] })
    const link = (await ann.post(`/convs/${conv}/invites`, { link: true })).body

    expect((await ann.patch(`/convs/${conv}`, { handle: 'Bob' })).body.error).toBe('handle_taken')
    expect((await ann.patch(`/convs/${conv}`, { handle: 'two words' })).body.error).toBe('handle_invalid')
    const view = await ann.patch(`/convs/${conv}`, { handle: 'Prospero' })
    expect(view.status).toBe(200)
    expect(view.body.members.map((m: any) => m.handle).sort()).toEqual(['Prospero', 'bob'])

    // The message is the same event, by the same alias; only the label resolved from it changed.
    const events = (await bob.get(`/convs/${conv}/events?limit=200`)).body.events
    const message = events.find((e: any) => e.id === said)
    const renamed = events.find((e: any) => e.body.kind === 'member_renamed')
    expect(renamed.body).toMatchObject({ handle: 'Prospero', was: 'ann', alias: message.body.author.alias })
    // bob sees it in his list of what is waiting, the room list, and the pending invitation.
    await eventually(async () => (await bob.get('/inbox')).body.some?.((i: any) => i.from === 'Prospero') || JSON.stringify((await bob.get('/inbox')).body).includes('Prospero'), 'inbox sender')
    await eventually(async () => (await ann.convs())[0]?.handle === 'Prospero', 'room list')
    await eventually(async () => (await raw(`/api/join/${link.url.split('/j/')[1]}/check`).then((r) => r.json<any>())).by === 'Prospero', 'invitation card')
    expect((await ann.get('/me')).body.default_handle).toBe('Prospero')
    // Addressing by the new name works, and the old name no longer reaches anyone.
    await bob.send(conv, 'hi', { to_handles: ['Prospero'] })
    await expect(bob.send(conv, 'hi', { to_handles: ['ann'] })).rejects.toThrow(/recipient_unknown/)
    // The usual name can be set on its own; it changes no room.
    expect((await ann.patch('/me', { default_handle: 'two words' })).status).toBe(400)
    expect((await ann.patch('/me', { default_handle: 'Ariel' })).body).toEqual({ default_handle: 'Ariel' })
    expect((await ann.get('/me')).body.default_handle).toBe('Ariel')
    expect((await ann.get(`/convs/${conv}`)).body.members.find((m: any) => m.me).handle).toBe('Prospero')
    // bob cannot rename ann: the route only ever renames the caller.
    await bob.patch(`/convs/${conv}`, { handle: 'Caliban' })
    expect((await ann.get(`/convs/${conv}`)).body.members.map((m: any) => m.handle).sort()).toEqual(['Caliban', 'Prospero'])
  })
})

describe('handing any message to your agent', () => {
  it('works for a message that was addressed to nobody, and only within what the member may read', async () => {
    const { who: ann, conv } = await founder()
    const early = await ann.send(conv, 'said before bob and cat arrived')
    const bob = await invite(ann, conv, 'bob')
    const cat = await invite(ann, conv, 'cat')
    const said = await ann.send(conv, 'what TTL should the cache use?') // three people: addressed to no one
    const agent = await agentFor(bob)
    expect((await bob.get('/inbox')).body).toEqual([])
    expect((await agent.tool('inbox')).data.messages).toEqual([])

    expect((await bob.post(`/convs/${conv}/messages/${said}/handoff`)).body).toEqual({ state: 'handed_off' })
    const waiting = await eventually(async () => { const m = (await agent.tool('inbox')).data.messages; return m.length === 1 ? m : null }, 'agent inbox')
    expect(waiting[0]).toMatchObject({ msg: said })
    const claimed = await agent.tool('claim', { msg: said })
    expect(claimed.data.message.untrusted_text).toBe('what TTL should the cache use?')
    expect((await agent.tool('history', { conv })).ok).toBe(true)
    // cat did not hand anything over: her agent sees nothing and cannot read the room.
    const cats = await agentFor(cat)
    expect((await cats.tool('inbox')).data.messages).toEqual([])
    expect((await cats.tool('history', { conv })).ok).toBe(false)

    // Not what was said before you joined (I12), not your own message, not from outside the room.
    expect((await bob.post(`/convs/${conv}/messages/${early}/handoff`)).status).toBe(404)
    expect((await ann.post(`/convs/${conv}/messages/${said}/handoff`)).status).toBe(400)
    const { who: eve } = await founder('eve')
    expect((await eve.post(`/convs/${conv}/messages/${said}/handoff`)).status).toBeGreaterThanOrEqual(403)
    // An agent cannot do this for itself.
    expect((await raw(`/api/convs/${conv}/messages/${said}/handoff`, { method: 'POST', headers: { Authorization: `Bearer ${agent.token}`, Origin: ORIGIN, 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(401)
  })
})

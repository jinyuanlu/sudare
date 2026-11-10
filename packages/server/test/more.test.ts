import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import type { ConvId } from '@sudare/protocol'
import { describe, expect, it } from 'vitest'
import { validPushEndpoint } from '../src/push'
import { ORIGIN, agentFor, db, eventually, founder, invite, raw, type Person } from './harness'

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

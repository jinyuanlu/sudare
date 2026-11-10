import { env, exports } from 'cloudflare:workers'
import { newEventId, type ConvId, type ConvSummary, type EventId } from '@sudare/protocol'
import { authenticator, type Authenticator } from './authenticator'

export const ORIGIN = 'https://sudare.test'
export const ADMIN = 'test-admin-secret-0123456789abcdef'
const worker = (exports as unknown as { default: { fetch(r: Request): Promise<Response> } }).default
export const db = (env as unknown as { DB: D1Database }).DB

export const raw = (path: string, init: RequestInit = {}) => worker.fetch(new Request(`${ORIGIN}${path}`, { redirect: 'manual', ...init }))

type Json = Record<string, any>
export type Reply = { status: number; body: Json; headers: Headers }

const call = async (path: string, method: string, headers: Record<string, string>, body?: unknown): Promise<Reply> => {
  const res = await raw(path, {
    method,
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let parsed: Json = {}
  try { parsed = JSON.parse(text) } catch { parsed = { text } }
  return { status: res.status, body: parsed, headers: res.headers }
}

/** A person with a passkey and a browser session. */
export type Person = {
  name: string
  passkey: Authenticator
  cookie: string
  get(path: string): Promise<Reply>
  post(path: string, body?: unknown): Promise<Reply>
  patch(path: string, body?: unknown): Promise<Reply>
  del(path: string): Promise<Reply>
  send(conv: ConvId, text: string, extra?: Json): Promise<EventId>
  convs(): Promise<ConvSummary[]>
  login(): Promise<void>
}

const person = (name: string): Person => {
  const p: Person = {
    name, passkey: authenticator(ORIGIN), cookie: '',
    get: (path) => call(`/api${path}`, 'GET', { Cookie: p.cookie }),
    post: (path, body = {}) => call(`/api${path}`, 'POST', { Cookie: p.cookie, Origin: ORIGIN }, body),
    patch: (path, body = {}) => call(`/api${path}`, 'PATCH', { Cookie: p.cookie, Origin: ORIGIN }, body),
    del: (path) => call(`/api${path}`, 'DELETE', { Cookie: p.cookie, Origin: ORIGIN }),
    send: async (conv, text, extra = {}) => {
      const id = newEventId()
      const r = await p.post(`/convs/${conv}/messages`, { id, text, ...extra })
      if (r.status !== 201) throw new Error(`send failed: ${JSON.stringify(r.body)}`)
      return id
    },
    convs: async () => (await p.get('/convs')).body as unknown as ConvSummary[],
    login: async () => {
      const o = await p.post('/auth/login/options')
      const v = await p.post('/auth/login/verify', { id: o.body.id, response: await p.passkey.get(o.body.options) })
      if (v.status !== 200) throw new Error(`login failed: ${JSON.stringify(v.body)}`)
      p.cookie = v.headers.get('Set-Cookie')!.split(';')[0]!
    },
  }
  return p
}

export const codeOf = (url: string) => url.split('/j/')[1]!

/** Register a new person through an invitation link and join its conversation. */
export const joinByLink = async (name: string, url: string): Promise<{ who: Person; conv: ConvId }> => {
  const who = person(name)
  const code = codeOf(url)
  const o = await who.post('/auth/register/options', { code })
  if (o.status !== 200) throw new Error(`register options: ${JSON.stringify(o.body)}`)
  const v = await who.post('/auth/register/verify', { id: o.body.id, response: await who.passkey.create(o.body.options) })
  if (v.status !== 200) throw new Error(`register verify: ${JSON.stringify(v.body)}`)
  who.cookie = v.headers.get('Set-Cookie')!.split(';')[0]!
  const joined = await who.post(`/join/${code}/accept`, { handle: name })
  if (joined.status !== 200) throw new Error(`join: ${JSON.stringify(joined.body)}`)
  return { who, conv: joined.body.conv }
}

export const bootstrap = async (topic = 'Bootstrap'): Promise<string> => {
  const r = await call('/admin/bootstrap', 'POST', { Authorization: `Bearer ${ADMIN}` }, { topic })
  return r.body.url as string
}

/** A fresh world: the first person, in the bootstrap conversation. */
export const founder = async (name = 'ann') => joinByLink(name, await bootstrap())

export const invite = async (from: Person, conv: ConvId, name: string) => {
  const link = await from.post(`/convs/${conv}/invites`, { link: true })
  return (await joinByLink(name, link.body.url)).who
}

/** An agent device with a pasted token, speaking MCP. */
export type Agent = { id: string; token: string; tool(name: string, args?: Json): Promise<{ ok: boolean; data: Json }> }

export const agentFor = async (who: Person, opts: { rounds?: boolean; name?: string } = {}): Promise<Agent> => {
  const made = await who.post('/devices/token', { name: opts.name ?? `${who.name}-agent`, rounds: opts.rounds ?? false })
  if (made.status !== 201) throw new Error(`device: ${JSON.stringify(made.body)}`)
  return mcpClient(made.body.id, made.body.token)
}

export const mcpClient = (id: string, token: string): Agent => {
  let n = 0
  return {
    id, token,
    tool: async (name, args = {}) => {
      const r = await call('/mcp', 'POST', { Authorization: `Bearer ${token}`, Accept: 'application/json, text/event-stream' },
        { jsonrpc: '2.0', id: ++n, method: 'tools/call', params: { name, arguments: args } })
      if (r.status !== 200) return { ok: false, data: { status: r.status, ...r.body } }
      if (r.body.error) return { ok: false, data: r.body.error }
      const text = r.body.result?.content?.[0]?.text ?? '{}'
      let data: Json
      try { data = JSON.parse(text) } catch { data = { text } }
      return { ok: !r.body.result?.isError, data }
    },
  }
}

/** Delivery is asynchronous (waitUntil); poll until the predicate holds. */
export const eventually = async <T>(f: () => Promise<T | null | undefined | false>, what = 'condition'): Promise<T> => {
  for (let i = 0; i < 100; i++) {
    const v = await f()
    if (v) return v
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(`timed out waiting for ${what}`)
}

// The single entry point. Routing order:
//   /mcp                      -> OAuth-protected MCP tools (`agent` scope)
//   /oauth/*, /.well-known/*  -> the OAuth provider (tokens, registration, discovery)
//   /authorize                -> the consent page (`human` session)
//   /api/*, /admin/*          -> the human API and the operator endpoints
//   everything else           -> the PWA's static assets

import { Hono } from 'hono'
import { admin, api } from './http/api'
import { authorizeGet, authorizePost, buildProvider, firstPartyClient } from './auth/oauth'
import { directory } from './directory'
import { origin, type Env } from './env'
import { mcpHandler } from './mcp'

export { ConversationDO } from './do/conversation'
export { PrincipalDO } from './do/principal'

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
}

const CSP = [
  `default-src 'self'`, `script-src 'self'`, `style-src 'self' 'unsafe-inline'`, `img-src 'self' data:`,
  `connect-src 'self'`, `frame-ancestors 'none'`, `base-uri 'none'`, `form-action 'self'`, `object-src 'none'`,
].join('; ')

const app = new Hono<{ Bindings: Env }>()
app.route('/', api)
app.route('/', admin)
app.get('/authorize', (c) => authorizeGet(c.req.raw, c.env))
app.post('/authorize', (c) => authorizePost(c.req.raw, c.env))
app.get('/oauth/clients/claude-code.json', (c) => c.json(firstPartyClient(c.env), 200, { 'Cache-Control': 'public, max-age=3600' }))
app.all('*', async (c) => {
  const res = await c.env.ASSETS.fetch(c.req.raw)
  const out = new Response(res.body, res)
  if ((out.headers.get('Content-Type') ?? '').includes('text/html')) {
    out.headers.set('Content-Security-Policy', CSP)
    out.headers.set('Cache-Control', 'no-cache')
  }
  return out
})

const fallback = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const res = await app.fetch(request, env, ctx)
    if (res.status === 101) return res
    const out = new Response(res.body, res)
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!out.headers.has(k)) out.headers.set(k, v)
    return out
  },
}

// The provider needs the public origin, which lives in `env`; build it once per isolate.
let provider: { origin: string; instance: ReturnType<typeof buildProvider> } | null = null
const providerFor = (env: Env) => {
  if (provider?.origin !== origin(env)) provider = { origin: origin(env), instance: buildProvider(env, mcpHandler, fallback) }
  return provider.instance
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return providerFor(env).fetch(request, env, ctx)
  },

  /** Daily housekeeping: expired challenges, sessions, links, devices, and orphaned OAuth records. */
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    const dir = directory(env)
    await dir.purge()
    await dir.expireDevices()
    const cursor = (await env.OAUTH_KV.get('purge-cursor')) ?? undefined
    const result = await providerFor(env).purgeExpiredData(env, { batchSize: 100, cursor })
    if (result.cursor) await env.OAUTH_KV.put('purge-cursor', result.cursor)
    else await env.OAUTH_KV.delete('purge-cursor')
  },
} satisfies ExportedHandler<Env>

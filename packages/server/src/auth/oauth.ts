// OAuth 2.1 authorization server for agents (MCP authorization, 2026-07-28).
//
// The library owns discovery, the token endpoint, client registration (Client
// ID Metadata Documents first, dynamic registration for older clients) and
// token storage. This module owns the one application decision: the consent
// page, shown to a person with a `human` session, which mints an `agent`
// device. The only scope that exists here is `agent`; nothing in this flow can
// produce a `human` session (I6).

import {
  AuthorizationError, CimdFetchError, OAuthProvider, authorizationErrorRedirect,
  type AuthRequest, type ConsentDescription, type OAuthHelpers,
} from '@cloudflare/workers-oauth-provider'
import { newDeviceId, type DeviceId, type PrincipalId } from '@sudare/protocol'
import { directory } from '../directory'
import { csv, origin, type Env } from '../env'
import { sha256 } from '../util'
import { readSession } from './session'

export type AgentProps = { p: PrincipalId; d: DeviceId }

export const AGENT_SCOPE = 'agent'
export const TOKEN_PREFIX = 'sda'
const THIRTY_DAYS = 30 * 86_400
const FIRST_PARTY_CLIENT = '/oauth/clients/claude-code.json'

type Handler = { fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> }

export const buildProvider = (env: Env, api: Handler, fallback: Handler) =>
  new OAuthProvider<Env>({
    apiRoute: '/mcp',
    apiHandler: api as never,
    defaultHandler: fallback as never,
    authorizeEndpoint: '/authorize',
    tokenEndpoint: '/oauth/token',
    clientRegistrationEndpoint: '/oauth/register',
    scopesSupported: [AGENT_SCOPE],
    requiredScopes: [AGENT_SCOPE],
    resourceMetadata: { resource: `${origin(env)}/mcp`, authorization_servers: [origin(env)], resource_name: 'Sudare' },
    clientIdMetadataDocumentEnabled: true,
    accessTokenTTL: 3600,
    refreshTokenTTL: THIRTY_DAYS,
    refreshTokenIdleTTL: THIRTY_DAYS,
    // Tokens a person generated in the PWA and pasted into a headless agent's
    // configuration. Same scope, same device model, no browser needed.
    resolveExternalToken: async ({ token, env }) => {
      if (!token.startsWith(`${TOKEN_PREFIX}_`)) return null
      const device = await directory(env).deviceByToken(await sha256(token))
      if (!device) return null
      return { props: { p: device.principal, d: device.id } satisfies AgentProps, audience: `${origin(env)}/mcp` }
    },
  })

/** The metadata document that is the client id of the first-party Claude Code plugin. */
export const firstPartyClient = (env: Env) => ({
  client_id: `${origin(env)}${FIRST_PARTY_CLIENT}`,
  client_name: 'Sudare for Claude Code',
  client_uri: origin(env),
  redirect_uris: ['http://127.0.0.1/callback', 'http://localhost/callback'],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
})

/**
 * Clients trusted to run a discussion round in a tool-restricted sub-session:
 * our own plugin client, Claude Code (recognised by the verified domain of its
 * client metadata document), and whatever the operator lists by client id or
 * domain. The person can change this per device in Settings.
 */
export const roundCapableByDefault = (env: Env, clientId: string, clientDomain?: string): boolean =>
  [`${origin(env)}${FIRST_PARTY_CLIENT}`, 'claude.ai', ...csv(env.ROUND_CLIENT_IDS)].some((x) => x === clientId || x === clientDomain)

/**
 * Authorization-code phishing: someone sends a person a link to this consent
 * page for a client of theirs. With a loopback redirect the code can only land
 * on the machine of the person who clicked, so a remote attacker gains
 * nothing. Any other redirect target must be explicitly allowed by the operator.
 */
const redirectAllowed = (env: Env, details: ConsentDescription): boolean => {
  if (details.redirectIsLoopback) return true
  try {
    return csv(env.ALLOWED_REDIRECT_ORIGINS).includes(new URL(details.redirectUri).origin)
  } catch {
    return false
  }
}

const esc = (value: string) => value.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`)

const page = (title: string, body: string, headers = new Headers(), status = 200): Response => {
  headers.set('Content-Type', 'text/html; charset=utf-8')
  headers.set('Content-Security-Policy', `default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'`)
  headers.set('Cache-Control', 'no-store')
  headers.set('X-Frame-Options', 'DENY')
  // Not `no-referrer`: under that policy browsers send `Origin: null` on the form's
  // POST navigation, and the same-origin check on the decision would refuse the person.
  headers.set('Referrer-Policy', 'same-origin')
  return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root { color-scheme: light dark; font: 16px/1.5 system-ui, sans-serif; }
  body { max-width: 30rem; margin: 10vh auto; padding: 0 1.25rem; }
  h1 { font-size: 1.25rem; } .muted { opacity: .7; font-size: .9rem; }
  .box { border: 1px solid color-mix(in srgb, currentColor 25%, transparent); border-radius: .5rem; padding: 1rem; margin: 1rem 0; }
  label { display: block; margin: .75rem 0 .25rem; } input[type=text] { width: 100%; box-sizing: border-box; padding: .5rem; font: inherit; }
  button { font: inherit; padding: .55rem 1.1rem; border-radius: .4rem; border: 1px solid currentColor; background: none; color: inherit; cursor: pointer; }
  button.primary { background: #1f4fd8; border-color: #1f4fd8; color: #fff; } .row { display: flex; gap: .75rem; margin-top: 1.25rem; }
  .warn { border-color: #c2410c; } h1 { margin-bottom: .25rem; } form { margin-top: 1.5rem; }
</style><body>${body}</body></html>`, { status, headers })
}

const consentPage = (d: ConsentDescription, handle: string): string => `
<h1>Connect ${esc(d.clientName)}?</h1>
<p>It can read what you hand to it and write drafts. Nothing is sent until you approve it.</p>
<form method="post" action="/authorize">
  <input type="hidden" name="handle" value="${esc(handle)}">
  <label for="name">Name this device</label>
  <input id="name" type="text" name="name" maxlength="60" value="${esc(d.clientName.slice(0, 60))}">
  <div class="row">
    <button class="primary" name="decision" value="approve">Allow</button>
    <button name="decision" value="deny">Cancel</button>
  </div>
</form>
<p class="muted">${d.clientDomain ? `Verified: ${esc(d.clientDomain)}` : 'Unverified app'} · on ${d.redirectIsLoopback ? 'this computer' : esc(d.redirectHost)}</p>`

const failure = (error: unknown): Response => {
  if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302)
  if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
    const message = error instanceof AuthorizationError ? error.description : 'This app could not be verified.'
    return page('Cannot authorize', `<h1>Cannot authorize</h1><p>${esc(message ?? 'The request is not valid.')}</p><p class="muted">Start connecting again from your agent.</p>`, new Headers(), 400)
  }
  throw error
}

const sameOrigin = (env: Env, request: Request): boolean => request.headers.get('Origin') === origin(env)

/** GET /authorize: sign-in if needed, then the consent page. */
export const authorizeGet = async (request: Request, env: Env): Promise<Response> => {
  const oauth: OAuthHelpers = env.OAUTH_PROVIDER
  try {
    const auth: AuthRequest = await oauth.parseAuthRequest(request)
    const details = await oauth.describeConsent(auth)
    if (!redirectAllowed(env, details)) {
      return page('Cannot authorize', `<div class="box warn"><h1>Blocked</h1><p>This app wants access sent to <strong>${esc(details.redirectHost)}</strong>, which is not an app on this computer and is not on this server's allow list.</p></div>`, new Headers(), 400)
    }
    const session = await readSession(env, request)
    if (!session || session.kind !== 'web') {
      const url = new URL(request.url)
      return Response.redirect(`${origin(env)}/login?next=${encodeURIComponent(url.pathname + url.search)}`, 302)
    }
    const consent = await oauth.beginConsent(auth)
    return page(`Authorize ${details.clientName}`, consentPage(details, consent.handle), consent.headers)
  } catch (error) {
    return failure(error)
  }
}

/** POST /authorize: the person's decision. Allow creates the device and its grant. */
export const authorizePost = async (request: Request, env: Env): Promise<Response> => {
  const oauth: OAuthHelpers = env.OAUTH_PROVIDER
  const session = await readSession(env, request)
  if (!session || session.kind !== 'web' || !sameOrigin(env, request)) return new Response('forbidden', { status: 403 })
  try {
    const form = await request.formData()
    const handle = String(form.get('handle') ?? '')
    if (form.get('decision') !== 'approve') {
      const denied = await oauth.denyConsent(request, handle)
      denied.headers.set('Location', denied.redirectTo)
      return new Response(null, { status: 302, headers: denied.headers })
    }
    const approved = await oauth.approveConsent(request, handle, { scope: [AGENT_SCOPE] })
    const details = await oauth.describeConsent(approved.request)
    if (!redirectAllowed(env, details)) {
      return Response.redirect(authorizationErrorRedirect(approved.request, 'access_denied'), 302)
    }
    const device = newDeviceId()
    const name = String(form.get('name') ?? '').trim().slice(0, 60) || details.clientName.slice(0, 60)
    await directory(env).createDevice({
      id: device, principal: session.principal, kind: 'oauth', name, client_id: approved.request.clientId,
      client_name: details.clientName.slice(0, 120), rounds: roundCapableByDefault(env, approved.request.clientId, details.clientDomain) ? 1 : 0, token_hash: null,
      created_at: Date.now(), expires_at: Date.now() + THIRTY_DAYS * 1000,
    })
    const { redirectTo } = await oauth.completeAuthorization({
      request: approved.request,
      userId: session.principal,
      metadata: { device },
      scope: [AGENT_SCOPE],
      props: { p: session.principal, d: device } satisfies AgentProps,
      revokeExistingGrants: false, // one grant per device; devices are revoked individually
    })
    approved.headers.set('Location', redirectTo)
    return new Response(null, { status: 302, headers: approved.headers })
  } catch (error) {
    return failure(error)
  }
}

/** Revoking a device removes its grant and every token issued under it. */
export const revokeGrants = async (env: Env, principal: PrincipalId, device: DeviceId): Promise<void> => {
  const oauth: OAuthHelpers = env.OAUTH_PROVIDER
  let cursor: string | undefined
  do {
    const page = await oauth.listUserGrants(principal, { cursor })
    for (const g of page.items) {
      if ((g.metadata as { device?: string } | null)?.device === device) await oauth.revokeGrant(g.id, principal)
    }
    cursor = page.cursor
  } while (cursor)
}
